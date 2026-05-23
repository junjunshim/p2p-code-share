import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class SyncManager {
    private isApplyingRemoteChange: boolean = false;
    private sourceFilePath: string | undefined;   // Host만 사용
    private snapshotFilePath: string | undefined; // Host만 사용
    private guestDoc: vscode.TextDocument | undefined;
    private isHost: boolean = false;
    private storagePath: string;
    private sharedFiles: { name: string, path: string }[] = [];
    private myName: string = '';
    private participants: { [key: string]: string } = {}; 
    private lastRemoteContent: string = '';
    private pollingTimer: NodeJS.Timeout | undefined;
    private roomName: string = '';

    constructor(private provider: any, private context: vscode.ExtensionContext) {
        const workspaceName = vscode.workspace.name || 'default';
        this.storagePath = path.join(context.globalStorageUri.fsPath, workspaceName);

        this.provider.onDidReceiveData = async (text: string) => {
            try {
                const msg = JSON.parse(text);
                if (msg.type === 'SET_ROLE') {
                    this.isHost = msg.isHost;
                    this.roomName = msg.roomName || 'Untitled Room';
                    this.myName = this.isHost ? 'Host' : 'Guest1';
                    this.participants = {};
                    if (this.isHost) {
                        this.ensureDirectory(this.storagePath);
                        this.participants['host'] = this.myName;
                        this.broadcastUserList();
                    } else {
                        this.startPolling();
                    }
                    this.updateSidebarUI();
                    return;
                }
                if (msg.type === 'ON_CONNECTED') {
                    if (!this.isHost) this.sendControlMessage('GUEST_JOIN', { name: this.myName });
                    return;
                }

                switch (msg.type) {
                    case 'INIT_SNAPSHOT': await this.handleGuestInit(msg); break;
                    case 'SYNC_FULL': 
                        await this.forceUpdateEditor(msg.content);
                        break;
                    case 'STOP_SHARING': await this.handleStopSharing(); break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastFullContent(); break;
                    case 'GUEST_JOIN':
                        if (this.isHost) {
                            this.participants['guest'] = msg.name;
                            this.broadcastUserList();
                            this.broadcastFullContent();
                        }
                        break;
                    case 'GUEST_RENAME':
                        if (this.isHost) {
                            this.participants['guest'] = msg.newName;
                            this.broadcastUserList();
                        }
                        break;
                    case 'USER_LIST_UPDATE':
                        this.participants = msg.users;
                        this.roomName = msg.roomName || this.roomName;
                        const myKey = this.isHost ? 'host' : 'guest';
                        if (this.participants[myKey]) this.myName = this.participants[myKey];
                        this.updateSidebarUI();
                        break;
                    case 'GUEST_EDIT':
                        if (this.isHost) {
                            await this.forceUpdateEditor(msg.content);
                            this.broadcastFullContent();
                        }
                        break;
                }
            } catch (e) {}
        };

        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange) return;
            const isTargetDoc = this.isHost 
                ? (this.snapshotFilePath && e.document.uri.fsPath === this.snapshotFilePath)
                : (this.guestDoc && e.document === this.guestDoc);

            if (!isTargetDoc) return;

            const currentText = e.document.getText();
            if (currentText === this.lastRemoteContent) return;

            if (this.isHost) {
                this.sendControlMessage('SYNC_FULL', { content: currentText });
            } else {
                this.sendControlMessage('GUEST_EDIT', { content: currentText });
            }
        });
    }

    private async forceUpdateEditor(content: string) {
        const doc = this.isHost ? vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.snapshotFilePath) : this.guestDoc;
        if (!doc || doc.getText() === content) return;

        this.lastRemoteContent = content;
        this.isApplyingRemoteChange = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
        try {
            await vscode.workspace.applyEdit(edit);
        } finally {
            setTimeout(() => { this.isApplyingRemoteChange = false; }, 50);
        }
    }

    public async shareActiveFile() {
        if (!this.isHost) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        this.sourceFilePath = editor.document.uri.fsPath;
        const fileName = path.basename(this.sourceFilePath);
        this.snapshotFilePath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(this.snapshotFilePath, editor.document.getText());
        const doc = await vscode.workspace.openTextDocument(this.snapshotFilePath);
        await vscode.window.showTextDocument(doc);
        this.sendControlMessage('INIT_SNAPSHOT', { fileName, content: editor.document.getText() });
        this.addSharedFile(fileName, this.snapshotFilePath);
    }

    private async handleGuestInit(msg: any) {
        this.isHost = false;
        const uri = vscode.Uri.parse(`p2p-shared:/${msg.fileName}`);
        const doc = await vscode.workspace.openTextDocument(uri);
        this.guestDoc = doc;
        this.isApplyingRemoteChange = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), msg.content);
        await vscode.workspace.applyEdit(edit);
        this.isApplyingRemoteChange = false;
        await vscode.window.showTextDocument(doc);
    }

    // [복구] 사용자 이름 변경 로직
    public changeMyName(newName: string) {
        if (this.isHost) {
            this.myName = newName;
            this.participants['host'] = newName;
            this.broadcastUserList();
        } else {
            // 게스트는 호스트에게 변경 요청
            this.sendControlMessage('GUEST_RENAME', { newName });
        }
    }

    private startPolling() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.pollingTimer = setInterval(() => {
            if (!this.isHost && this.guestDoc) {
                this.sendControlMessage('REQUEST_FULL_SYNC', {});
            }
        }, 5000);
    }

    private broadcastFullContent() {
        if (!this.snapshotFilePath) return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.snapshotFilePath);
        const content = doc ? doc.getText() : fs.readFileSync(this.snapshotFilePath, 'utf8');
        this.sendControlMessage('SYNC_FULL', { content });
    }

    private sendControlMessage(type: string, data: any) {
        this.provider.sendToWebview({ type: 'peerData', value: { type, ...data } });
    }

    private ensureDirectory(dir: string) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    private broadcastUserList() {
        if (this.isHost) {
            this.sendControlMessage('USER_LIST_UPDATE', { 
                users: this.participants, 
                roomName: this.roomName 
            });
            this.updateSidebarUI();
        }
    }

    private updateSidebarUI() {
        this.provider.sendToWebview({ 
            type: 'renderParticipants', 
            myName: this.myName, 
            others: this.participants,
            roomName: this.roomName 
        });
    }

    private addSharedFile(name: string, filePath: string) {
        if (!this.sharedFiles.find(f => f.path === filePath)) this.sharedFiles.push({ name, path: filePath });
        this.provider.sendToWebview({ type: 'updateFileList', files: this.sharedFiles });
    }

    public async stopSharing() {
        if (!this.isHost || !this.snapshotFilePath || !this.sourceFilePath) return;
        fs.writeFileSync(this.sourceFilePath, fs.readFileSync(this.snapshotFilePath, 'utf8'));
        this.sendControlMessage('STOP_SHARING', {});
        await this.handleStopSharing();
    }

    private async handleStopSharing() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        if (this.isHost && this.snapshotFilePath && fs.existsSync(this.snapshotFilePath)) fs.unlinkSync(this.snapshotFilePath);
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        const targetTab = tabs.find(t => {
            const input = t.input as any;
            return (this.isHost && input.uri?.fsPath === this.snapshotFilePath) || (!this.isHost && input.uri?.scheme === 'p2p-shared');
        });
        if (targetTab) vscode.window.tabGroups.close(targetTab);
        this.sharedFiles = []; this.snapshotFilePath = undefined; this.guestDoc = undefined;
        this.provider.sendToWebview({ type: 'updateFileList', files: [] });
    }
}
