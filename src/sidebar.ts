import * as vscode from 'vscode';

export class P2PCodeShareSidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _extensionUri: vscode.Uri) {}
    private _view?: vscode.WebviewView;
    private _hubPanel?: vscode.WebviewPanel;
    private _isConnected = false;
    private _sharedFiles: any[] = [];
    private _lastSdp = '';

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForSidebar();
        (webviewView as any).retainContextWhenHidden = true;

        this.updateSidebarState();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') this.updateSidebarState();
            else if (msg.type === 'initPeer') {
                this.onDidReceiveData?.(JSON.stringify({ type: 'SET_ROLE', isHost: msg.initiator }));
                this.createHub(msg.initiator);
            }
            else if (msg.type === 'cancel') this.resetAndNotify();
            else if (msg.type === 'signal' || msg.type === 'peerData') {
                if (this._hubPanel) this._hubPanel.webview.postMessage(msg);
                else this.resetAndNotify();
            }
            else if (msg.type === 'openFile') vscode.commands.executeCommand('p2p-code-share.openSnapshot', msg.path);
        });
    }

    private createHub(initiator: boolean) {
        if (this._hubPanel) this._hubPanel.dispose();
        
        this._hubPanel = vscode.window.createWebviewPanel('p2pHub', 'P2P Engine', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
        this._hubPanel.webview.html = this._getHtmlForHub(initiator);
        
        this._hubPanel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'sendData') this.onDidReceiveData?.(msg.value);
            else if (msg.type === 'statusUpdate') {
                this._isConnected = (msg.value === 'Connected');
                this.updateSidebarState();
            } else if (msg.type === 'sdpGenerated') {
                this._lastSdp = msg.sdp;
                this.updateSidebarState();
            }
        });

        this._hubPanel.onDidDispose(() => this.resetAndNotify());
    }

    private resetAndNotify() {
        if (this._hubPanel) { this._hubPanel.dispose(); this._hubPanel = undefined; }
        this._isConnected = false; this._sharedFiles = []; this._lastSdp = '';
        this.updateSidebarState();
        this.onDidReceiveData?.(JSON.stringify({ type: 'STOP_SHARING' }));
    }

    private updateSidebarState() {
        if (!this._view) return;
        this._view.webview.postMessage({ type: 'renderState', isConnected: this._isConnected, files: this._sharedFiles, lastSdp: this._lastSdp });
    }

    public onDidReceiveData?: (data: any) => void;
    public sendToWebview(message: any) {
        if (message.type === 'updateFileList') this._sharedFiles = message.files;
        this.updateSidebarState();
        this._hubPanel?.webview.postMessage(message);
    }

    private _getHtmlForSidebar() {
        return `<!DOCTYPE html><html><head><style>
            * { box-sizing: border-box; }
            body { font-family: sans-serif; padding: 15px; color: var(--vscode-foreground); line-height: 1.4; }
            .hidden { display: none !important; }
            button { width: 100%; margin-bottom: 10px; padding: 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-weight: 600; font-size: 13px; }
            button:hover { background: var(--vscode-button-hoverBackground); }
            .secondary-button { width: 100%; padding: 10px; cursor: pointer; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-background); border-radius: 4px; margin-top: 5px; opacity: 0.8; }
            textarea { width: 100%; height: 100px; margin-bottom: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; font-family: monospace; font-size: 11px; }
            .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; background: #6c757d; color: white; text-transform: uppercase; margin-bottom: 10px; display: inline-block; }
            .online { background: #28a745; }
            .file-item { padding: 12px; cursor: pointer; border-radius: 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-divider); margin-bottom: 8px; }
            .file-item:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
        </style></head><body>
            <div id="badge" class="badge">OFFLINE</div>
            <div id="setup">
                <button id="hBtn" onclick="init(true)">Create Sharing Room</button>
                <button id="gBtn" onclick="init(false)">Join Sharing Room</button>
                <div id="conn" class="hidden">
                    <p id="roleText" style="font-weight:bold; color:var(--vscode-charts-blue)"></p>
                    <p>Your Connection ID:</p><textarea id="lsdp" readonly></textarea>
                    <p>Partner's Connection ID:</p><textarea id="rsdp" placeholder="Paste here..."></textarea>
                    <button onclick="conn()" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">ESTABLISH CONNECTION</button>
                    <button onclick="goBack()" class="secondary-button">← Back to Role Selection</button>
                </div>
            </div>
            <div id="active" class="hidden"><h4>Active Snapshots</h4><div id="files"></div></div>
            <script>
                const vscode = acquireVsCodeApi();
                function init(i) { 
                    const lsdp = document.getElementById('lsdp');
                    const rsdp = document.getElementById('rsdp');
                    
                    lsdp.value = '';
                    rsdp.value = '';

                    vscode.postMessage({ type: 'initPeer', initiator: i }); 
                    document.getElementById('conn').classList.remove('hidden');
                    document.getElementById('hBtn').classList.add('hidden');
                    document.getElementById('gBtn').classList.add('hidden');
                    document.getElementById('roleText').innerText = i ? 'ROLE: HOST' : 'ROLE: GUEST';
                    
                    if(i) {
                        lsdp.value = 'Generating Connection ID...';
                    } else {
                        lsdp.placeholder = 'Your Connection ID will appear here after you paste the Partner ID and click Connect...';
                    }
                }
                function conn() { vscode.postMessage({ type: 'signal', sdp: JSON.parse(document.getElementById('rsdp').value) }); }
                function goBack() { vscode.postMessage({ type: 'cancel' }); }
                window.addEventListener('message', e => {
                    const m = e.data;
                    if (m.type === 'sdpGenerated') { document.getElementById('lsdp').value = m.sdp; }
                    if (m.type === 'renderState') {
                        const b = document.getElementById('badge');
                        b.innerText = m.isConnected ? 'CONNECTED' : 'OFFLINE';
                        b.className = 'badge ' + (m.isConnected ? 'online' : '');
                        if (m.isConnected) { document.getElementById('setup').classList.add('hidden'); document.getElementById('active').classList.remove('hidden'); }
                        else {
                            document.getElementById('setup').classList.remove('hidden'); document.getElementById('active').classList.add('hidden');
                            if (m.lastSdp) {
                                document.getElementById('lsdp').value = m.lastSdp;
                                document.getElementById('conn').classList.remove('hidden');
                                document.getElementById('hBtn').classList.add('hidden');
                                document.getElementById('gBtn').classList.add('hidden');
                                document.getElementById('roleText').innerText = m.lastSdp.includes('offer') ? 'ROLE: HOST' : 'ROLE: GUEST';
                            } else {
                                document.getElementById('conn').classList.add('hidden');
                                document.getElementById('hBtn').classList.remove('hidden');
                                document.getElementById('gBtn').classList.remove('hidden');
                            }
                        }
                        const fdiv = document.getElementById('files'); fdiv.innerHTML = '';
                        m.files.forEach(f => {
                            const item = document.createElement('div');
                            item.className = 'file-item'; item.innerText = '📄 ' + f.name;
                            item.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });
                            fdiv.appendChild(item);
                        });
                    }
                });
                vscode.postMessage({ type: 'ready' });
            </script></body></html>`;
    }

    private _getHtmlForHub(initiator: boolean) {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:20px;">
            <h3>P2P Engine Status</h3>
            <div id="status" style="color:blue">Initializing Engine...</div>
            <div id="log" style="font-size:12px; margin-top:10px; color:gray"></div>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const st = document.getElementById('status');
                const logDiv = document.getElementById('log');
                function log(m) { logDiv.innerHTML += '<div>> ' + m + '</div>'; }

                try {
                    log('SimplePeer version: ' + (typeof SimplePeer !== 'undefined' ? 'Loaded' : 'FAILED'));
                    const peer = new SimplePeer({ initiator: ${initiator}, trickle: false, config: { iceServers: [] } });
                    
                    st.innerText = 'Engine Started. Waiting for Signal...';
                    log('Role: ' + (${initiator} ? 'HOST' : 'GUEST'));

                    peer.on('signal', data => {
                        log('Signal generated! (SDP)');
                        st.innerText = 'SDP Generated. Copy it from sidebar.';
                        vscode.postMessage({ type: 'sdpGenerated', sdp: JSON.stringify(data) });
                    });

                    peer.on('connect', () => {
                        st.innerText = 'CONNECTED!';
                        log('P2P Link established');
                        vscode.postMessage({ type: 'statusUpdate', value: 'Connected' });
                    });

                    peer.on('data', data => {
                        const raw = new Uint8Array(data);
                        if (raw.length !== 1 || raw[0] !== 255) vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw) });
                    });

                    peer.on('error', err => {
                        st.innerText = 'ERROR Occurred';
                        st.style.color = 'red';
                        log('Peer Error: ' + err.message);
                    });

                    window.addEventListener('message', e => {
                        const m = e.data;
                        if (m.type === 'signal') { peer.signal(m.sdp); log('Partner signal applied.'); }
                        if (m.type === 'peerData') if(peer && peer.connected) peer.send(new TextEncoder().encode(JSON.stringify(m.value)));
                    });
                    setInterval(() => { if(peer && peer.connected) peer.send(new Uint8Array([255])); }, 5000);
                } catch(e) {
                    st.innerText = 'CRITICAL ERROR';
                    log('Global Error: ' + e.message);
                }
            </script></body></html>`;
    }
}
