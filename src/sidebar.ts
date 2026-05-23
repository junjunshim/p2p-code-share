import * as vscode from 'vscode';

export class P2PCodeShareSidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly _extensionUri: vscode.Uri) {}
    private _view?: vscode.WebviewView;
    private _hubPanel?: vscode.WebviewPanel;
    private _isConnected = false;
    private _sharedFiles: any[] = [];
    private _lastSdp = '';
    private _isSetupMode = false;
    private _participants: any = { myName: '', others: {} };
    private _roomName = '';

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForSidebar();
        (webviewView as any).retainContextWhenHidden = true;

        this.updateSidebarState();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') this.updateSidebarState();
            else if (msg.type === 'initPeer') {
                this._isSetupMode = true;
                this._roomName = msg.roomName || '';
                this.onDidReceiveData?.(JSON.stringify({ type: 'SET_ROLE', isHost: msg.initiator, roomName: this._roomName }));
                this.createHub(msg.initiator);
                this.updateSidebarState();
            }
            else if (msg.type === 'cancel') this.resetAndNotify();
            else if (msg.type === 'signal' || msg.type === 'peerData') {
                if (this._hubPanel) this._hubPanel.webview.postMessage(msg);
            } 
            else if (msg.type === 'openFile') vscode.commands.executeCommand('p2p-code-share.openSnapshot', msg.path);
            else if (msg.type === 'rename') vscode.commands.executeCommand('p2p-code-share.renameUser');
        });
    }

    private createHub(initiator: boolean) {
        if (this._hubPanel) { try { this._hubPanel.dispose(); } catch(e) {} }
        this._hubPanel = vscode.window.createWebviewPanel('p2pHub', 'P2P Engine', vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
        this._hubPanel.webview.html = this._getHtmlForHub(initiator);
        this._hubPanel.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'sendData') this.onDidReceiveData?.(msg.value);
            else if (msg.type === 'statusUpdate') {
                this._isConnected = (msg.value === 'Connected');
                if (this._isConnected) {
                    this._isSetupMode = false;
                    this.onDidReceiveData?.(JSON.stringify({ type: 'ON_CONNECTED' }));
                }
                this.updateSidebarState();
            } else if (msg.type === 'sdpGenerated') {
                this._lastSdp = msg.sdp;
                this.updateSidebarState();
            }
        });
        this._hubPanel.onDidDispose(() => {
            if (this._hubPanel === undefined) return;
            this.resetAndNotify();
        });
    }

    private resetAndNotify() {
        if (this._hubPanel) { this._hubPanel.dispose(); this._hubPanel = undefined; }
        this._isConnected = false; this._isSetupMode = false;
        this._sharedFiles = []; this._lastSdp = ''; this._roomName = '';
        this._participants = { myName: '', others: {} };
        this.updateSidebarState();
        this.onDidReceiveData?.(JSON.stringify({ type: 'STOP_SHARING' }));
    }

    private updateSidebarState() {
        if (!this._view) return;
        this._view.webview.postMessage({ 
            type: 'renderState', 
            isConnected: this._isConnected, 
            isSetupMode: this._isSetupMode, 
            files: this._sharedFiles, 
            lastSdp: this._lastSdp,
            participants: this._participants,
            roomName: this._roomName
        });
    }

    public onDidReceiveData?: (data: any) => void;
    public sendToWebview(message: any) {
        if (message.type === 'updateFileList') this._sharedFiles = message.files;
        if (message.type === 'renderParticipants') {
            this._participants = message;
            if (message.roomName) this._roomName = message.roomName;
        }
        this.updateSidebarState();
        this._hubPanel?.webview.postMessage(message);
    }

    private _getHtmlForSidebar() {
        return `<!DOCTYPE html><html><head>
            <style>
                * { box-sizing: border-box; }
                body { font-family: sans-serif; padding: 15px; color: var(--vscode-foreground); line-height: 1.4; }
                .hidden { display: none !important; }
                button { width: 100%; margin-bottom: 10px; padding: 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-weight: 600; font-size: 13px; transition: background 0.2s; }
                button:hover { background: var(--vscode-button-hoverBackground); }
                .secondary-button { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-background); margin-top: 5px; opacity: 0.8; width: 100%; padding: 10px; cursor: pointer; border-radius: 4px; }
                textarea { width: 100%; height: 80px; margin-bottom: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; font-family: monospace; font-size: 11px; }
                input { width: 100%; padding: 10px; margin-bottom: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
                .badge { padding: 4px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; background: #6c757d; color: white; text-transform: uppercase; align-self: flex-start; margin-bottom: 10px; display: inline-block; }
                .online { background: #28a745; }
                .room-info { margin: 10px 0; padding: 12px; background: var(--vscode-editor-background); border-left: 4px solid var(--vscode-charts-blue); border-radius: 4px; }
                .room-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
                .room-value { font-weight: bold; font-size: 14px; color: var(--vscode-charts-blue); }
                .user-item { padding: 10px; border-radius: 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-divider); margin-bottom: 5px; font-size: 12px; display: flex; align-items: center; gap: 8px; }
                .user-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .badge-area { width: 50px; display: flex; justify-content: center; flex-shrink: 0; }
                .action-area { width: 35px; text-align: right; flex-shrink: 0; }
                .me-badge { background: #28a745; color: white; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold; }
                .host-badge { background: #d73a49; color: white; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold; }
                .edit-name { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 10px; }
                .file-item { padding: 12px; cursor: pointer; border-radius: 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-divider); margin-bottom: 8px; }
                .file-item:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
                h4 { margin: 20px 0 10px 0; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
                #hostForm { background: var(--vscode-sideBar-background); padding: 15px; border-radius: 6px; border: 1px solid var(--vscode-divider); margin-top: 10px; }
            </style>
        </head>
        <body>
            <div id="badge" class="badge">OFFLINE</div>
            <div id="setup">
                <div id="roleSelection">
                    <button id="btnHost" onclick="showHostForm()">Create Sharing Room</button>
                    <button id="btnGuest" onclick="init(false)">Join Sharing Room</button>
                    
                    <div id="hostForm" class="hidden">
                        <p class="room-label">Set Room Name</p>
                        <input type="text" id="setupRoomName" placeholder="e.g. My Project Room">
                        <button onclick="init(true)" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">START ENGINE</button>
                        <button onclick="hideHostForm()" class="secondary-button">Cancel</button>
                    </div>
                </div>
                <div id="connArea" class="hidden">
                    <p id="roleTextDisp" style="font-weight:bold; color:var(--vscode-charts-blue)"></p>
                    <p>Your Connection ID:</p><textarea id="lsdp" readonly></textarea>
                    <p>Partner's Connection ID:</p><textarea id="rsdp" placeholder="Paste here..."></textarea>
                    <button onclick="conn()" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">ESTABLISH CONNECTION</button>
                    <button onclick="goBack()" class="secondary-button">← Back</button>
                </div>
            </div>
            <div id="active" class="hidden">
                <div class="room-info"><div class="room-label">Room Name</div><div id="dispRoomName" class="room-value"></div></div>
                <h4>Connected Users</h4><div id="users"></div>
                <h4>Active Snapshots</h4><div id="files"></div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                
                function showHostForm() {
                    document.getElementById('hostForm').classList.remove('hidden');
                    document.getElementById('btnHost').classList.add('hidden');
                    document.getElementById('btnGuest').classList.add('hidden');
                }

                function hideHostForm() {
                    document.getElementById('hostForm').classList.add('hidden');
                    document.getElementById('btnHost').classList.remove('hidden');
                    document.getElementById('btnGuest').classList.remove('hidden');
                }

                function init(i) { 
                    let rn = '';
                    if(i) {
                        rn = document.getElementById('setupRoomName').value.trim();
                        if (!rn) { alert('Please enter a room name first!'); return; }
                    }
                    document.getElementById('lsdp').value = ''; document.getElementById('rsdp').value = '';
                    vscode.postMessage({ type: 'initPeer', initiator: i, roomName: rn }); 
                }

                function conn() { vscode.postMessage({ type: 'signal', sdp: JSON.parse(document.getElementById('rsdp').value) }); }
                function goBack() { vscode.postMessage({ type: 'cancel' }); }
                function rename() { vscode.postMessage({ type: 'rename' }); }

                window.addEventListener('message', e => {
                    const m = e.data;
                    if (m.type === 'sdpGenerated') { document.getElementById('lsdp').value = m.sdp; }
                    if (m.type === 'renderState') {
                        const b = document.getElementById('badge');
                        const roleSel = document.getElementById('roleSelection');
                        const connArea = document.getElementById('connArea');
                        const active = document.getElementById('active');
                        const roleDisp = document.getElementById('roleTextDisp');
                        const dispRoom = document.getElementById('dispRoomName');
                        const lsdp = document.getElementById('lsdp');
                        
                        b.innerText = m.isConnected ? 'CONNECTED' : 'OFFLINE';
                        b.className = 'badge ' + (m.isConnected ? 'online' : '');
                        
                        if (m.isConnected) {
                            roleSel.classList.add('hidden'); connArea.classList.add('hidden'); active.classList.remove('hidden');
                            dispRoom.innerText = m.roomName || 'Untitled Room';
                            const udiv = document.getElementById('users'); udiv.innerHTML = '';
                            Object.entries(m.participants.others).forEach(([id, name]) => {
                                const isMe = (id === (m.lastSdp && m.lastSdp.includes('offer') ? 'host' : 'guest'));
                                const isHost = (id === 'host');
                                const bHTML = isMe ? '<span class="me-badge">ME</span>' : (isHost ? '<span class="host-badge">HOST</span>' : '');
                                const nHTML = isMe ? '<b>' + name + '</b>' : name;
                                const eHTML = isMe ? '<span class="edit-name" onclick="rename()">Edit</span>' : '';
                                
                                udiv.innerHTML += '<div class="user-item">' +
                                    '<div class="user-name">' + nHTML + '</div>' +
                                    '<div class="badge-area">' + bHTML + '</div>' +
                                    '<div class="action-area">' + eHTML + '</div>' +
                                    '</div>';
                            });
                        } else if (m.isSetupMode) {
                            roleSel.classList.add('hidden'); connArea.classList.remove('hidden'); active.classList.add('hidden');
                            const isOffer = m.lastSdp && m.lastSdp.includes('offer');
                            roleDisp.innerText = 'ROLE: ' + (isOffer ? 'HOST' : 'GUEST');
                            lsdp.value = m.lastSdp || 'Generating...';
                        } else {
                            roleSel.classList.remove('hidden'); connArea.classList.add('hidden'); active.classList.add('hidden');
                            hideHostForm();
                        }
                        const fdiv = document.getElementById('files'); fdiv.innerHTML = '';
                        m.files.forEach(f => {
                            const item = document.createElement('div'); item.className = 'file-item'; item.innerText = '📄 ' + f.name;
                            item.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });
                            fdiv.appendChild(item);
                        });
                    }
                });
                vscode.postMessage({ type: 'ready' });
            </script></body></html>`;
    }

    private _getHtmlForHub(initiator: boolean) {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:20px; background: #1e1e1e; color: #ccc; line-height: 1.5;">
            <h2 style="color: #569cd6; margin-top: 0;">📡 P2P Engine</h2>
            <div style="margin-bottom: 10px;"><span style="font-weight: bold; color: #9cdcfe;">Status :</span> <span id="st" style="color:#ce9178;">Initializing...</span></div>
            <hr style="border: 0; border-top: 1px solid #444; margin: 15px 0;"><div id="log" style="font-size:12px; color:#858585; font-family: 'Courier New', monospace;"></div>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const st = document.getElementById('st');
                const logDiv = document.getElementById('log');
                function log(m) { 
                    const entry = document.createElement('div');
                    entry.innerText = '> ' + new Date().toLocaleTimeString() + ' - ' + m;
                    logDiv.prepend(entry);
                }
                try {
                    const peer = new SimplePeer({ initiator: ${initiator}, trickle: false, config: { iceServers: [] } });
                    st.innerText = 'Engine Started. Waiting for Signal...';
                    peer.on('signal', data => { log('Signal generated.'); vscode.postMessage({ type: 'sdpGenerated', sdp: JSON.stringify(data) }); });
                    peer.on('connect', () => { 
                        st.innerText = 'CONNECTED!'; st.style.color = '#4ec9b0';
                        log('SUCCESS: P2P Data Channel established.');
                        vscode.postMessage({ type: 'statusUpdate', value: 'Connected' }); 
                    });
                    peer.on('data', data => {
                        const raw = new Uint8Array(data);
                        if (raw.length !== 1 || raw[0] !== 255) {
                            log('RECEIVE: Data received');
                            vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw) });
                        }
                    });
                    peer.on('error', err => { st.innerText = 'PEER ERROR'; log('ERROR: ' + err.message); vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected' }); });
                    window.addEventListener('message', e => {
                        const m = e.data;
                        if (m.type === 'signal') { peer.signal(m.sdp); log('Partner signal applied.'); }
                        if (m.type === 'peerData') if(peer && peer.connected) peer.send(new TextEncoder().encode(JSON.stringify(m.value)));
                    });
                    setInterval(() => { if(peer && peer.connected) peer.send(new Uint8Array([255])); }, 5000);
                } catch(e) { log('Fatal: ' + e.message); }
            </script></body></html>`;
    }
}
