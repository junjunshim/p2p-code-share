import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class SyncManager {
    private isApplyingRemoteChange: boolean = false;
    private syncFilePath: string | undefined;
    private isHost: boolean = false;
    private permissions: number = 0x000002;
    private remoteCursorDecoration: vscode.TextEditorDecorationType;

    constructor(private sidebarProvider: P2PCodeShareSidebarProvider) {
        // 커서 스타일 정의 (심플한 색상 선)
        this.remoteCursorDecoration = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px',
            borderStyle: 'solid',
            light: { borderColor: 'rgba(255, 69, 0, 1)' }, // 주황색 (밝은 테마)
            dark: { borderColor: 'rgba(0, 255, 255, 1)' }   // 하늘색 (어두운 테마)
        });

        // 1. 파일 생성 감지 (파일을 먼저 만드는 쪽이 Host가 됨)
        vscode.workspace.onDidCreateFiles(e => {
            if (e.files.length > 0) {
                this.isHost = true;
                const file = e.files[0];
                this.syncFilePath = file.fsPath;
                const fileName = path.basename(file.fsPath);
                this.sendControlMessage('INIT_HOST', { fileName, content: '' });
                vscode.window.showInformationMessage('You are the HOST. Sharing started.');
            }
        });

        // 2. 에디터 변경 감지
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange || !this.syncFilePath || e.document.uri.fsPath !== this.syncFilePath) return;

            if (this.isHost) {
                this.broadcastFullContent();
            } else {
                this.sendControlMessage('GUEST_EDIT', { content: e.document.getText() });
            }
        });

        // 커서 이동 감지
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (!this.syncFilePath || e.textEditor.document.uri.fsPath !== this.syncFilePath) return;
            const index = e.textEditor.document.offsetAt(e.selections[0].active);
            this.sendControlMessage('CURSOR_MOVE', { index });
        });

        // 3. 데이터 수신 처리
        this.sidebarProvider.onDidReceiveData = async (data: any) => {
            const arr = Array.isArray(data) ? data : Object.values(data);
            if (arr.length === 0) return;
            
            const payload = new Uint8Array(arr);
            const msg = JSON.parse(new TextDecoder().decode(payload));

            switch (msg.type) {
                case 'INIT_HOST':
                    await this.handleInitHost(msg);
                    break;
                case 'SYNC_FULL':
                    await this.updateEditorFull(msg.content);
                    break;
                case 'GUEST_EDIT':
                    if (this.isHost) {
                        await this.updateEditorFull(msg.content);
                        this.broadcastFullContent();
                    }
                    break;
                case 'CURSOR_MOVE':
                    this.renderRemoteCursor(msg.index);
                    break;
            }
        };
    }

    private broadcastFullContent() {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.syncFilePath);
        if (doc) {
            this.sendControlMessage('SYNC_FULL', { content: doc.getText() });
        }
    }

    private sendControlMessage(type: string, data: any) {
        const payload = new TextEncoder().encode(JSON.stringify({ type, ...data }));
        this.sidebarProvider.sendToWebview({ type: 'peerData', value: Array.from(payload) });
    }

    private async handleInitHost(msg: any) {
        this.isHost = false; 
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        const baseFolder = workspaceFolders[0].uri.fsPath;
        const sharedFileName = msg.fileName.includes('.') 
            ? msg.fileName.replace(/(\.[^.]+)$/, '_shared$1') : msg.fileName + '_shared';
        const sharedFilePath = path.join(baseFolder, sharedFileName);
        
        if (!fs.existsSync(sharedFilePath)) fs.writeFileSync(sharedFilePath, msg.content);
        this.syncFilePath = sharedFilePath;

        const doc = await vscode.workspace.openTextDocument(sharedFilePath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage('You are the GUEST. Connected to Host.');
    }

    private async updateEditorFull(content: string) {
        if (!this.syncFilePath) return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.syncFilePath);
        if (!doc) return;

        const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
        if (!editor || doc.getText() === content) return;

        this.isApplyingRemoteChange = true;
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        
        await editor.edit(editBuilder => {
            editBuilder.replace(fullRange, content);
        }, { undoStopBefore: false, undoStopAfter: false });
        
        this.isApplyingRemoteChange = false;
    }

    private renderRemoteCursor(index: number) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.syncFilePath || editor.document.uri.fsPath !== this.syncFilePath) return;

        const pos = editor.document.positionAt(index);
        const range = new vscode.Range(pos, pos);
        editor.setDecorations(this.remoteCursorDecoration, [{ range }]);
    }

    public setPermissions(mask: number) {
        this.permissions = mask;
    }
}

interface P2PCodeShareSidebarProvider {
    onDidReceiveData?: (data: any) => void;
    sendToWebview(message: any): void;
}
