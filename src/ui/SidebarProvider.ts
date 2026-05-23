import * as vscode from 'vscode';
import { getSidebarTemplate } from '../ui/templates';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    public onInitPeer?: (initiator: boolean, roomName: string) => void;
    public onReady?: () => void; // [추가]
    public onSignal?: (sdp: any) => void;
    public onCancel?: () => void;
    public onRename?: () => void;
    public onStopFileSharing?: (fileName: string) => void; // [추가]

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = getSidebarTemplate();
        (webviewView as any).retainContextWhenHidden = true;

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready': this.onReady?.(); break;
                case 'initPeer': this.onInitPeer?.(msg.initiator, msg.roomName); break;
                case 'signal': this.onSignal?.(msg.sdp); break;
                case 'cancel': this.onCancel?.(); break;
                case 'rename': this.onRename?.(); break;
                case 'openFile': vscode.commands.executeCommand('p2p-code-share.openSnapshot', msg.path); break;
                case 'stopFileSharing': this.onStopFileSharing?.(msg.fileName); break; // [추가]
            }
        });
    }

    public postMessage(msg: any) {
        this._view?.webview.postMessage(msg);
    }
}
