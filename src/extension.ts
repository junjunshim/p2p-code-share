import * as vscode from 'vscode';
import { SidebarProvider } from './ui/SidebarProvider';
import { HubManager } from './core/HubManager';
import { SyncEngine } from './core/SyncEngine';

export function activate(context: vscode.ExtensionContext) {
    const sidebar = new SidebarProvider(context.extensionUri);
    const hub = new HubManager();
    const engine = new SyncEngine(hub, context, (state) => {
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', state.isConnected);
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', engine.isHost);
        
        sidebar.postMessage({
            type: 'renderState',
            isConnected: state.isConnected,
            isSetupMode: state.isSetupMode,
            files: state.files,
            participants: state,
            roomName: state.roomName,
            invitingSdp: state.invitingSdp // [수정] hub.lastSdp 대신 state에서 온 값 사용
        });
    });

    sidebar.onInitPeer = (initiator, roomName) => {
        hub.createHub(initiator);
        engine.handleSetRole({ isHost: initiator, roomName });
    };

    sidebar.onReady = () => { engine.pushUIUpdate(); };

    sidebar.onInviteGuest = () => {
        engine.inviteGuest();
    };

    sidebar.onStopFileSharing = (fileName) => {
        engine.stopSharingByName(fileName);
    };

    sidebar.onSignal = (sdp, peerId) => hub.applySignal(sdp, peerId || 'default');
    
    sidebar.onCancel = (data?: any) => {
        if (engine.isConnected && engine.isHost && engine.isSetupMode) {
            engine.isSetupMode = false;
            engine.pushUIUpdate();
        } else {
            hub.dispose();
            engine.reset();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    };

    sidebar.onRename = async () => {
        const n = await vscode.window.showInputBox({ placeHolder: "Enter new name" });
        if (n) engine.changeMyName(n);
    };

    hub.onSdpGenerated = (sdp, peerId) => {
        sidebar.postMessage({ type: 'sdpGenerated', sdp, peerId });
        engine.pushUIUpdate();
    };

    hub.onStatusUpdate = (status, peerId) => {
        if (status === 'Connected') {
            hub.onDidReceiveData?.(JSON.stringify({ type: 'ON_CONNECTED' }), peerId);
        } else if (status === 'Disconnected') {
            if (peerId === 'all') {
                engine.reset();
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
            } else {
                engine.handlePeerDisconnect(peerId);
            }
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
