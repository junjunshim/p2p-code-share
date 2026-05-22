import * as vscode from 'vscode';
import { P2PCodeShareSidebarProvider } from './sidebar';
import { SyncManager } from './sync-manager';

let syncManager: SyncManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new P2PCodeShareSidebarProvider(context.extensionUri);
    
    // 1. 사이드바 등록
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebarProvider)
    );

    // 2. 본체 로직 생성 및 사이드바와 연결
    syncManager = new SyncManager(sidebarProvider, context);

    // 3. 명령어 등록
    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.shareActiveFile', () => {
        syncManager?.shareActiveFile();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.stopSharing', () => {
        syncManager?.stopSharing();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.openSnapshot', (filePath: string) => {
        vscode.workspace.openTextDocument(filePath).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    }));
}

export function deactivate() {
    syncManager = undefined;
}
