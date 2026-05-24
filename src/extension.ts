import * as vscode from 'vscode';
import { SidebarProvider } from './ui/SidebarProvider';
import { HubManager } from './core/HubManager';
import { SyncEngine } from './core/SyncEngine';

export function activate(context: vscode.ExtensionContext) {
    const sidebar = new SidebarProvider(context.extensionUri);
    const hub = new HubManager();
    const engine = new SyncEngine(hub, context, (state) => {
        // [수정] 우클릭 메뉴를 위해 연결 상태 및 호스트 여부 공유
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', state.isConnected);
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', engine.isHost);
        
        sidebar.postMessage({
            type: 'renderState',
            isConnected: state.isConnected,
            isSetupMode: state.isSetupMode,
            files: state.files,
            participants: state,
            roomName: state.roomName,
            lastSdp: hub.lastSdp || ''
        });
    });

    sidebar.onInitPeer = (initiator, roomName) => {
        hub.createHub(initiator);
        engine.handleSetRole({ isHost: initiator, roomName });
    };

    sidebar.onReady = () => { engine.pushUIUpdate(); };

    sidebar.onStopFileSharing = (fileName) => {
        engine.stopSharingByName(fileName);
    };

    sidebar.onSignal = (sdp) => hub.applySignal(sdp);
    sidebar.onCancel = () => {
        hub.dispose();
        hub.lastSdp = '';
        engine.reset();
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
    };
    sidebar.onRename = async () => {
        const n = await vscode.window.showInputBox({ placeHolder: "Enter new name" });
        if (n) engine.changeMyName(n);
    };

    hub.onSdpGenerated = (sdp) => {
        hub.lastSdp = sdp;
        sidebar.postMessage({ type: 'sdpGenerated', sdp });
        engine.pushUIUpdate();
    };

    hub.onStatusUpdate = (status) => {
        if (status === 'Connected') {
            hub.onDidReceiveData?.(JSON.stringify({ type: 'ON_CONNECTED' }));
        } else if (status === 'Disconnected') {
            engine.reset();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebar),
        vscode.commands.registerCommand('p2p-code-share.shareActiveFile', (uri?: vscode.Uri) => {
            engine.shareActiveFile(uri);
        }),
        vscode.commands.registerCommand('p2p-code-share.stopSharing', () => engine.stopSharing()),
        vscode.commands.registerCommand('p2p-code-share.openSnapshot', (p) => vscode.workspace.openTextDocument(p).then(d => vscode.window.showTextDocument(d)))
    );
}

export function deactivate() {}
