import * as vscode from 'vscode';
import { SidebarProvider } from './ui/SidebarProvider';
import { HubManager } from './core/HubManager';
import { SyncEngine } from './core/SyncEngine';

export function activate(context: vscode.ExtensionContext) {
    const sidebar = new SidebarProvider(context.extensionUri);
    const hub = new HubManager();
    const engine = new SyncEngine(hub, context, (state) => {
        // [수정] 엔진에서 관리하는 isConnected 상태를 최우선으로 사용
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

    sidebar.onReady = () => {
        engine.pushUIUpdate(); // 사이드바가 로드되면 현재 엔진 상태를 즉시 전송
    };

    sidebar.onSignal = (sdp) => hub.applySignal(sdp);
    sidebar.onCancel = () => {
        hub.dispose();
        hub.lastSdp = ''; // [추가] 기록된 SDP 삭제
        engine.reset();
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
            engine.reset(); // [수정] 연결 끊김/패널 닫힘 시 전체 상태 리셋
        }
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebar),
        vscode.commands.registerCommand('p2p-code-share.shareActiveFile', () => engine.shareActiveFile()),
        vscode.commands.registerCommand('p2p-code-share.stopSharing', () => engine.stopSharing()),
        vscode.commands.registerCommand('p2p-code-share.openSnapshot', (p) => vscode.workspace.openTextDocument(p).then(d => vscode.window.showTextDocument(d)))
    );
}

export function deactivate() {}
