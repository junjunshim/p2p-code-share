/**
 * @file templates.ts
 * @description 사이드바 UI 및 P2P 엔진을 위한 HTML/JS 템플릿을 제공합니다.
 */

/**
 * 사이드바 웹뷰를 위한 HTML 템플릿을 반환합니다.
 */
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
                
                /* 승인 시스템 스타일 */
                .request-item { padding: 12px; border-radius: 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-focusBorder); margin-bottom: 10px; font-size: 12px; }
                .request-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
                .request-name { font-weight: bold; color: var(--vscode-charts-blue); }
                .request-desc { font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); padding: 6px; border-radius: 4px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-all; }
                .request-actions { display: flex; gap: 8px; }
                .approve-btn { flex: 1; background: #28a745; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold; }
                .reject-btn { flex: 1; background: #d73a49; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-weight: bold; }
                .request-count { background: #d73a49; color: white; font-size: 9px; padding: 1px 5px; border-radius: 10px; margin-left: 4px; vertical-align: middle; }
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
                            <p class="room-label">Purpose of Join (Description for Host)</p>
                            <textarea id="joinDescription" placeholder="Hi! I want to help with the UI debugging..."></textarea>
                            <button id="btnJoinAuto" onclick="init(false)" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">JOIN AUTOMATICALLY</button>
                            <div id="guestLoading" class="hidden" style="text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                                <span style="display: inline-block; animation: blink 1s infinite;">📡 Waiting for Approval </span> <span id="joiningRoomText"></span>
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
                    <div id="roomInfoArea">
                        <div class="room-info"><div class="room-label">Room Name</div><div id="dispRoomName" class="room-value"></div></div>
                        <h4>
                            <span>Connected Users</span>
                            <div style="display: flex; gap: 8px; align-items: center;">
                                <span id="btnShowRequests" class="invite-btn hidden" onclick="toggleRequests()" title="Join Requests">📋<span id="reqCount" class="request-count">0</span></span>
                                <span id="btnAddUser" class="invite-btn" onclick="invite()">+</span>
                            </div>
                        </h4>
                        <div id="users"></div>
                        <h4>Active Snapshots</h4><div id="files"></div>
                    </div>
                    <div id="requestsArea" class="hidden">
                        <h4><span>Join Requests</span><span class="edit-name" onclick="toggleRequests()">Back</span></h4>
                        <div id="requestsList"></div>
                    </div>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                let showingRequests = false;

                function toggleRequests() {
                    showingRequests = !showingRequests;
                    const ria = document.getElementById('roomInfoArea');
                    const ra = document.getElementById('requestsArea');
                    if (ria) ria.classList.toggle('hidden', showingRequests);
                    if (ra) ra.classList.toggle('hidden', !showingRequests);
                }

                function approve(peerId) { vscode.postMessage({ type: 'approveRequest', peerId }); }
                function reject(peerId) { vscode.postMessage({ type: 'rejectRequest', peerId }); }

                function showHostForm() { 
                    const hf = document.getElementById('hostForm');
                    const sb = document.getElementById('startButtons');
                    if (hf) hf.classList.remove('hidden'); 
                    if (sb) sb.classList.add('hidden'); 
                }
                function showGuestForm() { 
                    const gf = document.getElementById('guestForm');
                    const sb = document.getElementById('startButtons');
                    if (gf) gf.classList.remove('hidden'); 
                    if (sb) sb.classList.add('hidden'); 
                }
                function resetForms() {
                    const hf = document.getElementById('hostForm');
                    const gf = document.getElementById('guestForm');
                    const sb = document.getElementById('startButtons');
                    if (hf) hf.classList.add('hidden'); 
                    if (gf) gf.classList.add('hidden'); 
                    if (sb) sb.classList.remove('hidden'); 
                    
                    const ids = ['btnStartHost', 'btnJoinAuto', 'btnJoinManual', 'btnCancelHost', 'btnCancelGuest'];
                    ids.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.disabled = false;
                    });
                    const lds = ['hostLoading', 'guestLoading'];
                    lds.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.classList.add('hidden');
                    });
                }

                function init(i) { 
                    try {
                        let rn = '';
                        let desc = '';
                        if(i) {
                            const rnEl = document.getElementById('setupRoomName');
                            rn = rnEl ? rnEl.value.trim() : '';
                            if (!rn) { alert('Please enter a room name first!'); return; }
                            const bsh = document.getElementById('btnStartHost');
                            const bch = document.getElementById('btnCancelHost');
                            const hl = document.getElementById('hostLoading');
                            if (bsh) bsh.disabled = true;
                            if (bch) bch.disabled = true;
                            if (hl) hl.classList.remove('hidden');
                        } else {
                            const rnEl = document.getElementById('joinRoomName');
                            const descEl = document.getElementById('joinDescription');
                            rn = rnEl ? rnEl.value.trim() : '';
                            desc = descEl ? descEl.value.trim() : '';
                            if (!rn) { alert('Please enter the host room name!'); return; }
                            const bja = document.getElementById('btnJoinAuto');
                            const bjm = document.getElementById('btnJoinManual');
                            const jrt = document.getElementById('joiningRoomText');
                            const gl = document.getElementById('guestLoading');
                            if (bja) bja.disabled = true;
                            if (bjm) bjm.disabled = true;
                            if (jrt) jrt.innerText = '"' + rn + '"';
                            if (gl) gl.classList.remove('hidden');
                            vscode.postMessage({ type: 'joinRoom', roomName: rn, description: desc });
                            return; 
                        }
                        const apid = document.getElementById('activePeerId');
                        const lsdp = document.getElementById('lsdp');
                        const rsdp = document.getElementById('rsdp');
                        if (apid) apid.value = i ? 'none' : 'default';
                        if (lsdp) lsdp.value = ''; 
                        if (rsdp) rsdp.value = '';
                        vscode.postMessage({ type: 'initPeer', initiator: i, roomName: rn }); 
                    } catch (e) { console.error(e); }
                }

                function initManualGuest() {
                    const apid = document.getElementById('activePeerId');
                    const lsdp = document.getElementById('lsdp');
                    const rsdp = document.getElementById('rsdp');
                    if (apid) apid.value = 'default';
                    if (lsdp) lsdp.value = ''; 
                    if (rsdp) rsdp.value = '';
                    vscode.postMessage({ type: 'initPeer', initiator: false, roomName: '' }); 
                }

                function invite() { 
                    const lsdp = document.getElementById('lsdp');
                    const rsdp = document.getElementById('rsdp');
                    if (lsdp) lsdp.value = 'Generating...'; 
                    if (rsdp) rsdp.value = '';
                    vscode.postMessage({ type: 'inviteGuest' }); 
                }

                function conn() { 
                    const rsdp = document.getElementById('rsdp');
                    const apid = document.getElementById('activePeerId');
                    const sdpText = rsdp ? rsdp.value : '';
                    const peerId = apid ? apid.value : '';
                    if (!peerId || peerId === 'none') { alert('Error: Target Peer ID not identified.'); return; }
                    try {
                        const sdp = JSON.parse(sdpText);
                        vscode.postMessage({ type: 'signal', sdp: sdp, peerId: peerId }); 
                    } catch(e) { alert('Invalid Connection ID format!'); }
                }

                function goBack() { 
                    const b = document.getElementById('badge');
                    const isInv = b && b.innerText === 'CONNECTED';
                    vscode.postMessage({ type: 'cancel', isInviting: isInv }); 
                }
                function rename() { vscode.postMessage({ type: 'rename' }); }
                function kick(peerId) { vscode.postMessage({ type: 'kick', peerId }); }

                window.addEventListener('message', e => {
                    try {
                        const m = e.data;
                        
                        if (m.type === 'sdpGenerated') { 
                            const lsdp = document.getElementById('lsdp');
                            const apid = document.getElementById('activePeerId');
                            if (lsdp) lsdp.value = m.sdp; 
                            if (apid) apid.value = m.peerId || 'default';
                        }

                        if (m.type === 'renderState' || m.type === 'refresh') {
                            // [안전한 로딩 해제] 데이터가 정상적으로 전달되었을 때만 로딩을 풉니다.
                            const ld = document.getElementById('loading');
                            const mc = document.getElementById('mainContent');
                            if (ld) ld.classList.add('hidden');
                            if (mc) mc.classList.remove('hidden');

                            if (m.type === 'refresh' || !m.participants) return;

                            const b = document.getElementById('badge');
                            const roleSel = document.getElementById('roleSelection');
                            const connArea = document.getElementById('connArea');
                            const active = document.getElementById('active');
                            const roleDisp = document.getElementById('roleTextDisp');
                            const dispRoom = document.getElementById('dispRoomName');
                            const lsdp = document.getElementById('lsdp');
                            const btnAddUser = document.getElementById('btnAddUser');
                            const btnShowRequests = document.getElementById('btnShowRequests');
                            const reqCountDisp = document.getElementById('reqCount');

                            if (b) {
                                b.innerText = m.isConnected ? 'CONNECTED' : 'OFFLINE';
                                b.className = 'badge ' + (m.isConnected ? 'online' : '');
                            }

                            if (m.isSetupMode) {
                                // 1. 설정 모드 (SDP 교환 중)
                                if (roleSel) roleSel.classList.add('hidden');
                                if (connArea) connArea.classList.remove('hidden');
                                if (active) active.classList.add('hidden');
                                if (lsdp && m.invitingSdp) lsdp.value = m.invitingSdp;
                                const isOffer = lsdp && lsdp.value && (lsdp.value.includes('offer') || lsdp.value === 'Generating...');
                                if (roleDisp) roleDisp.innerText = isOffer ? 'INVITING NEW GUEST' : 'JOINING ROOM';
                            } else if (m.isConnected) {
                                // 2. 연결 완료 모드 (참가자 및 파일 목록)
                                if (roleSel) roleSel.classList.add('hidden');
                                if (connArea) connArea.classList.add('hidden');
                                if (active) active.classList.remove('hidden');
                                if (dispRoom) dispRoom.innerText = m.roomName || 'Untitled Room';

                                const isMeHost = m.participants.myId === 'host';
                                if (btnAddUser) btnAddUser.classList.toggle('hidden', !isMeHost);

                                if (isMeHost && m.participants.joinRequests && m.participants.joinRequests.length > 0) {
                                    if (btnShowRequests) btnShowRequests.classList.remove('hidden');
                                    if (reqCountDisp) reqCountDisp.innerText = m.participants.joinRequests.length;
                                    const rl = document.getElementById('requestsList');
                                    if (rl) {
                                        rl.innerHTML = '';
                                        m.participants.joinRequests.forEach(req => {
                                            const item = document.createElement('div');
                                            item.className = 'request-item';
                                            item.innerHTML = '<div class="request-header"><span class="request-name">' + req.name + '</span></div>' +
                                                            '<div class="request-desc">' + (req.description || '(No description)') + '</div>' +
                                                            '<div class="request-actions"><button class="approve-btn" onclick="approve(\\'' + req.peerId + '\\')" title="Approve">✔</button><button class="reject-btn" onclick="reject(\\'' + req.peerId + '\\')" title="Reject">✖</button></div>';
                                            rl.appendChild(item);
                                        });
                                    }
                                } else {
                                    if (btnShowRequests) btnShowRequests.classList.add('hidden');
                                    if (showingRequests) toggleRequests();
                                }

                                const udiv = document.getElementById('users');
                                if (udiv) {
                                    udiv.innerHTML = '';
                                    const myId = m.participants.myId;
                                    Object.entries(m.participants.others).forEach(([id, name]) => {
                                        const isMe = (id === myId || (id === 'default' && myId !== 'host'));
                                        const isHost = (id === 'host');
                                        const bHTML = isMe ? '<span class="me-badge">ME</span>' : (isHost ? '<span class="host-badge">HOST</span>' : '');
                                        const nHTML = isMe ? '<b>' + name + '</b>' : name;
                                        const eHTML = isMe ? '<span class="edit-name" onclick="rename()">Edit</span>' : '';
                                        const kHTML = (m.participants.myId === 'host' && !isMe) ? '<button class="stop-btn" onclick="kick(\\'' + id + '\\')">Kick</button>' : '';
                                        udiv.innerHTML += '<div class="user-item"><div class="user-name">' + nHTML + '</div><div class="badge-area">' + bHTML + '</div><div class="action-area">' + eHTML + kHTML + '</div></div>';
                                    });
                                }
                            } else if (m.participants.myId === 'host' && m.roomName && m.roomName !== 'Untitled Room') {
                                // 3. 호스트 생성/연결 중 모드
                                if (roleSel) roleSel.classList.remove('hidden');
                                if (connArea) connArea.classList.add('hidden');
                                if (active) active.classList.add('hidden');
                                
                                const sb = document.getElementById('startButtons');
                                const hf = document.getElementById('hostForm');
                                const hl = document.getElementById('hostLoading');
                                const bsh = document.getElementById('btnStartHost');
                                const bch = document.getElementById('btnCancelHost');
                                
                                if (sb) sb.classList.add('hidden');
                                if (hf) hf.classList.remove('hidden');
                                if (hl) hl.classList.remove('hidden');
                                if (bsh) bsh.disabled = true;
                                if (bch) bch.disabled = true;
                            } else if (m.roomName && m.roomName !== 'Untitled Room' && m.participants.myId !== 'host') {
                                // 4. 게스트 승인 대기 모드
                                if (roleSel) roleSel.classList.remove('hidden');
                                if (connArea) connArea.classList.add('hidden');
                                if (active) active.classList.add('hidden');
                                
                                const sb = document.getElementById('startButtons');
                                const gf = document.getElementById('guestForm');
                                const gl = document.getElementById('guestLoading');
                                const bja = document.getElementById('btnJoinAuto');
                                const bjm = document.getElementById('btnJoinManual');
                                const jrt = document.getElementById('joiningRoomText');
                                
                                if (sb) sb.classList.add('hidden');
                                if (gf) gf.classList.remove('hidden');
                                if (gl) gl.classList.remove('hidden');
                                if (bja) bja.disabled = true;
                                if (bjm) bjm.disabled = true;
                                if (jrt) jrt.innerText = '"' + m.roomName + '"';
                            } else {
                                // 5. 초기 모드 (방 생성/참여 선택)
                                if (roleSel) roleSel.classList.remove('hidden');
                                if (connArea) connArea.classList.add('hidden');
                                if (active) active.classList.add('hidden');
                                resetForms();
                            }

                            const fdiv = document.getElementById('files');
                            if (fdiv) {
                                fdiv.innerHTML = '';
                                const isFinalHost = m.participants.myId === 'host';
                                m.files.forEach(f => {
                                    const item = document.createElement('div'); item.className = 'file-item';
                                    const nameSpan = document.createElement('span');
                                    nameSpan.innerText = '📄 ' + f.name; nameSpan.style.flex = '1';
                                    nameSpan.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });
                                    item.appendChild(nameSpan);
                                    if (isFinalHost) {
                                        const stopBtn = document.createElement('button'); stopBtn.className = 'stop-btn'; stopBtn.innerText = 'Stop';
                                        stopBtn.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'stopFileSharing', fileName: f.name }); };
                                        item.appendChild(stopBtn);
                                    }
                                    fdiv.appendChild(item);
                                });
                            }
                        }
                    } catch (err) { console.error("Webview Error:", err); }
                });
                vscode.postMessage({ type: 'ready' });
            </script></body></html>`;
}

/**
 * P2P 엔진 웹뷰를 위한 HTML 템플릿을 반환합니다.
 */
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
                const pendingSdpMap = {}; 
                const remotePeerIdMap = {};
                let peerServer = null;
                let activeSignalingConn = null;

                function log(m) { 
                    const entry = document.createElement('div');
                    entry.innerText = '> ' + new Date().toLocaleTimeString() + ' - ' + m;
                    logDiv.prepend(entry);
                }

                if ("${roomName}") {
                    const rName = "${roomName}";
                    const toSafeId = (n) => 'p2p_room_' + Array.from(n).map(c => c.charCodeAt(0).toString(16)).join('');
                    const pjsId = ${initiator} ? toSafeId(rName) : null;
                    peerServer = new Peer(pjsId, {
                        debug: 3,
                        config: { 
                            iceServers: [
                                { urls: 'stun:stun.l.google.com:19302' },
                                { urls: 'stun:stun1.l.google.com:19302' },
                                { urls: 'stun:stun2.l.google.com:19302' }
                            ] 
                        }
                    });
                    peerServer.on('open', (id) => {
                        log('Auto-Signaling Server Ready.');
                        if (${initiator}) vscode.postMessage({ type: 'roomNameSuccess' });
                        if (!${initiator}) {
                            const conn = peerServer.connect(toSafeId(rName));
                            handleSignalingConn(conn);
                        }
                    });
                    peerServer.on('connection', (conn) => { handleSignalingConn(conn); });
                    peerServer.on('error', (err) => {
                        log('PeerJS Error: ' + err.type);
                        if (${initiator}) {
                            let errorType = 'unknown';
                            if (err.type === 'unavailable-id') errorType = 'duplicate';
                            else if (err.type === 'server-error' || err.type === 'network') errorType = 'server';
                            vscode.postMessage({ type: 'roomNameError', errorType: errorType });
                        }
                    });
                }

                function handleSignalingConn(conn) {
                    activeSignalingConn = conn;
                    conn.on('open', () => { if (!${initiator}) conn.send({ type: 'REQ_OFFER' }); });
                    conn.on('data', (data) => {
                        if (data.type === 'REQ_OFFER') {
                            const targetId = Object.keys(peers).find(id => !peers[id].connected && peers[id].initiator);
                            if (targetId && pendingSdpMap[targetId]) {
                                conn.send({ type: 'SDP', sdp: pendingSdpMap[targetId], peerId: targetId });
                            } else {
                                vscode.postMessage({ type: 'requireInvite' });
                            }
                        } else if (data.type === 'SDP') {
                            const targetId = ${initiator} ? data.peerId : 'default';
                            if (peers[targetId] && peers[targetId].connected) return;
                            if (!${initiator}) remotePeerIdMap['default'] = data.peerId;
                            window.dispatchEvent(new MessageEvent('message', { data: { type: 'signal', sdp: data.sdp, peerId: targetId } }));
                        }
                    });
                    conn.on('close', () => { if (activeSignalingConn === conn) activeSignalingConn = null; });
                }

                function addPeer(peerId, isInitiator) {
                    if (peers[peerId]) return;
                    try {
                        const p = new SimplePeer({ 
                            initiator: isInitiator, trickle: false, 
                            config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } 
                        });
                        p.on('signal', data => { 
                            const sdpStr = JSON.stringify(data);
                            pendingSdpMap[peerId] = sdpStr;
                            vscode.postMessage({ type: 'sdpGenerated', sdp: sdpStr, peerId }); 
                            if (activeSignalingConn && activeSignalingConn.open) {
                                activeSignalingConn.send({ type: 'SDP', sdp: sdpStr, peerId: remotePeerIdMap[peerId] || peerId });
                            }
                        });
                        p.on('connect', () => { 
                            st.innerText = 'CONNECTED!'; st.style.color = '#4ec9b0';
                            vscode.postMessage({ type: 'statusUpdate', value: 'Connected', peerId }); 
                            if (activeSignalingConn) { activeSignalingConn.close(); activeSignalingConn = null; }
                        });
                        p.on('data', data => {
                            const raw = new Uint8Array(data);
                            if (raw.length !== 1 || raw[0] !== 255) {
                                vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw), peerId });
                            }
                        });
                        p.on('error', err => { 
                            delete peers[peerId];
                            if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
                        });
                        p.on('close', () => {
                            delete peers[peerId];
                            if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
                        });
                        peers[peerId] = p;
                    } catch(e) { log('Error: ' + e.message); }
                }

                if (${autoStart}) addPeer('default', ${initiator}); 

                window.addEventListener('message', e => {
                    const m = e.data;
                    const targetId = m.peerId || 'default';
                    if (m.type === 'updatePeerId' && peers[m.oldId]) {
                        peers[m.newId] = peers[m.oldId];
                        pendingSdpMap[m.newId] = pendingSdpMap[m.oldId];
                        delete peers[m.oldId]; delete pendingSdpMap[m.oldId];
                    }
                    if (m.type === 'addNewPeer') addPeer(m.peerId, m.initiator); 
                    if (m.type === 'signal' && peers[targetId]) peers[targetId].signal(m.sdp); 
                    if (m.type === 'peerData') {
                        const data = new TextEncoder().encode(JSON.stringify(m.value));
                        if (m.targetPeerId) {
                            if (peers[m.targetPeerId] && peers[m.targetPeerId].connected) peers[m.targetPeerId].send(data);
                        } else {
                            Object.values(peers).forEach(p => { if (p.connected) p.send(data); });
                        }
                    }
                });
                setInterval(() => { Object.values(peers).forEach(p => { if (p.connected) p.send(new Uint8Array([255])); }); }, 5000);
            </script></body></html>`;
}
