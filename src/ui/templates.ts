export function getSidebarTemplate() {
    return `<!DOCTYPE html><html><head>
            <style>
                * { box-sizing: border-box; }
                body { font-family: sans-serif; padding: 15px; color: var(--vscode-foreground); line-height: 1.4; }
                .hidden { display: none !important; }
                button { width: 100%; margin-bottom: 10px; padding: 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-weight: 600; font-size: 13px; transition: background 0.2s; }
                button:hover { background: var(--vscode-button-hoverBackground); }
                .secondary-button { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-background); margin-top: 5px; opacity: 0.8; width: 100%; padding: 10px; cursor: pointer; border-radius: 4px; }
                .secondary-button:disabled { opacity: 0.4; cursor: not-allowed; }
                button:disabled { opacity: 0.5; cursor: not-allowed; }
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
                .stop-btn { width: auto !important; margin: 0 !important; background: #d73a49; color: white; border: none; padding: 3px 10px; border-radius: 4px; font-size: 10px; cursor: pointer; font-weight: bold; opacity: 0.9; line-height: 1.2; flex-shrink: 0; }
                .stop-btn:hover { opacity: 1; background: #b31d28; }
                h4 { margin: 20px 0 10px 0; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }
                .invite-btn { color: var(--vscode-charts-blue); cursor: pointer; font-size: 18px; font-weight: bold; padding: 0 5px; }
                .invite-btn:hover { opacity: 0.7; }
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
                        <div id="startButtons">
                            <button id="btnHost" onclick="showHostForm()">Create Sharing Room</button>
                            <button id="btnGuest" onclick="showGuestForm()">Join Sharing Room</button>
                        </div>
                        <div id="hostForm" class="hidden">
                            <p class="room-label">Set Room Name (for easy P2P)</p>
                            <input type="text" id="setupRoomName" placeholder="e.g. My Project Room">
                            <button id="btnStartHost" onclick="init(true)" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">START ENGINE</button>
                            <div id="hostLoading" class="hidden" style="text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                                <span style="display: inline-block; animation: blink 1s infinite;">📡</span> Connecting to server...
                            </div>
                            <button id="btnCancelHost" onclick="goBack()" class="secondary-button">Cancel</button>
                        </div>
                        <div id="guestForm" class="hidden">
                            <p class="room-label">Enter Room Name (to join automatically)</p>
                            <input type="text" id="joinRoomName" placeholder="Enter Host's Room Name">
                            <button id="btnJoinAuto" onclick="init(false)" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">JOIN AUTOMATICALLY</button>
                            <div id="guestLoading" class="hidden" style="text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                                <span style="display: inline-block; animation: blink 1s infinite;">📡 Joining the </span> <span id="joiningRoomText"></span>
                            </div>
                            <button id="btnJoinManual" onclick="initManualGuest()" class="secondary-button">Manual Connection (SDP)</button>
                            <button id="btnCancelGuest" onclick="goBack()" class="secondary-button">Cancel</button>
                        </div>
                    </div>
                </div>
                <div id="connArea" class="hidden">
                    <input type="hidden" id="activePeerId" value="">
                    <p id="roleTextDisp" style="font-weight:bold; color:var(--vscode-charts-blue)"></p>
                    <p>Connection ID (Share this):</p><textarea id="lsdp" readonly></textarea>
                    <p>Partner's Reply (Paste here):</p><textarea id="rsdp" placeholder="Paste here..."></textarea>
                    <button onclick="conn()" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">ESTABLISH CONNECTION</button>
                    <button id="btnCancelInvite" onclick="goBack()" class="secondary-button">← Back</button>
                </div>
                <div id="active" class="hidden">
                    <div class="room-info"><div class="room-label">Room Name</div><div id="dispRoomName" class="room-value"></div></div>
                    <h4><span>Connected Users</span><span id="btnAddUser" class="invite-btn" onclick="invite()">+</span></h4>
                    <div id="users"></div>
                    <h4>Active Snapshots</h4><div id="files"></div>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();

                function showHostForm() { 
                    document.getElementById('hostForm').classList.remove('hidden'); 
                    document.getElementById('startButtons').classList.add('hidden'); 
                }
                function showGuestForm() { 
                    document.getElementById('guestForm').classList.remove('hidden'); 
                    document.getElementById('startButtons').classList.add('hidden'); 
                }
                function resetForms() {
                    document.getElementById('hostForm').classList.add('hidden'); 
                    document.getElementById('guestForm').classList.add('hidden'); 
                    document.getElementById('startButtons').classList.remove('hidden'); 
                    
                    // 로딩 및 버튼 상태 초기화
                    if (document.getElementById('btnStartHost')) document.getElementById('btnStartHost').disabled = false;
                    if (document.getElementById('btnJoinAuto')) document.getElementById('btnJoinAuto').disabled = false;
                    if (document.getElementById('btnJoinManual')) document.getElementById('btnJoinManual').disabled = false;
                    if (document.getElementById('btnCancelHost')) document.getElementById('btnCancelHost').disabled = false;
                    if (document.getElementById('btnCancelGuest')) document.getElementById('btnCancelGuest').disabled = false;
                    if (document.getElementById('hostLoading')) document.getElementById('hostLoading').classList.add('hidden');
                    if (document.getElementById('guestLoading')) document.getElementById('guestLoading').classList.add('hidden');
                }

                function init(i) { 
                    let rn = '';
                    if(i) {
                        rn = document.getElementById('setupRoomName').value.trim();
                        if (!rn) { alert('Please enter a room name first!'); return; }
                        // 호스트: 버튼 비활성화 및 로딩 표시
                        document.getElementById('btnStartHost').disabled = true;
                        document.getElementById('btnCancelHost').disabled = true;
                        document.getElementById('hostLoading').classList.remove('hidden');
                    } else {
                        rn = document.getElementById('joinRoomName').value.trim();
                        if (!rn) { alert('Please enter the host room name!'); return; }
                        // 게스트: 버튼 비활성화 및 참여 중 메시지 표시 (Cancel 버튼은 활성 유지)
                        document.getElementById('btnJoinAuto').disabled = true;
                        document.getElementById('btnJoinManual').disabled = true;
                        document.getElementById('joiningRoomText').innerText = '"' + rn + '"';
                        document.getElementById('guestLoading').classList.remove('hidden');
                    }
                    document.getElementById('activePeerId').value = i ? 'none' : 'default';
                    document.getElementById('lsdp').value = ''; 
                    document.getElementById('rsdp').value = '';
                    vscode.postMessage({ type: 'initPeer', initiator: i, roomName: rn }); 
                }

                function initManualGuest() {
                    document.getElementById('activePeerId').value = 'default';
                    document.getElementById('lsdp').value = ''; 
                    document.getElementById('rsdp').value = '';
                    vscode.postMessage({ type: 'initPeer', initiator: false, roomName: '' }); 
                }

                function invite() { 
                    document.getElementById('lsdp').value = 'Generating...'; 
                    document.getElementById('rsdp').value = '';
                    // invite 시에는 activePeerId를 SyncEngine이 업데이트해줄 때까지 기다림
                    vscode.postMessage({ type: 'inviteGuest' }); 
                }

                function conn() { 
                    const sdpText = document.getElementById('rsdp').value;
                    const peerId = document.getElementById('activePeerId').value;
                    if (!peerId || peerId === 'none') { alert('Error: Target Peer ID not identified.'); return; }
                    try {
                        const sdp = JSON.parse(sdpText);
                        vscode.postMessage({ type: 'signal', sdp: sdp, peerId: peerId }); 
                    } catch(e) { alert('Invalid Connection ID format!'); }
                }

                function goBack() { vscode.postMessage({ type: 'cancel', isInviting: document.getElementById('badge').innerText === 'CONNECTED' }); }
                function rename() { vscode.postMessage({ type: 'rename' }); }

                window.addEventListener('message', e => {
                    const m = e.data;
                    if (m.type === 'sdpGenerated') { 
                        document.getElementById('lsdp').value = m.sdp; 
                        document.getElementById('activePeerId').value = m.peerId || 'default';
                    }
                    if (m.type === 'renderState' || m.type === 'refresh') {
                        // 로딩 및 버튼 상태 초기화
                        if (document.getElementById('btnStartHost')) document.getElementById('btnStartHost').disabled = false;
                        if (document.getElementById('btnCancelHost')) document.getElementById('btnCancelHost').disabled = false;
                        if (document.getElementById('btnJoinAuto')) document.getElementById('btnJoinAuto').disabled = false;
                        if (document.getElementById('btnJoinManual')) document.getElementById('btnJoinManual').disabled = false;
                        if (document.getElementById('btnCancelGuest')) document.getElementById('btnCancelGuest').disabled = false;
                        if (document.getElementById('hostLoading')) document.getElementById('hostLoading').classList.add('hidden');
                        if (document.getElementById('guestLoading')) document.getElementById('guestLoading').classList.add('hidden');
                        
                        document.getElementById('loading').classList.add('hidden');
                        document.getElementById('mainContent').classList.remove('hidden');
                        if (m.type === 'refresh') return;
                        
                        // [핵심 로직 교정]
                        if (m.participants.invitingPeerId) {
                            document.getElementById('activePeerId').value = m.participants.invitingPeerId;
                        } else if (!m.isConnected) {
                            // 아직 아무것도 연결 안 된 게스트만 default
                            if (m.participants.myId !== 'host') document.getElementById('activePeerId').value = 'default';
                        }
                        
                        const b = document.getElementById('badge');
                        const roleSel = document.getElementById('roleSelection');
                        const connArea = document.getElementById('connArea');
                        const active = document.getElementById('active');
                        const roleDisp = document.getElementById('roleTextDisp');
                        const dispRoom = document.getElementById('dispRoomName');
                        const lsdp = document.getElementById('lsdp');
                        const btnAddUser = document.getElementById('btnAddUser');
                        
                        b.innerText = m.isConnected ? 'CONNECTED' : 'OFFLINE';
                        b.className = 'badge ' + (m.isConnected ? 'online' : '');
                        
                        if (m.isSetupMode) {
                            roleSel.classList.add('hidden'); connArea.classList.remove('hidden'); active.classList.add('hidden');
                            if (m.invitingSdp) { lsdp.value = m.invitingSdp; }
                            const isOffer = lsdp.value && (lsdp.value.includes('offer') || lsdp.value === 'Generating...');
                            roleDisp.innerText = isOffer ? 'INVITING NEW GUEST' : 'JOINING ROOM';
                        } else if (m.isConnected) {
                            roleSel.classList.add('hidden'); connArea.classList.add('hidden'); active.classList.remove('hidden');
                            dispRoom.innerText = m.roomName || 'Untitled Room';
                            btnAddUser.classList.toggle('hidden', m.participants.myId !== 'host');
                            const udiv = document.getElementById('users'); udiv.innerHTML = '';
                            const myId = m.participants.myId;
                            Object.entries(m.participants.others).forEach(([id, name]) => {
                                const isMe = (id === myId || (id === 'default' && myId !== 'host'));
                                const isHost = (id === 'host');
                                const bHTML = isMe ? '<span class="me-badge">ME</span>' : (isHost ? '<span class="host-badge">HOST</span>' : '');
                                const nHTML = isMe ? '<b>' + name + '</b>' : name;
                                const eHTML = isMe ? '<span class="edit-name" onclick="rename()">Edit</span>' : '';
                                udiv.innerHTML += '<div class="user-item"><div class="user-name">' + nHTML + '</div><div class="badge-area">' + bHTML + '</div><div class="action-area">' + eHTML + '</div></div>';
                            });
                        } else if (m.participants.myId === 'host') {
                            roleSel.classList.remove('hidden'); connArea.classList.add('hidden'); active.classList.add('hidden');
                            document.getElementById('startButtons').classList.add('hidden');
                            document.getElementById('hostForm').classList.remove('hidden');
                            document.getElementById('btnStartHost').disabled = true;
                            document.getElementById('btnCancelHost').disabled = true;
                            document.getElementById('hostLoading').classList.remove('hidden');
                        } else if (!m.isConnected && !m.isSetupMode && m.roomName && m.participants.myId !== 'host') {
                            // [핵심 추가] 게스트가 자동 참여 중인 경우 (방 이름이 있고 아직 연결/설정 모드가 아님)
                            roleSel.classList.remove('hidden'); connArea.classList.add('hidden'); active.classList.add('hidden');
                            document.getElementById('startButtons').classList.add('hidden');
                            document.getElementById('guestForm').classList.remove('hidden');
                            document.getElementById('btnJoinAuto').disabled = true;
                            document.getElementById('btnJoinManual').disabled = true;
                            // 게스트는 연결 시도 중에도 취소할 수 있도록 유지
                            document.getElementById('btnCancelGuest').disabled = false;
                            document.getElementById('joiningRoomText').innerText = '"' + m.roomName + '"';
                            document.getElementById('guestLoading').classList.remove('hidden');
                        } else {
                            roleSel.classList.remove('hidden'); connArea.classList.add('hidden'); active.classList.add('hidden');
                            document.getElementById('setupRoomName').value = ''; 
                            document.getElementById('joinRoomName').value = ''; 
                            lsdp.value = ''; document.getElementById('rsdp').value = '';
                            resetForms();
                        }
                        const fdiv = document.getElementById('files'); fdiv.innerHTML = '';
                        const isUserHost = m.participants.myId === 'host';
                        m.files.forEach(f => {
                            const item = document.createElement('div'); item.className = 'file-item';
                            const nameSpan = document.createElement('span');
                            nameSpan.innerText = '📄 ' + f.name; nameSpan.style.flex = '1';
                            nameSpan.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });
                            item.appendChild(nameSpan);
                            if (isUserHost) {
                                const stopBtn = document.createElement('button'); stopBtn.className = 'stop-btn'; stopBtn.innerText = 'Stop';
                                stopBtn.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'stopFileSharing', fileName: f.name }); };
                                item.appendChild(stopBtn);
                            }
                            fdiv.appendChild(item);
                        });
                    }
                });
                vscode.postMessage({ type: 'ready' });
            </script></body></html>`;
}

export function getEngineTemplate(initiator: boolean, autoStart: boolean = true, roomName: string = '') {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:20px; background: #1e1e1e; color: #ccc; line-height: 1.5;">
            <h2 style="color: #569cd6; margin-top: 0;">📡 P2P Engine</h2>
            <div style="margin-bottom: 10px;"><span style="font-weight: bold; color: #9cdcfe;">Status :</span> <span id="st" style="color:#ce9178;">Initializing...</span></div>
            <hr style="border: 0; border-top: 1px solid #444; margin: 15px 0;"><div id="log" style="font-size:12px; color:#858585; font-family: 'Courier New', monospace;"></div>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
            <script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
            <script>
                const vscode = acquireVsCodeApi();
                const st = document.getElementById('st');
                const logDiv = document.getElementById('log');
                const peers = {};
                const pendingSdpMap = {}; // peerId -> sdp (신호 자동 전달용)
                const remotePeerIdMap = {}; // 로컬ID -> 원격ID 매핑
                let peerServer = null;
                let activeSignalingConn = null;

                function log(m) { 
                    const entry = document.createElement('div');
                    entry.innerText = '> ' + new Date().toLocaleTimeString() + ' - ' + m;
                    logDiv.prepend(entry);
                }

                // --- PeerJS Signaling Server (복사/붙여넣기 자동화 도우미) ---
                if ("${roomName}") {
                    const rName = "${roomName}";
                    // 한글 등 비 ASCII 문자를 지원하기 위해 ID를 Hex로 안전하게 변환
                    const toSafeId = (n) => 'p2p_room_' + Array.from(n).map(c => c.charCodeAt(0).toString(16)).join('');
                    const pjsId = ${initiator} ? toSafeId(rName) : null;
                    peerServer = new Peer(pjsId);
                    
                    peerServer.on('open', (id) => {
                        log('Auto-Signaling Server Ready. ID: ' + id);
                        if (${initiator}) {
                            // 호스트: 방 이름 선점 성공 알림
                            vscode.postMessage({ type: 'roomNameSuccess' });
                        }
                        if (!${initiator}) {
                            log('Attempting auto-connect to: ' + rName);
                            const conn = peerServer.connect(toSafeId(rName));
                            handleSignalingConn(conn);
                        }
                    });

                    peerServer.on('connection', (conn) => {
                        log('A guest contacted via Auto-Signaling.');
                        handleSignalingConn(conn);
                    });

                    peerServer.on('error', (err) => {
                        log('Auto-Signaling Error: ' + err.type);
                        if (${initiator}) {
                            // 호스트: 방 이름 중복 또는 서버 연결 실패 알림
                            let errorType = 'unknown';
                            if (err.type === 'unavailable-id') errorType = 'duplicate';
                            else if (err.type === 'server-error' || err.type === 'network') errorType = 'server';
                            
                            vscode.postMessage({ type: 'roomNameError', errorType: errorType });
                        }
                    });
                }

                function handleSignalingConn(conn) {
                    activeSignalingConn = conn;
                    conn.on('open', () => {
                        log('Signaling channel opened with peer.');
                        if (!${initiator}) {
                            // 게스트: 호스트에게 대기 중인 초대(Offer)가 있는지 물어봄
                            conn.send({ type: 'REQ_OFFER' });
                        }
                    });

                    conn.on('data', (data) => {
                        if (data.type === 'REQ_OFFER') {
                            // 호스트: 대기 중인 (연결되지 않은) Simple-Peer의 신호를 찾아서 보냄
                            const targetId = Object.keys(peers).find(id => !peers[id].connected && peers[id].initiator);
                            if (targetId && pendingSdpMap[targetId]) {
                                log('Auto-sending Offer for ' + targetId);
                                conn.send({ type: 'SDP', sdp: pendingSdpMap[targetId], peerId: targetId });
                            } else {
                                log('No pending invitations. Requesting auto-invite from host...');
                                vscode.postMessage({ type: 'requireInvite' });
                            }
                        } else if (data.type === 'SDP') {
                            const targetId = ${initiator} ? data.peerId : 'default';
                            
                            // [방어 로직] 이미 연결된 피어에게 새로운 신호를 적용하지 않음
                            if (peers[targetId] && peers[targetId].connected) {
                                log('Signal ignored: Peer ' + targetId + ' is already connected.');
                                return;
                            }

                            log('Received SDP via Auto-Signaling for: ' + data.peerId);
                            if (!${initiator}) {
                                remotePeerIdMap['default'] = data.peerId;
                            }
                            
                            const m = { type: 'signal', sdp: data.sdp, peerId: targetId };
                            window.dispatchEvent(new MessageEvent('message', { data: m }));
                        }
                    });

                    conn.on('close', () => {
                        if (activeSignalingConn === conn) activeSignalingConn = null;
                    });
                }

                function addPeer(peerId, isInitiator) {
                    if (peers[peerId]) return;
                    try {
                        const p = new SimplePeer({ 
                            initiator: isInitiator, 
                            trickle: false, 
                            config: { 
                                iceServers: [
                                    { urls: 'stun:stun.l.google.com:19302' },
                                    { urls: 'stun:stun1.l.google.com:19302' },
                                    { urls: 'stun:stun2.l.google.com:19302' }
                                ] 
                            } 
                        });
                        
                        p.on('signal', data => { 
                            const sdpStr = JSON.stringify(data);
                            pendingSdpMap[peerId] = sdpStr;
                            log('Signal generated for: ' + peerId); 
                            
                            vscode.postMessage({ type: 'sdpGenerated', sdp: sdpStr, peerId }); 
                            
                            if (activeSignalingConn && activeSignalingConn.open) {
                                log('Auto-forwarding signal via PeerJS...');
                                const outgoingPeerId = remotePeerIdMap[peerId] || peerId;
                                activeSignalingConn.send({ type: 'SDP', sdp: sdpStr, peerId: outgoingPeerId });
                            }
                        });

                        p.on('connect', () => { 
                            st.innerText = 'CONNECTED!'; st.style.color = '#4ec9b0';
                            log('SUCCESS: Connection established with ' + peerId);
                            vscode.postMessage({ type: 'statusUpdate', value: 'Connected', peerId }); 
                            
                            // [핵심 수정] 연결 성공 시 임시 신호 채널 종료 (다음 게스트 초대를 방해하지 않기 위함)
                            if (activeSignalingConn) {
                                log('Task complete. Closing signaling channel.');
                                activeSignalingConn.close();
                                activeSignalingConn = null;
                            }
                        });

                        p.on('data', data => {
                            const raw = new Uint8Array(data);
                            if (raw.length !== 1 || raw[0] !== 255) {
                                vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw), peerId });
                            }
                        });

                        p.on('error', err => { 
                            log('ERROR (' + peerId + '): ' + err.message); 
                            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
                            delete peers[peerId];
                            if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                        });

                        p.on('close', () => {
                            log('CLOSED: ' + peerId);
                            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
                            delete peers[peerId];
                            if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                        });

                        peers[peerId] = p;
                        return p;
                    } catch(e) { log('Fatal Peer Error: ' + e.message); }
                }

                if (${autoStart}) { 
                    log('Auto-starting default peer...');
                    addPeer('default', ${initiator}); 
                }

                window.addEventListener('message', e => {
                    const m = e.data;
                    const targetId = m.peerId || 'default';
                    if (m.type === 'updatePeerId') {
                        if (peers[m.oldId]) {
                            peers[m.newId] = peers[m.oldId];
                            const sdp = pendingSdpMap[m.oldId];
                            delete peers[m.oldId];
                            delete pendingSdpMap[m.oldId];
                            if (sdp) pendingSdpMap[m.newId] = sdp;
                            log('Peer ID updated from ' + m.oldId + ' to ' + m.newId);
                        }
                    }
                    if (m.type === 'addNewPeer') { 
                        log('Creating new peer: ' + m.peerId);
                        addPeer(m.peerId, m.initiator); 
                    }
                    if (m.type === 'signal') { 
                        if (peers[targetId]) {
                            peers[targetId].signal(m.sdp); 
                        } else {
                            log('Error: Cannot apply signal. Peer ' + targetId + ' not found.');
                        }
                    }
                    if (m.type === 'peerData') {
                        const data = new TextEncoder().encode(JSON.stringify(m.value));
                        if (m.targetPeerId) {
                            if (peers[m.targetPeerId] && peers[m.targetPeerId].connected) {
                                peers[m.targetPeerId].send(data);
                            }
                        } else {
                            Object.values(peers).forEach(p => { if (p.connected) p.send(data); });
                        }
                    }
                });
                setInterval(() => { Object.values(peers).forEach(p => { if (p.connected) p.send(new Uint8Array([255])); }); }, 5000);
            </script></body></html>`;
}
