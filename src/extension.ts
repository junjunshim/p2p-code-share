import * as vscode from 'vscode';
import { P2PCodeShareSidebarProvider } from './sidebar';
import { SyncManager } from './sync-manager';

let syncManager: SyncManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new P2PCodeShareSidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebarProvider));

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

    // [수정] VS Code 내장 입력창을 사용한 이름 변경
    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.renameUser', async () => {
        const newName = await vscode.window.showInputBox({
            placeHolder: "Enter your new nickname",
            prompt: "Change your display name for this session"
        });
        
        if (newName) {
            syncManager?.changeMyName(newName);
        }
    }));
}

export function deactivate() {
    syncManager = undefined;
}
