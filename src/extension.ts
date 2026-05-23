import * as vscode from 'vscode';
import { P2PCodeShareSidebarProvider } from './sidebar';
import { SyncManager } from './sync-manager';

let syncManager: SyncManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new P2PCodeShareSidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebarProvider));

    // [신규] 가상 파일 시스템 등록 (게스트 저장 차단용)
    const p2pFileSystem = new P2PSharedFileSystem();
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('p2p-shared', p2pFileSystem, { isReadonly: false }));

    syncManager = new SyncManager(sidebarProvider, context);

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.shareActiveFile', () => {
        syncManager?.shareActiveFile();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.stopSharing', () => {
        syncManager?.stopSharing();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.openSnapshot', (filePath: string) => {
        vscode.workspace.openTextDocument(filePath).then(doc => vscode.window.showTextDocument(doc));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.renameUser', async () => {
        const newName = await vscode.window.showInputBox({ placeHolder: "Enter your nickname" });
        if (newName) syncManager?.changeMyName(newName);
    }));
}

// [신규 클래스] 가상 파일 시스템 구현 (게스트 전용)
class P2PSharedFileSystem implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    watch(_uri: vscode.Uri): vscode.Disposable { return { dispose: () => { } }; }
    stat(_uri: vscode.Uri): vscode.FileStat {
        return { type: vscode.FileType.File, ctime: Date.now(), mtime: Date.now(), size: 0 };
    }
    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] { return []; }
    createDirectory(_uri: vscode.Uri): void { }
    readFile(_uri: vscode.Uri): Uint8Array { return new Uint8Array(); }
    
    // [중요] 저장 시도 시 아무것도 하지 않음 (저장 차단)
    writeFile(_uri: vscode.Uri, _content: Uint8Array, _options: { create: boolean, overwrite: boolean }): void {
        vscode.window.showWarningMessage("Shared snapshots cannot be saved locally. Changes are synced to Host.");
    }
    
    delete(_uri: vscode.Uri): void { }
    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri): void { }
}

export function deactivate() {
    syncManager = undefined;
}
