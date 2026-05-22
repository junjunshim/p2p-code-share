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

    constructor(private provider: any, private context: vscode.ExtensionContext) {
        const workspaceName = vscode.workspace.name || 'default';
        this.storagePath = path.join(context.globalStorageUri.fsPath, workspaceName);
        this.ensureDirectory(this.storagePath);

        this.provider.onDidReceiveData = async (text: string) => {
            try {
                const msg = JSON.parse(text);
                if (msg.type === 'SET_ROLE') {
                    this.isHost = msg.isHost;
                    vscode.window.showInformationMessage(`Role set as: ${this.isHost ? 'HOST' : 'GUEST'}`);
                    return;
                }
                if (msg.type === 'INIT_SNAPSHOT') await this.handleInitSnapshot(msg);
                else if (msg.type === 'SYNC_FULL') await this.updateSnapshotState(msg.content);
                else if (msg.type === 'STOP_SHARING') await this.handleStopSharing();
                else if (msg.type === 'GUEST_EDIT' && this.isHost) {
                    await this.updateSnapshotState(msg.content);
                    this.broadcastFullContent();
                }
            } catch (e) {}
        };

        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange || !this.snapshotFilePath || e.document.uri.fsPath !== this.snapshotFilePath) return;
            if (this.isHost) this.broadcastFullContent();
            else this.sendControlMessage('GUEST_EDIT', { content: e.document.getText() });
        });

        // Host에서 저장 시 원본 파일에 반영
        vscode.workspace.onDidSaveTextDocument(async doc => {
            if (this.isHost && this.snapshotFilePath && doc.uri.fsPath === this.snapshotFilePath && this.sourceFilePath) {
                fs.writeFileSync(this.sourceFilePath, doc.getText());
                vscode.window.showInformationMessage(`P2P: Merged changes to original file.`);
            }
        });
    }

    private ensureDirectory(dir: string) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    public async shareActiveFile() {
        if (!this.isHost) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        this.sourceFilePath = editor.document.uri.fsPath;
        const fileName = path.basename(this.sourceFilePath);
        this.snapshotFilePath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(this.snapshotFilePath, editor.document.getText());
        this.addSharedFile(fileName, this.snapshotFilePath);
        const doc = await vscode.workspace.openTextDocument(this.snapshotFilePath);
        await vscode.window.showTextDocument(doc);
        this.sendControlMessage('INIT_SNAPSHOT', { fileName, content: editor.document.getText() });
    }

    private async handleInitSnapshot(msg: any) {
        this.isHost = false;
        this.ensureDirectory(this.storagePath);
        this.snapshotFilePath = path.join(this.storagePath, msg.fileName + '.shared');
        fs.writeFileSync(this.snapshotFilePath, msg.content);
        this.addSharedFile(msg.fileName, this.snapshotFilePath);
        const doc = await vscode.workspace.openTextDocument(this.snapshotFilePath);
        await vscode.window.showTextDocument(doc);
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

    // [버그 해결 핵심] 데이터 동기화 로직 최적화
    private async updateSnapshotState(content: string) {
        if (!this.snapshotFilePath) return;

        // 1. 해당 문서가 VS Code 메모리에 열려 있는지 확인
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.snapshotFilePath);

        if (doc) {
            // 에디터가 열려 있다면 -> 메모리 버퍼만 수정 (저장 충돌 방지)
            if (doc.getText() !== content) {
                this.isApplyingRemoteChange = true;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
                await vscode.workspace.applyEdit(edit);
                this.isApplyingRemoteChange = false;
            }
        } else {
            // 에디터가 닫혀 있다면 -> 디스크 파일에 직접 기록
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
        if (!this.sharedFiles.find(f => f.path === filePath)) {
            this.sharedFiles.push({ name, path: filePath });
        }
        this.provider.sendToWebview({ type: 'updateFileList', files: this.sharedFiles });
    }

    public setPermissions(mask: number) {}
}
