export function getSidebarTemplate() {
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
                .file-item { padding: 8px 10px; cursor: pointer; border-radius: 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-divider); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
                .file-item:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
                .stop-btn { 
                    width: auto !important; 
                    margin: 0 !important; 
                    background: #d73a49; 
                    color: white; 
                    border: none; 
                    padding: 3px 10px; 
                    border-radius: 4px; 
                    font-size: 10px; 
                    cursor: pointer; 
                    font-weight: bold; 
                    opacity: 0.9;
                    line-height: 1.2;
                    flex-shrink: 0;
                }
                .stop-btn:hover { opacity: 1; background: #b31d28; }
                h4 { margin: 20px 0 10px 0; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
                #hostForm { background: var(--vscode-sideBar-background); padding: 15px; border-radius: 6px; border: 1px solid var(--vscode-divider); margin-top: 10px; }
            </style>
        </head>
        <body>
            <div id="loading" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh; color: var(--vscode-descriptionForeground);">
                <div style="font-size: 24px; margin-bottom: 10px;">📡</div>
                <div style="font-size: 11px; letter-spacing: 1px; text-transform: uppercase; animation: blink 1.5s infinite;">Initializing Engine...</div>
            </div>
            <style>@keyframes blink { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }</style>
            <div id="mainContent" class="hidden">
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
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                function showHostForm() { document.getElementById('hostForm').classList.remove('hidden'); document.getElementById('btnHost').classList.add('hidden'); document.getElementById('btnGuest').classList.add('hidden'); }
                function hideHostForm() { document.getElementById('hostForm').classList.add('hidden'); document.getElementById('btnHost').classList.remove('hidden'); document.getElementById('btnGuest').classList.remove('hidden'); }
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
                    if (m.type === 'renderState' || m.type === 'refresh') {
                        document.getElementById('loading').classList.add('hidden');
                        document.getElementById('mainContent').classList.remove('hidden');
                        if (m.type === 'refresh') return;
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
                                udiv.innerHTML += '<div class="user-item"><div class="user-name">' + nHTML + '</div><div class="badge-area">' + bHTML + '</div><div class="action-area">' + eHTML + '</div></div>';
                            });
                        } else if (m.isSetupMode) {
                            roleSel.classList.add('hidden'); connArea.classList.remove('hidden'); active.classList.add('hidden');
                            const isOffer = m.lastSdp && m.lastSdp.includes('offer');
                            roleDisp.innerText = 'ROLE: ' + (isOffer ? 'HOST' : 'GUEST');
                            lsdp.value = m.lastSdp || 'Generating...';
                        } else {
                            roleSel.classList.remove('hidden'); connArea.classList.add('hidden'); active.classList.add('hidden');
                            document.getElementById('setupRoomName').value = ''; lsdp.value = ''; document.getElementById('rsdp').value = '';
                            hideHostForm();
                        }
                        const fdiv = document.getElementById('files'); fdiv.innerHTML = '';
                        const isUserHost = m.lastSdp && m.lastSdp.includes('offer');
                        m.files.forEach(f => {
                            const item = document.createElement('div'); item.className = 'file-item';
                            const nameSpan = document.createElement('span');
                            nameSpan.innerText = '📄 ' + f.name; nameSpan.style.flex = '1';
                            nameSpan.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });
                            item.appendChild(nameSpan);
                            if (isUserHost) {
                                const stopBtn = document.createElement('button'); stopBtn.className = 'stop-btn'; stopBtn.innerText = 'Stop';
                                stopBtn.onclick = (e) => { 
                                    e.stopPropagation(); 
                                    vscode.postMessage({ type: 'stopFileSharing', fileName: f.name }); 
                                };
                                item.appendChild(stopBtn);
                            }
                            fdiv.appendChild(item);
                        });
                    }
                });
                vscode.postMessage({ type: 'ready' });
            </script></body></html>`;
}

export function getEngineTemplate(initiator: boolean) {
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
