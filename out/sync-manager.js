"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class SyncManager {
    constructor(sidebarProvider) {
        this.sidebarProvider = sidebarProvider;
        this.isApplyingRemoteChange = false;
        this.isHost = false;
        this.permissions = 0x000002;
        // 커서 스타일 정의 (심플한 색상 선)
        this.remoteCursorDecoration = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px',
            borderStyle: 'solid',
            light: { borderColor: 'rgba(255, 69, 0, 1)' },
            dark: { borderColor: 'rgba(0, 255, 255, 1)' } // 하늘색 (어두운 테마)
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
            if (this.isApplyingRemoteChange || !this.syncFilePath || e.document.uri.fsPath !== this.syncFilePath)
                return;
            if (this.isHost) {
                this.broadcastFullContent();
            }
            else {
                this.sendControlMessage('GUEST_EDIT', { content: e.document.getText() });
            }
        });
        // 커서 이동 감지
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (!this.syncFilePath || e.textEditor.document.uri.fsPath !== this.syncFilePath)
                return;
            const index = e.textEditor.document.offsetAt(e.selections[0].active);
            this.sendControlMessage('CURSOR_MOVE', { index });
        });
        // 3. 데이터 수신 처리
        this.sidebarProvider.onDidReceiveData = async (data) => {
            const arr = Array.isArray(data) ? data : Object.values(data);
            if (arr.length === 0)
                return;
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
    broadcastFullContent() {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.syncFilePath);
        if (doc) {
            this.sendControlMessage('SYNC_FULL', { content: doc.getText() });
        }
    }
    sendControlMessage(type, data) {
        const payload = new TextEncoder().encode(JSON.stringify({ type, ...data }));
        this.sidebarProvider.sendToWebview({ type: 'peerData', value: Array.from(payload) });
    }
    async handleInitHost(msg) {
        this.isHost = false;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders)
            return;
        const baseFolder = workspaceFolders[0].uri.fsPath;
        const sharedFileName = msg.fileName.includes('.')
            ? msg.fileName.replace(/(\.[^.]+)$/, '_shared$1') : msg.fileName + '_shared';
        const sharedFilePath = path.join(baseFolder, sharedFileName);
        if (!fs.existsSync(sharedFilePath))
            fs.writeFileSync(sharedFilePath, msg.content);
        this.syncFilePath = sharedFilePath;
        const doc = await vscode.workspace.openTextDocument(sharedFilePath);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage('You are the GUEST. Connected to Host.');
    }
    async updateEditorFull(content) {
        if (!this.syncFilePath)
            return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === this.syncFilePath);
        if (!doc)
            return;
        const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
        if (!editor || doc.getText() === content)
            return;
        this.isApplyingRemoteChange = true;
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        await editor.edit(editBuilder => {
            editBuilder.replace(fullRange, content);
        }, { undoStopBefore: false, undoStopAfter: false });
        this.isApplyingRemoteChange = false;
    }
    renderRemoteCursor(index) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.syncFilePath || editor.document.uri.fsPath !== this.syncFilePath)
            return;
        const pos = editor.document.positionAt(index);
        const range = new vscode.Range(pos, pos);
        editor.setDecorations(this.remoteCursorDecoration, [{ range }]);
    }
    setPermissions(mask) {
        this.permissions = mask;
    }
}
exports.SyncManager = SyncManager;
//# sourceMappingURL=sync-manager.js.map