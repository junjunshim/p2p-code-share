import * as vscode from 'vscode';

export class P2PCodeShareSidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _extensionUri: vscode.Uri) {}

    private _view?: vscode.WebviewView;

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            switch (data.type) {
                case 'sendData':
                    // This will be used later for Yjs data
                    this.onDidReceiveData?.(data.value);
                    break;
                case 'statusUpdate':
                    vscode.window.showInformationMessage(`P2P Status: ${data.value}`);
                    break;
                case 'log':
                    console.log('Webview Log:', data.value);
                    break;
            }
        });
    }

    public onDidReceiveData?: (data: Uint8Array) => void;

    public sendToWebview(message: any) {
        this._view?.webview.postMessage(message);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>P2P Code Share</title>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
                <style>
                    body { font-family: sans-serif; padding: 10px; color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); }
                    button { width: 100%; margin-bottom: 10px; padding: 8px; cursor: pointer; background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
                    button:hover { background-color: var(--vscode-button-hoverBackground); }
                    textarea { width: 100%; height: 80px; margin-bottom: 10px; background-color: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
                    label { display: block; margin-bottom: 5px; font-weight: bold; }
                    .section { margin-bottom: 20px; border-bottom: 1px solid var(--vscode-divider); padding-bottom: 10px; }
                    #status { font-style: italic; }
                </style>
            </head>
            <body>
                <div class="section">
                    <button id="hostBtn">공유방 만들기 (Host)</button>
                    <button id="joinBtn">참여하기 (Guest)</button>
                </div>
                
                <div id="connectionArea" style="display:none;">
                    <label id="localLabel">내 SDP (복사):</label>
                    <textarea id="localSdp" readonly></textarea>
                    
                    <label id="remoteLabel">상대방 SDP (붙여넣기):</label>
                    <textarea id="remoteSdp"></textarea>
                    <button id="connectBtn">연결</button>
                </div>

                <div id="statusArea">
                    <p>상태: <span id="status">대기 중</span></p>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    let peer = null;

                    const hostBtn = document.getElementById('hostBtn');
                    const joinBtn = document.getElementById('joinBtn');
                    const connectionArea = document.getElementById('connectionArea');
                    const connectBtn = document.getElementById('connectBtn');
                    const localSdp = document.getElementById('localSdp');
                    const remoteSdp = document.getElementById('remoteSdp');
                    const status = document.getElementById('status');

                    function initPeer(initiator) {
                        if (peer) peer.destroy();
                        
                        // STUN 서버 설정을 빈 값으로 두어 로컬 네트워크 후보만 사용하도록 함
                        peer = new SimplePeer({
                            initiator: initiator,
                            trickle: false,
                            config: { iceServers: [] } 
                        });

                        peer.on('signal', data => {
                            localSdp.value = JSON.stringify(data);
                            status.innerText = initiator ? 'Offer 생성됨. 전달 대기 중' : 'Answer 생성됨. 전달 대기 중';
                        });

                        peer.on('connect', () => {
                            status.innerText = '연결됨 (P2P Established!)';
                            vscode.postMessage({ type: 'statusUpdate', value: 'Connected' });
                        });

                        peer.on('data', data => {
                            // Uint8Array 또는 Buffer를 일반 배열로 변환하여 전송
                            const arrayData = Array.from(new Uint8Array(data));
                            vscode.postMessage({ type: 'sendData', value: arrayData });
                        });

                        peer.on('error', err => {
                            status.innerText = '에러: ' + err.message;
                            vscode.postMessage({ type: 'log', value: err.message });
                        });
                    }

                    hostBtn.addEventListener('click', () => {
                        initPeer(true);
                        connectionArea.style.display = 'block';
                        status.innerText = 'Offer 생성 중...';
                    });

                    joinBtn.addEventListener('click', () => {
                        initPeer(false);
                        connectionArea.style.display = 'block';
                        status.innerText = '상대방의 Offer를 입력하세요';
                    });

                    connectBtn.addEventListener('click', () => {
                        try {
                            const data = JSON.parse(remoteSdp.value);
                            peer.signal(data);
                        } catch (e) {
                            alert('SDP 형식이 올바르지 않습니다.');
                        }
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'peerData') {
                            // 일반 배열을 Uint8Array로 변환하여 전송 (문자열 변환 방지)
                            peer.send(new Uint8Array(message.value));
                        }
                    });
                </script>
            </body>
            </html>`;
    }
}
