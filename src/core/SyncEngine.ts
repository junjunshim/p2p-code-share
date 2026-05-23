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

    private remoteCursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteSelectionDecorations = new Map<string, vscode.TextEditorDecorationType>();

    constructor(private hub: HubManager, private context: vscode.ExtensionContext, private updateUI: (state: any) => void) {
        this.setupHandlers();
        this.setupTextListeners();
        this.setupSelectionListeners();
    }

    public setupHandlers() {
        this.hub.onDidReceiveData = async (text) => {
            try {
                const msg = JSON.parse(text) as P2PMessage;
                switch (msg.type) {
                    case 'SET_ROLE': this.handleSetRole(msg); break;
                    case 'ON_CONNECTED': 
                        this.isConnected = true;
                        this.isSetupMode = false;
                        if (!this.isHost) this.sendMessage('GUEST_JOIN', { name: this.myName }); 
                        this.pushUIUpdate();
                        break;
                    case 'INIT_SNAPSHOT': 
                        if (!this.isStorageInitialized) this.initializeStorage();
                        await this.handleGuestInit(msg); 
                        break;
                    case 'SYNC_FULL': await this.forceUpdateEditor(msg.fileName, msg.content); break;
                    case 'GUEST_JOIN': this.handleGuestJoin(msg); break;
                    case 'GUEST_RENAME':
                        if (this.isHost) {
                            this.participants['guest'] = msg.newName;
                            this.broadcastUserList();
                        }
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'GUEST_EDIT': if (this.isHost) { await this.handleGuestEdit(msg); } break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastAll(); break;
                    case 'STOP_SHARING': await this.handleRemoteStop(msg.fileName); break;
                    case 'CURSOR_UPDATE': this.updateRemoteCursor(msg); break;
                }
            } catch (e) {}
        };
    }

    private setupSelectionListeners() {
        vscode.window.onDidChangeTextEditorSelection(e => {
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

    private updateRemoteCursor(msg: any) {
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) return;
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file.path);
        if (!editor) return;

        const prevCursor = this.remoteCursorDecorations.get(msg.userId);
        if (prevCursor) prevCursor.dispose();
        const prevSelection = this.remoteSelectionDecorations.get(msg.userId);
        if (prevSelection) prevSelection.dispose();

        const color = msg.userId === 'host' ? '#f44336' : '#4ec9b0'; 

        const cursorDeco = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px',
            borderStyle: 'solid',
            borderColor: color,
            after: {
                contentText: msg.userName,
                backgroundColor: color,
                color: 'white',
                margin: '1.4em 0 0 0',
                fontWeight: 'bold',
                textDecoration: `none; font-size: 12px; padding: 2px 6px; border-radius: 4px; position: absolute; z-index: 100; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3);`
            }
        });

        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        this.remoteCursorDecorations.set(msg.userId, cursorDeco);
        this.remoteSelectionDecorations.set(msg.userId, selectionDeco);

        const cursorRange = [new vscode.Range(new vscode.Position(msg.cursorPos[0], msg.cursorPos[1]), new vscode.Position(msg.cursorPos[0], msg.cursorPos[1]))];
        const selectionRange = [new vscode.Range(new vscode.Position(msg.selectionRange[0], msg.selectionRange[1]), new vscode.Position(msg.selectionRange[2], msg.selectionRange[3]))];

        editor.setDecorations(cursorDeco, cursorRange);
        editor.setDecorations(selectionDeco, selectionRange);
    }

    public handleSetRole(msg: any) {
        this.isHost = msg.isHost;
        this.myId = this.isHost ? 'host' : 'guest';
        this.roomName = msg.roomName || 'Untitled Room';
        this.myName = this.isHost ? 'Host' : 'Guest1';
        this.initialName = this.myName;
        this.isSetupMode = true; 
        if (this.isHost) { this.initializeStorage(); this.participants['host'] = this.myName; } 
        else this.startPolling();
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
        if (msg.roomName) this.roomName = msg.roomName;
        if (!this.isHost && !this.isStorageInitialized && this.roomName) this.initializeStorage();
        const myKey = this.isHost ? 'host' : 'guest';
        if (this.participants[myKey]) this.myName = this.participants[myKey];
        this.pushUIUpdate();
    }

    private async handleGuestEdit(msg: any) {
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (file) {
            await this.forceUpdateEditor(msg.fileName, msg.content, file.path);
            this.broadcastFullContent(file.name, file.path);
        }
    }

    private handleGuestJoin(msg: any) {
        if (this.isHost) { this.participants['guest'] = msg.name; this.broadcastUserList(); this.broadcastAll(); }
    }

    private setupTextListeners() {
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange) return;
            const file = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!file) return;
            const text = e.document.getText();
            if (text === this.lastRemoteContentMap.get(file.name)) return;
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
        this.storagePath = path.join(this.context.globalStorageUri.fsPath, sanitizePath(this.roomName), sanitizePath(this.initialName));
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
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
        await vscode.workspace.applyEdit(edit);
        setTimeout(() => { this.isApplyingRemoteChange = false; }, 50);
    }

    // [수정] 특정 URI를 받아 공유할 수 있도록 개선
    public async shareActiveFile(targetUri?: vscode.Uri) {
        if (!this.isHost || !this.isStorageInitialized) return;
        
        let sourcePath: string;
        let document: vscode.TextDocument;

        if (targetUri) {
            sourcePath = targetUri.fsPath;
            document = await vscode.workspace.openTextDocument(targetUri);
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            sourcePath = editor.document.uri.fsPath;
            document = editor.document;
        }

        const fileName = path.basename(sourcePath);
        if (this.sharedFiles.find(f => f.source === sourcePath)) {
            vscode.window.showInformationMessage(`"${fileName}" is already shared.`);
            return;
        }

        const snapshotPath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(snapshotPath, document.getText());
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        
        this.sendMessage('INIT_SNAPSHOT', { fileName, content: document.getText() });
        this.addSharedFile(fileName, snapshotPath, sourcePath);
    }

    public changeMyName(newName: string) {
        if (this.isHost) { this.myName = newName; this.participants['host'] = newName; this.broadcastUserList(); }
        else this.sendMessage('GUEST_RENAME', { newName });
    }

    private broadcastUserList() {
        if (this.isHost) this.sendMessage('USER_LIST_UPDATE', { users: this.participants, roomName: this.roomName });
        this.pushUIUpdate();
    }

    private broadcastAll() { this.sharedFiles.forEach(f => this.broadcastFullContent(f.name, f.path)); }

    private broadcastFullContent(fileName: string, filePath: string) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const content = doc ? doc.getText() : fs.readFileSync(filePath, 'utf8');
        this.sendMessage('SYNC_FULL', { fileName, content });
    }

    private sendMessage(type: string, data: any) { this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }); }

    private addSharedFile(name: string, filePath: string, source?: string) {
        if (!this.sharedFiles.find(f => f.path === filePath)) this.sharedFiles.push({ name, path: filePath, source });
        this.pushUIUpdate();
    }

    public async stopSharing() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
        if (file) await this.stopSharingByName(file.name);
    }

    // [신규] 이름으로 특정 파일 공유 중지
    public async stopSharingByName(fileName: string) {
        if (!this.isHost) return;
        
        // [수정] 네이티브 확인창 사용
        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to stop sharing "${fileName}"?`,
            { modal: true },
            "Stop"
        );

        if (answer !== "Stop") return;

        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file && file.source) {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
            if (doc) {
                await doc.save();
                fs.writeFileSync(file.source, doc.getText());
            }
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
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const targetTab = tabs.find(t => (t.input as any).uri?.fsPath === file.path);
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
    }

    public reset() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.stopAll();
        this.isHost = false;
        this.isConnected = false;
        this.roomName = '';
        this.myName = '';
        this.initialName = '';
        this.participants = {};
        this.isSetupMode = false;
        this.isStorageInitialized = false;
        this.lastRemoteContentMap.clear();
        this.pushUIUpdate();
    }

    private startPolling() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.pollingTimer = setInterval(() => { if (!this.isHost && this.sharedFiles.length > 0) this.sendMessage('REQUEST_FULL_SYNC', {}); }, 5000);
    }

    public pushUIUpdate() { 
        this.updateUI({ type: 'renderParticipants', myName: this.myName, others: this.participants, roomName: this.roomName, files: this.sharedFiles, isSetupMode: this.isSetupMode, isConnected: this.isConnected });
    }
}
