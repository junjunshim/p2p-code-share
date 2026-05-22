import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class SyncManager {
    private isApplyingRemoteChange: boolean = false;
    private sourceFilePath: string | undefined;
    private snapshotFilePath: string | undefined;
    private isHost: boolean = false;
    private storagePath: string;
    private sharedFiles: { name: string, path: string }[] = [];
    private myName: string = '';
    private participants: { [key: string]: string } = {}; 
    
    private lastLocalEditTime: number = 0;
    private cachedRemoteContent: string | undefined;

    constructor(private provider: any, private context: vscode.ExtensionContext) {
        const workspaceName = vscode.workspace.name || 'default';
        this.storagePath = path.join(context.globalStorageUri.fsPath, workspaceName);
        this.ensureDirectory(this.storagePath);

        this.provider.onDidReceiveData = async (text: string) => {
            try {
                const msg = JSON.parse(text);
                
                if (msg.type === 'SET_ROLE') {
                    this.isHost = msg.isHost;
                    this.myName = this.isHost ? 'Host' : 'Guest1';
                    this.participants = {};
                    if (this.isHost) { this.participants['host'] = this.myName; this.broadcastUserList(); }
                    return;
                }

                if (msg.type === 'ON_CONNECTED') {
                    if (!this.isHost) this.sendControlMessage('GUEST_JOIN', { name: this.myName });
                    return;
                }

                switch (msg.type) {
                    case 'INIT_SNAPSHOT': await this.handleInitSnapshot(msg); break;
                    case 'SYNC_FULL': 
                        if (Date.now() - this.lastLocalEditTime > 500) {
                            await this.updateSnapshotState(msg.content);
                        } else {
                            this.cachedRemoteContent = msg.content;
                        }
                        break;
                    case 'STOP_SHARING': await this.handleStopSharing(); break;
                    case 'GUEST_JOIN':
                        if (this.isHost) { this.participants['guest'] = msg.name; this.broadcastUserList(); }
                        break;
                    case 'GUEST_RENAME':
                        if (this.isHost) { this.participants['guest'] = msg.newName; this.broadcastUserList(); }
                        break;
                    case 'USER_LIST_UPDATE':
                        this.participants = msg.users;
                        const myKey = this.isHost ? 'host' : 'guest';
                        if (this.participants[myKey]) this.myName = this.participants[myKey];
                        this.updateSidebarUI();
                        break;

                    // [핵심 추가] 게스트가 보낸 부분 변경 사항(Delta) 처리
                    case 'GUEST_DELTA':
                        if (this.isHost) {
                            await this.applyDeltasToHost(msg.deltas);
                            // 델타 적용 후 호스트가 최종본을 다시 모든 게스트에게 전파
                            this.broadcastFullContent();
                        }
                        break;

                    case 'GUEST_EDIT': // 하위 호환성 유지
                        if (this.isHost) {
                            await this.updateSnapshotState(msg.content);
                            this.broadcastFullContent();
                        }
                        break;
                }
            } catch (e) {}
        };

        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange || !this.snapshotFilePath || e.document.uri.fsPath !== this.snapshotFilePath) return;
            
            this.lastLocalEditTime = Date.now();

            if (this.isHost) {
                this.broadcastFullContent();
            } else {
                // [수정] 게스트는 이제 전체 텍스트 대신 "바뀐 부분(Delta)"만 보냄
                const deltas = e.contentChanges.map(c => ({
                    range: [c.range.start.line, c.range.start.character, c.range.end.line, c.range.end.character],
                    text: c.text
                }));
                this.sendControlMessage('GUEST_DELTA', { deltas });

                // 최종 교정용 타이머 유지
                setTimeout(() => {
                    if (this.cachedRemoteContent && Date.now() - this.lastLocalEditTime >= 600) {
                        this.updateSnapshotState(this.cachedRemoteContent);
                        this.cachedRemoteContent = undefined;
                    }
                }, 600);
            }
        });
    }

    private async applyDeltasToHost(deltas: any[]) {
        if (!this.snapshotFilePath) return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.snapshotFilePath);
        if (!doc) return;

        this.isApplyingRemoteChange = true;
        const edit = new vscode.WorkspaceEdit();
        
        deltas.forEach(d => {
            const range = new vscode.Range(d.range[0], d.range[1], d.range[2], d.range[3]);
            edit.replace(doc.uri, range, d.text);
        });

        await vscode.workspace.applyEdit(edit);
        this.isApplyingRemoteChange = false;
    }

    private ensureDirectory(dir: string) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    private broadcastUserList() {
        if (this.isHost) {
            this.sendControlMessage('USER_LIST_UPDATE', { users: this.participants });
            this.updateSidebarUI();
        }
    }

    private updateSidebarUI() {
        this.provider.sendToWebview({ type: 'renderParticipants', myName: this.myName, others: this.participants });
    }

    public changeMyName(newName: string) {
        if (this.isHost) {
            this.myName = newName;
            this.participants['host'] = newName;
            this.broadcastUserList();
        } else {
            this.sendControlMessage('GUEST_RENAME', { newName });
        }
    }

    public async shareActiveFile() {
        if (!this.isHost) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        this.sourceFilePath = editor.document.uri.fsPath;
        this.snapshotFilePath = path.join(this.storagePath, path.basename(this.sourceFilePath) + '.shared');
        fs.writeFileSync(this.snapshotFilePath, editor.document.getText());
        await vscode.workspace.openTextDocument(this.snapshotFilePath).then(doc => vscode.window.showTextDocument(doc));
        this.sendControlMessage('INIT_SNAPSHOT', { fileName: path.basename(this.sourceFilePath), content: editor.document.getText() });
        this.addSharedFile(path.basename(this.sourceFilePath), this.snapshotFilePath);
    }

    private async handleInitSnapshot(msg: any) {
        this.isHost = false;
        this.ensureDirectory(this.storagePath);
        this.snapshotFilePath = path.join(this.storagePath, msg.fileName + '.shared');
        fs.writeFileSync(this.snapshotFilePath, msg.content);
        this.addSharedFile(msg.fileName, this.snapshotFilePath);
        await vscode.workspace.openTextDocument(this.snapshotFilePath).then(doc => vscode.window.showTextDocument(doc));
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

    private async updateSnapshotState(content: string) {
        if (!this.snapshotFilePath) return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.snapshotFilePath);
        if (doc) {
            if (doc.getText() !== content) {
                this.isApplyingRemoteChange = true;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
                await vscode.workspace.applyEdit(edit);
                this.isApplyingRemoteChange = false;
            }
        } else {
            fs.writeFileSync(this.snapshotFilePath, content);
        }
    }

    private async handleStopSharing() {
        if (this.snapshotFilePath && fs.existsSync(this.snapshotFilePath)) {
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const targetTab = tabs.find(t => (t.input as any).uri?.fsPath === this.snapshotFilePath);
            if (targetTab) vscode.window.tabGroups.close(targetTab);
            fs.unlinkSync(this.snapshotFilePath);
        }
        this.sharedFiles = [];
        this.snapshotFilePath = undefined;
        this.provider.sendToWebview({ type: 'updateFileList', files: [] });
    }

    public async stopSharing() {
        if (!this.isHost || !this.snapshotFilePath || !this.sourceFilePath) return;
        fs.writeFileSync(this.sourceFilePath, fs.readFileSync(this.snapshotFilePath, 'utf8'));
        this.sendControlMessage('STOP_SHARING', {});
        await this.handleStopSharing();
    }

    private addSharedFile(name: string, filePath: string) {
        if (!this.sharedFiles.find(f => f.path === filePath)) this.sharedFiles.push({ name, path: filePath });
        this.provider.sendToWebview({ type: 'updateFileList', files: this.sharedFiles });
    }

    public setPermissions(mask: number) {}
}
