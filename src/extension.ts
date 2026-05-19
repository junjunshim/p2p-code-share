import * as vscode from 'vscode';
import { P2PCodeShareSidebarProvider } from './sidebar';
import { SyncManager } from './sync-manager';

export function activate(context: vscode.ExtensionContext) {
    console.log('P2P Code Share extension is now active');
    vscode.window.showInformationMessage('P2P Extension Activated!');

    const sidebarProvider = new P2PCodeShareSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'p2p-code-share-sidebar',
            sidebarProvider
        )
    );

    const syncManager = new SyncManager(sidebarProvider);
    // syncManager가 메모리에서 해제되지 않도록 구독 리스트에 추가 (dispose 메서드 필요 시 추가)
    context.subscriptions.push({ dispose: () => {} });

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.setViewer', () => {
        syncManager.setPermissions(0x000001);
        vscode.window.showInformationMessage('Permission set to Viewer');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.setEditor', () => {
        syncManager.setPermissions(0x000002);
        vscode.window.showInformationMessage('Permission set to Editor');
    }));
}

export function deactivate() {}
