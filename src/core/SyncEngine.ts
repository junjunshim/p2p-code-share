import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HubManager } from './HubManager';
import { SharedFile, P2PMessage } from '../types';
import { sanitizePath, ensureDirectory } from '../utils/helpers';

export class SyncEngine {
    private isApplyingRemoteChange = false;
    public isHost = false; 
    private storagePath = '';
    private sharedFiles: SharedFile[] = [];
    private myName = '';
    private myId = ''; 
    private initialName = '';
    private participants: { [key: string]: string } = {};
    private lastRemoteContentMap = new Map<string, string>();
    private pollingTimer?: NodeJS.Timeout;
    public roomName = ''; 
    private isStorageInitialized = false;
    public isSetupMode = false; 
    public isConnected = false; 
    private pendingInvites = new Set<string>();

    private remoteCursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteSelectionDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private userColorMap = new Map<string, string>();
    private colorPalette = ['#4ec9b0', '#ffeb3b', '#2196f3', '#9c27b0', '#ff9800', '#00bcd4', '#8bc34a'];

    constructor(private hub: HubManager, private context: vscode.ExtensionContext, private updateUI: (state: any) => void) {
        this.setupHandlers();
        this.setupTextListeners();
        this.setupSelectionListeners();
    }

    public setupHandlers() {
        this.hub.onDidReceiveData = async (text, peerId) => {
            console.log(`[P2P DEBUG] Received data from peer: ${peerId}`);
            try {
                const msg = JSON.parse(text) as P2PMessage;
                switch (msg.type) {
                    case 'SET_ROLE': this.handleSetRole(msg); break;
                    case 'ON_CONNECTED': 
                        console.log(`[P2P DEBUG] ON_CONNECTED received for peer: ${peerId}`);
                        if (this.isHost) {
                            if (this.pendingInvites.has(peerId)) {
                                this.isSetupMode = false;
                                this.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
                                this.pendingInvites.delete(peerId);
                            }
                        } else {
                            this.isConnected = true;
                            this.isSetupMode = false;
                        }
                        this.pushUIUpdate();
                        break;
                    case 'ASSIGN_PEER_ID':
                        if (!this.isHost) {
                            console.log(`[P2P DEBUG] ASSIGN_PEER_ID received: ${msg.peerId}`);
                            const oldId = this.myId || 'default';
                            this.myId = msg.peerId;
                            this.myName = msg.peerId; 
                            this.initialName = this.myId; 
                            this.isStorageInitialized = false; 
                            this.initializeStorage(); 
                            
                            // Webview에게 피어 ID 갱신 알림
                            this.sendMessage('updatePeerId', { oldId, newId: this.myId });
                            
                            this.sendMessage('GUEST_JOIN', { name: this.myName }); 
                            this.pushUIUpdate();
                        }
                        break;
                    case 'INIT_SNAPSHOT': 
                        if (!this.isStorageInitialized) this.initializeStorage();
                        await this.handleGuestInit(msg); 
                        break;
                    case 'SYNC_FULL': await this.forceUpdateEditor(msg.fileName, msg.content); break;
                    case 'GUEST_JOIN': 
                        console.log(`[P2P DEBUG] GUEST_JOIN from peer: ${peerId}, name: ${msg.name}`);
                        this.handleGuestJoin(msg, peerId); break;
                    case 'GUEST_RENAME':
                        if (this.isHost) { this.participants[peerId] = msg.newName; this.broadcastUserList(); }
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'GUEST_EDIT': if (this.isHost) { await this.handleGuestEdit(msg); } break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastAll(); break;
                    case 'STOP_SHARING': await this.handleRemoteStop(msg.fileName); break;
                    case 'CURSOR_UPDATE': 
                        // [핵심] 호스트를 거쳐 중계된 경우 msg.value에 userId가 포함되어 있음.
                        // msg는 이미 JSON.parse된 값임. 이 경우 msg.value가 CURSOR_UPDATE 페이로드임.
                        const senderId = msg.userId || peerId; 
                        this.updateRemoteCursor(msg, senderId); 
                        if (this.isHost) this.broadcastCursor(msg, senderId);
                        break;
                }
            } catch (e) {}
        };
    }

    private broadcastCursor(msg: any, senderId: string) {
        // 호스트가 받은 커서 정보를 다른 모든 피어에게 전달
        this.hub.sendToEngine({ type: 'peerData', value: { type: 'CURSOR_UPDATE', ...msg } });
    }

    private getUserColor(peerId: string): string {
        if (peerId === 'host' || (!this.isHost && peerId === 'default')) return '#f44336';
        if (!this.userColorMap.has(peerId)) {
            const color = this.colorPalette[this.userColorMap.size % this.colorPalette.length];
            this.userColorMap.set(peerId, color);
        }
        return this.userColorMap.get(peerId)!;
    }

    private setupSelectionListeners() {
        vscode.window.onDidChangeTextEditorSelection(e => {
            // [핵심] myId가 정상적으로 할당된 경우에만 전송
            if (!this.myId || this.myId === 'default' || this.myId === '') return;

            const file = this.sharedFiles.find(f => f.path === e.textEditor.document.uri.fsPath);
            if (!file) return;
            const selection = e.selections[0];
            this.sendMessage('CURSOR_UPDATE', {
                fileName: file.name,
                userId: this.myId,
                userName: this.myName,
                cursorPos: [selection.active.line, selection.active.character],
                selectionRange: [selection.start.line, selection.start.character, selection.end.line, selection.end.character]
            });
        });
    }

    private updateRemoteCursor(msg: any, peerId: string) {
        // [핵심] 호스트를 거쳐서 온 경우, 실제 원작자의 peerId는 msg.userId에 담겨있음
        const actualPeerId = msg.userId || peerId; 
        
        // 내 자신의 커서 업데이트라면 렌더링하지 않음
        if (actualPeerId === this.myId) return;
        
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) return;
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file.path);
        if (!editor) return;
        
        const prevCursor = this.remoteCursorDecorations.get(actualPeerId);
        if (prevCursor) prevCursor.dispose();
        const prevSelection = this.remoteSelectionDecorations.get(actualPeerId);
        if (prevSelection) prevSelection.dispose();
        
        const color = this.getUserColor(actualPeerId); 
        const cursorDeco = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: color,
            after: {
                contentText: msg.userName, backgroundColor: color, color: 'white', margin: '1.4em 0 0 0', fontWeight: 'bold',
                textDecoration: `none; font-size: 12px; padding: 2px 6px; border-radius: 4px; position: absolute; z-index: 100; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3);`
            }
        });
        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        this.remoteCursorDecorations.set(actualPeerId, cursorDeco);
        this.remoteSelectionDecorations.set(actualPeerId, selectionDeco);
        
        const cursorRange = [new vscode.Range(new vscode.Position(msg.cursorPos[0], msg.cursorPos[1]), new vscode.Position(msg.cursorPos[0], msg.cursorPos[1]))];
        const selectionRange = [new vscode.Range(new vscode.Position(msg.selectionRange[0], msg.selectionRange[1]), new vscode.Position(msg.selectionRange[2], msg.selectionRange[3]))];
        editor.setDecorations(cursorDeco, cursorRange);
        editor.setDecorations(selectionDeco, selectionRange);
    }

    public handleSetRole(msg: any) {
        this.isHost = msg.isHost;
        this.myId = this.isHost ? 'host' : '';
        this.roomName = msg.roomName || 'Untitled Room';
        this.myName = this.isHost ? 'Host' : '';
        this.initialName = this.myName;

        if (this.isHost) { 
            this.isConnected = true; this.isSetupMode = false;
            this.initializeStorage(); 
            this.participants['host'] = this.myName; 
            this.hub.createHub(true, 'none'); 
        } else { 
            this.isSetupMode = true; 
            this.startPolling(); 
            this.hub.createHub(false, 'default'); 
        }
        this.pushUIUpdate();
    }

    public inviteGuest() {
        if (!this.isHost) return;
        const newPeerId = 'guest_' + Date.now();
        this.pendingInvites.add(newPeerId);
        this.isSetupMode = true; 
        this.hub.createHub(true, newPeerId); 
        this.pushUIUpdate();
    }

    private async handleGuestInit(msg: any) {
        this.isHost = false;
        const snapshotPath = path.join(this.storagePath, msg.fileName + '.shared');
        fs.writeFileSync(snapshotPath, msg.content);
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.addSharedFile(msg.fileName, snapshotPath);
    }

    private handleUserListUpdate(msg: any) {
        this.participants = msg.users;
        if (msg.roomName && (this.roomName === '' || this.roomName === 'Untitled Room')) {
            this.roomName = msg.roomName;
            if (!this.isHost) {
                this.isStorageInitialized = false;
                this.initializeStorage();
            }
        }
        if (!this.isHost && !this.isStorageInitialized && this.roomName) this.initializeStorage();
        
        // 내 이름을 덮어쓰지 않고 myId(peerId)가 있을 때만 명단에서 업데이트하도록 변경
        if (!this.isHost && this.myId) {
            if (this.participants[this.myId]) {
                this.myName = this.participants[this.myId];
            } else if (this.participants['default']) {
                this.myName = this.participants['default'];
            }
        }
        
        this.pushUIUpdate();
    }

    private async handleGuestEdit(msg: any) {
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (file) { await this.forceUpdateEditor(msg.fileName, msg.content, file.path); this.broadcastFullContent(file.name, file.path); }
    }

    private handleGuestJoin(msg: any, peerId: string) {
        if (this.isHost) { this.participants[peerId] = msg.name; this.broadcastUserList(); this.broadcastAll(); }
    }
private setupTextListeners() {
    vscode.workspace.onDidChangeTextDocument(e => {
        if (this.isApplyingRemoteChange) return;
        const file = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
        if (!file) return;

        // [핵심] 실제 사용자의 타이핑인지 확인: 변경사항의 reason이 정의되지 않았거나(수동 입력) 
        // 프로그램에 의한 변경이 아님을 확인
        const isManualChange = e.contentChanges.length > 0;
        if (!isManualChange) return;

        const text = e.document.getText();
        if (text === this.lastRemoteContentMap.get(file.name)) return;

        this.lastRemoteContentMap.set(file.name, text);
        this.sendMessage(this.isHost ? 'SYNC_FULL' : 'GUEST_EDIT', { fileName: file.name, content: text });
    });
    vscode.workspace.onWillSaveTextDocument(e => {
        if (!this.isHost && this.sharedFiles.some(f => f.path === e.document.uri.fsPath)) {
            vscode.window.setStatusBarMessage("P2P: Changes synced to Host.", 3000);
        }
    });
}
    private initializeStorage() {
        if (this.isStorageInitialized) return;
        if (!this.isHost && (!this.myId || this.myId === 'default' || !this.roomName || this.roomName === 'Untitled Room')) return;

        // 동일한 기기 내 다중 인스턴스 충돌 방지를 위해 myId를 경로에 포함
        const folderName = this.isHost ? 'host' : this.myId;
        this.storagePath = path.join(this.context.globalStorageUri.fsPath, sanitizePath(this.roomName), sanitizePath(folderName));
        ensureDirectory(this.storagePath);
        this.isStorageInitialized = true;
    }

    private async forceUpdateEditor(fileName: string, content: string, specificPath?: string) {
        const filePath = specificPath || this.sharedFiles.find(f => f.name === fileName)?.path;
        if (!filePath) return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (!doc) { fs.writeFileSync(filePath, content); return; }
        if (doc.getText() === content) return;

        this.lastRemoteContentMap.set(fileName, content);
        this.isApplyingRemoteChange = true;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
            await vscode.workspace.applyEdit(edit);
        } finally {
            setTimeout(() => { this.isApplyingRemoteChange = false; }, 100);
        }
    }

    public async shareActiveFile(targetUri?: vscode.Uri) {
        if (!this.isHost || !this.isStorageInitialized) return;
        let sourcePath: string; let document: vscode.TextDocument;
        if (targetUri) { sourcePath = targetUri.fsPath; document = await vscode.workspace.openTextDocument(targetUri); } 
        else { const editor = vscode.window.activeTextEditor; if (!editor) return; sourcePath = editor.document.uri.fsPath; document = editor.document; }
        const fileName = path.basename(sourcePath);
        if (this.sharedFiles.find(f => f.source === sourcePath)) return;
        const snapshotPath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(snapshotPath, document.getText());
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.sendMessage('INIT_SNAPSHOT', { fileName, content: document.getText() });
        this.addSharedFile(fileName, snapshotPath, sourcePath);
    }

    public changeMyName(newName: string) {
        if (this.isHost) { 
            this.myName = newName; 
            this.participants['host'] = newName; 
            this.broadcastUserList(); 
        } else { 
            this.myName = newName;
            this.sendMessage('GUEST_RENAME', { newName }); 
        }

        // 이름 변경 즉시 커서 정보도 최신 이름으로 브로드캐스트
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                const selection = editor.selection;
                this.sendMessage('CURSOR_UPDATE', {
                    fileName: file.name,
                    userId: this.myId,
                    userName: this.myName,
                    cursorPos: [selection.active.line, selection.active.character],
                    selectionRange: [selection.start.line, selection.start.character, selection.end.line, selection.end.character]
                });
            }
        }
        this.pushUIUpdate();
    }

    private broadcastUserList() {
        if (this.isHost) {
            const filteredParticipants = { ...this.participants };
            delete filteredParticipants['default'];
            this.sendMessage('USER_LIST_UPDATE', { users: filteredParticipants, roomName: this.roomName });
        }
        this.pushUIUpdate();
    }

    private broadcastAll() { this.sharedFiles.forEach(f => this.broadcastFullContent(f.name, f.path)); }

    private broadcastFullContent(fileName: string, filePath: string) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const content = doc ? doc.getText() : fs.readFileSync(filePath, 'utf8');
        this.sendMessage('SYNC_FULL', { fileName, content });
    }

    private sendMessage(type: string, data: any) { this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }); }

    private sendMessageToPeer(peerId: string, type: string, data: any) { this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }, peerId); }

    private addSharedFile(name: string, filePath: string, source?: string) {
        if (!this.sharedFiles.find(f => f.path === filePath)) this.sharedFiles.push({ name, path: filePath, source });
        this.pushUIUpdate();
    }

    public async stopSharing() {
        const editor = vscode.window.activeTextEditor; if (!editor) return;
        const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
        if (file) await this.stopSharingByName(file.name);
    }

    public async stopSharingByName(fileName: string) {
        if (!this.isHost) return;
        const answer = await vscode.window.showWarningMessage(`Are you sure you want to stop sharing "${fileName}"?`, { modal: true }, "Stop");
        if (answer !== "Stop") return;
        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file && file.source) {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
            if (doc) { await doc.save(); fs.writeFileSync(file.source, doc.getText()); }
            this.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
        }
    }

    private async handleRemoteStop(fileName: string) {
        const index = this.sharedFiles.findIndex(f => f.name === fileName);
        if (index === -1) return;
        const file = this.sharedFiles[index];
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
        if (doc) {
            if (!this.isHost) await doc.save();
            const targetTab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => (t.input as any).uri?.fsPath === file.path);
            if (targetTab) await vscode.window.tabGroups.close(targetTab);
        }
        if (fs.existsSync(file.path)) try { fs.unlinkSync(file.path); } catch(e) {}
        this.sharedFiles.splice(index, 1);
        this.lastRemoteContentMap.delete(fileName);
        this.pushUIUpdate();
    }

    public stopAll() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.sharedFiles.forEach(f => this.handleRemoteStop(f.name));
        this.remoteCursorDecorations.forEach(d => d.dispose());
        this.remoteCursorDecorations.clear();
        this.remoteSelectionDecorations.forEach(d => d.dispose());
        this.remoteSelectionDecorations.clear();
        this.userColorMap.clear();
    }

    public handlePeerDisconnect(peerId: string) {
        if (!this.isHost) {
            if (peerId === 'default' || peerId === 'all') { vscode.window.showErrorMessage("Connection to Host lost."); this.reset(); }
        } else {
            const disconnectedName = this.participants[peerId] || 'Someone';
            vscode.window.setStatusBarMessage(`P2P: ${disconnectedName} has left the room.`, 3000);
            delete this.participants[peerId];
            const deco = this.remoteCursorDecorations.get(peerId); if (deco) deco.dispose(); this.remoteCursorDecorations.delete(peerId);
            const selDeco = this.remoteSelectionDecorations.get(peerId); if (selDeco) selDeco.dispose(); this.remoteSelectionDecorations.delete(peerId);
            this.userColorMap.delete(peerId); this.pushUIUpdate(); this.broadcastUserList();
        }
    }

    public reset() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.stopAll();
        this.isHost = false; this.isConnected = false; this.roomName = ''; this.myName = ''; this.myId = ''; this.initialName = ''; this.participants = {}; this.isSetupMode = false; this.isStorageInitialized = false; this.lastRemoteContentMap.clear();
        this.pushUIUpdate();
    }

    private startPolling() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.pollingTimer = setInterval(() => { if (!this.isHost && this.sharedFiles.length > 0) this.sendMessage('REQUEST_FULL_SYNC', {}); }, 5000);
    }

    public pushUIUpdate() { 
        this.updateUI({ 
            type: 'renderParticipants', 
            myName: this.myName, 
            myId: this.myId, 
            others: this.participants, 
            roomName: this.roomName, 
            files: this.sharedFiles, 
            isSetupMode: this.isSetupMode, 
            isConnected: this.isConnected,
            // [핵심] 현재 초대 중인 아이디 목록을 UI로 전달
            pendingInvites: Array.from(this.pendingInvites)
        });
    }
}
