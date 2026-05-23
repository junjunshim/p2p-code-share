import * as vscode from 'vscode';
import { getEngineTemplate } from '../ui/templates';
import { P2PMessage } from '../types';

export class HubManager {
    private _hubPanel?: vscode.WebviewPanel;
    public lastSdp: string = ''; // [추가] 타입 에러 해결용
    public onDidReceiveData?: (data: string) => void;
    public onStatusUpdate?: (status: string) => void;
    public onSdpGenerated?: (sdp: string) => void;

    constructor() {}

    public createHub(initiator: boolean) {
        if (this._hubPanel) { try { this._hubPanel.dispose(); } catch(e) {} }
        this._hubPanel = vscode.window.createWebviewPanel('p2pHub', 'P2P Engine', vscode.ViewColumn.Two, { 
            enableScripts: true, 
            retainContextWhenHidden: true 
        });
        
        this._hubPanel.webview.html = getEngineTemplate(initiator);
        
        this._hubPanel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'sendData') this.onDidReceiveData?.(msg.value);
            else if (msg.type === 'statusUpdate') this.onStatusUpdate?.(msg.value);
            else if (msg.type === 'sdpGenerated') this.onSdpGenerated?.(msg.sdp);
        });

        this._hubPanel.onDidDispose(() => {
            this._hubPanel = undefined;
            this.onStatusUpdate?.('Disconnected');
        });
    }

    public sendToEngine(msg: P2PMessage) {
        this._hubPanel?.webview.postMessage(msg);
    }

    public dispose() {
        this._hubPanel?.dispose();
    }

    public applySignal(sdp: any) {
        this.sendToEngine({ type: 'signal', sdp });
    }
}
