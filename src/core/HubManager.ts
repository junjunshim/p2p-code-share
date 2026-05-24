import * as vscode from 'vscode';
import { getEngineTemplate } from '../ui/templates';
import { P2PMessage } from '../types';

export class HubManager {
    private _hubPanel?: vscode.WebviewPanel;
    public sdpMap: Map<string, string> = new Map(); 
    public onDidReceiveData?: (data: string, peerId: string) => void;
    public onStatusUpdate?: (status: string, peerId: string) => void;
    public onSdpGenerated?: (sdp: string, peerId: string) => void;

    constructor() {}

    public createHub(initiator: boolean, peerId: string = 'default') {
        if (!this._hubPanel) {
            this._hubPanel = vscode.window.createWebviewPanel('p2pHub', 'P2P Engine', vscode.ViewColumn.Two, { 
                enableScripts: true, 
                retainContextWhenHidden: true 
            });
            
            const autoStart = !initiator; 
            this._hubPanel.webview.html = getEngineTemplate(initiator, autoStart);
            
            this._hubPanel.webview.onDidReceiveMessage(msg => {
                const pid = msg.peerId || 'default';
                if (msg.type === 'sendData') this.onDidReceiveData?.(msg.value, pid);
                else if (msg.type === 'statusUpdate') this.onStatusUpdate?.(msg.value, pid);
                else if (msg.type === 'sdpGenerated') {
                    this.sdpMap.set(pid, msg.sdp);
                    this.onSdpGenerated?.(msg.sdp, pid);
                }
            });

            this._hubPanel.onDidDispose(() => {
                this._hubPanel = undefined;
                this.sdpMap.clear();
                this.onStatusUpdate?.('Disconnected', 'all');
            });

            if (!initiator) return;
        }

        if (initiator && peerId !== 'none' && peerId !== 'default') {
            this._hubPanel.webview.postMessage({ type: 'addNewPeer', initiator, peerId });
        }
    }

    public sendToEngine(msg: any, to?: string) {
        this._hubPanel?.webview.postMessage({ ...msg, targetPeerId: to });
    }

    public dispose() {
        this._hubPanel?.dispose();
        this.sdpMap.clear();
    }

    public applySignal(sdp: any, peerId: string) {
        // [수정] peerId를 명시적으로 전달하여 엔진이 엉뚱한 피어를 찾지 않게 함
        this.sendToEngine({ type: 'signal', sdp, peerId }, peerId);
    }
}
