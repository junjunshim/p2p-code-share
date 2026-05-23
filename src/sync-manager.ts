import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class SyncManager {
    private isApplyingRemoteChange: boolean = false;
    private isHost: boolean = false;
    private storagePath: string = '';
    private sharedFiles: { name: string, path: string, source?: string }[] = [];
    private myName: string = '';
    private initialName: string = ''; 
    private participants: { [key: string]: string } = {}; 
    private lastRemoteContentMap: Map<string, string> = new Map();
    private pollingTimer: NodeJS.Timeout | undefined;
    private roomName: string = '';
    private isStorageInitialized: boolean = false;

    constructor(private provider: any, private context: vscode.ExtensionContext) {
        this.provider.onDidReceiveData = async (text: string) => {
            try {
                const msg = JSON.parse(text);
                if (msg.type === 'SET_ROLE') {
                    this.isHost = msg.isHost;
                    this.roomName = msg.roomName || 'Untitled Room';
                    this.myName = this.isHost ? 'Host' : 'Guest1';
                    this.initialName = this.myName;
                    if (this.isHost) { this.initializeStorage(); this.participants['host'] = this.myName; this.broadcastUserList(); }
                    else this.startPolling();
                    this.updateSidebarUI();
                    return;
                }

                if (msg.type === 'ON_CONNECTED') {
                    if (!this.isHost) this.sendControlMessage('GUEST_JOIN', { name: this.myName });
                    return;
                }

                switch (msg.type) {
                    case 'INIT_SNAPSHOT': 
                        if (!this.isStorageInitialized) this.initializeStorage();
                        await this.handleGuestInit(msg); 
                        break;
                    case 'SYNC_FULL': 
                        await this.forceUpdateEditor(msg.fileName, msg.content);
                        break;
                    case 'STOP_SHARING': await this.handleStopSharing(msg.fileName); break;
                    case 'REQUEST_FULL_SYNC': 
                        if (this.isHost) this.sharedFiles.forEach(f => this.broadcastFullContent(f.name, f.path));
                        break;
                    case 'GUEST_JOIN':
                        if (this.isHost) {
                            this.participants['guest'] = msg.name;
                            this.broadcastUserList();
                            this.sharedFiles.forEach(f => this.broadcastFullContent(f.name, f.path));
                        }
                        break;
                    case 'USER_LIST_UPDATE':
                        this.participants = msg.users;
                        if (msg.roomName) this.roomName = msg.roomName;
                        this.updateSidebarUI();
                        break;
                    case 'GUEST_EDIT':
                        if (this.isHost) {
                            const file = this.sharedFiles.find(f => f.name === msg.fileName);
                            if (file) {
                                await this.forceUpdateEditor(msg.fileName, msg.content, file.path);
                                this.broadcastFullContent(file.name, file.path);
                            }
                        }
                        break;
                }
            } catch (e) {}
        };

        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange) return;
            const sharedFile = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!sharedFile) return;

            const currentText = e.document.getText();
            if (currentText === this.lastRemoteContentMap.get(sharedFile.name)) return;

            if (this.isHost) this.sendControlMessage('SYNC_FULL', { fileName: sharedFile.name, content: currentText });
            else this.sendControlMessage('GUEST_EDIT', { fileName: sharedFile.name, content: currentText });
        });

        // [개선] 게스트 저장 시도 시 안내 메시지 (멀티 파일 대응)
        vscode.workspace.onWillSaveTextDocument(e => {
            const isShared = this.sharedFiles.some(f => f.path === e.document.uri.fsPath);
            if (!this.isHost && isShared) {
                vscode.window.setStatusBarMessage("P2P: Guest changes are synced to Host automatically.", 3000);
            }
        });
    }

    private initializeStorage() {
        if (this.isStorageInitialized) return;
        const safeRoom = this.roomName.replace(/[\\/:*?"<>|]/g, '_');
        const safeName = this.initialName.replace(/[\\/:*?"<>|]/g, '_');
        this.storagePath = path.join(this.context.globalStorageUri.fsPath, safeRoom, safeName);
        if (!fs.existsSync(this.storagePath)) fs.mkdirSync(this.storagePath, { recursive: true });
        this.isStorageInitialized = true;
    }

    private async forceUpdateEditor(fileName: string, content: string, specificPath?: string) {
        const targetFile = this.sharedFiles.find(f => f.name === fileName);
        const filePath = specificPath || targetFile?.path;
        if (!filePath) return;

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (!doc) {
            fs.writeFileSync(filePath, content);
            return;
        }

        if (doc.getText() === content) return;

        this.lastRemoteContentMap.set(fileName, content);
        this.isApplyingRemoteChange = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
        try { await vscode.workspace.applyEdit(edit); } finally { setTimeout(() => { this.isApplyingRemoteChange = false; }, 50); }
    }

    public async shareActiveFile() {
        if (!this.isHost) return;
        this.initializeStorage();
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const sourcePath = editor.document.uri.fsPath;
        const fileName = path.basename(sourcePath);
        if (this.sharedFiles.find(f => f.source === sourcePath)) return;

        const snapshotPath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(snapshotPath, editor.document.getText());
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.sendControlMessage('INIT_SNAPSHOT', { fileName, content: editor.document.getText() });
        this.addSharedFile(fileName, snapshotPath, sourcePath);
    }

    private async handleGuestInit(msg: any) {
        this.isHost = false;
        const snapshotPath = path.join(this.storagePath, msg.fileName + '.shared');
        fs.writeFileSync(snapshotPath, msg.content);
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.addSharedFile(msg.fileName, snapshotPath);
    }

    public changeMyName(newName: string) {
        if (this.isHost) { this.myName = newName; this.participants['host'] = newName; this.broadcastUserList(); }
        else { this.sendControlMessage('GUEST_RENAME', { newName }); }
    }

    private startPolling() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.pollingTimer = setInterval(() => { if (!this.isHost && this.sharedFiles.length > 0) this.sendControlMessage('REQUEST_FULL_SYNC', {}); }, 5000);
    }

    private broadcastFullContent(fileName: string, filePath: string) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const content = doc ? doc.getText() : fs.readFileSync(filePath, 'utf8');
        this.sendControlMessage('SYNC_FULL', { fileName, content });
    }

    private sendControlMessage(type: string, data: any) { this.provider.sendToWebview({ type: 'peerData', value: { type, ...data } }); }

    private broadcastUserList() {
        if (this.isHost) { this.sendControlMessage('USER_LIST_UPDATE', { users: this.participants, roomName: this.roomName }); this.updateSidebarUI(); }
    }

    private updateSidebarUI() {
        this.provider.sendToWebview({ type: 'renderParticipants', myName: this.myName, others: this.participants, roomName: this.roomName });
    }

    private addSharedFile(name: string, filePath: string, source?: string) {
        if (!this.sharedFiles.find(f => f.path === filePath)) { this.sharedFiles.push({ name, path: filePath, source }); }
        this.provider.sendToWebview({ type: 'updateFileList', files: this.sharedFiles });
    }

    // [핵심 수정] 종료 전 저장 로직 강화
    public async stopSharing() {
        if (!this.isHost) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        
        const currentPath = editor.document.uri.fsPath;
        const file = this.sharedFiles.find(f => f.path === currentPath);
        if (file && file.source) {
            // 1. .shared 에디터 내용을 디스크에 최종 저장
            await editor.document.save();
            // 2. 저장된 내용을 원본 파일에 덮어쓰기
            fs.writeFileSync(file.source, editor.document.getText());
            
            // 3. 종료 신호 전송 및 정리
            this.sendControlMessage('STOP_SHARING', { fileName: file.name });
            await this.handleStopSharing(file.name);
        }
    }

    private async handleStopSharing(fileName: string) {
        const index = this.sharedFiles.findIndex(f => f.name === fileName);
        if (index !== -1) {
            const file = this.sharedFiles[index];
            
            // [추가] 게스트도 마지막으로 버퍼 저장 시도 (안전장치)
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
            if (doc) { await doc.save(); }

            // 해당 탭 닫기
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const targetTab = tabs.find(t => (t.input as any).uri?.fsPath === file.path);
            if (targetTab) await vscode.window.tabGroups.close(targetTab);
            
            // 파일 삭제
            if (fs.existsSync(file.path)) { try { fs.unlinkSync(file.path); } catch(e) {} }
            
            this.sharedFiles.splice(index, 1);
            this.lastRemoteContentMap.delete(fileName);
        }
        this.provider.sendToWebview({ type: 'updateFileList', files: this.sharedFiles });
    }
}
