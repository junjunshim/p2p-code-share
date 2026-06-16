/**
 * @file script.ts
 * @description P2P 엔진 웹뷰 내 클라이언트 스크립트를 제공합니다.
 */

export function getEngineScript(
    initiator: boolean,
    autoStart: boolean = true,
    roomName: string = '',
    turnConfig?: { url: string; username?: string; credential?: string }
): string {
    const turnConfigSerialized = turnConfig && turnConfig.url ? JSON.stringify({
        urls: turnConfig.url,
        username: turnConfig.username,
        credential: turnConfig.credential
    }) : 'null';

    return `
        const vscode = acquireVsCodeApi();
        const st = document.getElementById('st');
        const logDiv = document.getElementById('log');
        const peers = {};
        const pendingSdpMap = {}; 
        const remotePeerIdMap = {};
        let peerServer = null;
        let activeSignalingConn = null;

        /**
         * 화면에 로그 메시지를 출력합니다.
         */
        function log(m) { 
            const entry = document.createElement('div');
            entry.innerText = '> ' + new Date().toLocaleTimeString() + ' - ' + m;
            logDiv.prepend(entry);
        }

        /**
         * ICE 서버 설정을 구성하여 반환합니다.
         */
        function setupIceServers() {
            const servers = [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ];
            const turnConfigVal = ${turnConfigSerialized};
            if (turnConfigVal && turnConfigVal.urls) {
                servers.push(turnConfigVal);
            }
            return servers;
        }
        const iceServers = setupIceServers();

        /**
         * PeerJS 신호(Signaling) 서버 연결을 설정합니다.
         */
        function setupPeerJS(rName) {
            /**
             * 방 이름을 PeerJS 연결에 안전한 ID 형태로 변환합니다.
             */
            const toSafeId = (n) => 'p2p_room_' + Array.from(n).map(c => c.charCodeAt(0).toString(16)).join('');
            const pjsId = ${initiator} ? toSafeId(rName) : null;
            
            log('Connecting to PeerJS signaling server...');
            peerServer = new Peer(pjsId, {
                debug: 3,
                config: { 
                    iceServers: iceServers 
                }
            });
            peerServer.on('open', (id) => {
                log('Successfully connected to PeerJS signaling server.');
                if (${initiator}) {
                    log('Created room: "' + rName + '". Waiting for guest connection...');
                    vscode.postMessage({ type: 'roomNameSuccess' });
                }
                if (!${initiator}) {
                    log('Connecting to room host for room: "' + rName + '"...');
                    const conn = peerServer.connect(toSafeId(rName));
                    handleSignalingConn(conn);
                }
            });
            peerServer.on('connection', (conn) => { 
                log('Received connection request from guest signaling client.');
                handleSignalingConn(conn); 
            });
            peerServer.on('error', (err) => {
                log('PeerJS Connection Error: ' + err.type);
                if (!${initiator} && err.type === 'peer-unavailable') {
                    log('Error: Room "' + rName + '" does not exist or the host is offline.');
                }
                if (err.type === 'server-error' || err.type === 'network') {
                    log('Error: Failed to connect to PeerJS signaling server (network/server issue).');
                }
                if (${initiator}) {
                    let errorType = 'unknown';
                    if (err.type === 'unavailable-id') errorType = 'duplicate';
                    else if (err.type === 'server-error' || err.type === 'network') errorType = 'server';
                    vscode.postMessage({ type: 'roomNameError', errorType: errorType });
                }
            });
        }

        if ("${roomName}") {
            setupPeerJS("${roomName}");
        }

        /**
         * 신호 서버와의 연결 채널을 처리합니다.
         */
        function handleSignalingConn(conn) {
            activeSignalingConn = conn;
            conn.on('open', () => { 
                log('Signaling channel established.');
                if (!${initiator}) {
                    log('Requesting SDP offer from host...');
                    conn.send({ type: 'REQ_OFFER' }); 
                }
            });
            conn.on('data', (data) => {
                if (data.type === 'REQ_OFFER') {
                    const targetId = Object.keys(peers).find(id => !peers[id].connected && peers[id].initiator);
                    if (targetId && pendingSdpMap[targetId]) {
                        log('Sending SDP offer to guest...');
                        conn.send({ type: 'SDP', sdp: pendingSdpMap[targetId], peerId: targetId });
                    } else {
                        vscode.postMessage({ type: 'requireInvite' });
                    }
                } else if (data.type === 'SDP') {
                    const targetId = ${initiator} ? data.peerId : 'default';
                    if (peers[targetId] && peers[targetId].connected) return;
                    if (!${initiator}) remotePeerIdMap['default'] = data.peerId;
                    log('Received SDP exchange signal from ' + (${initiator} ? 'guest' : 'host') + '. Applying signal...');
                    window.dispatchEvent(new MessageEvent('message', { data: { type: 'signal', sdp: data.sdp, peerId: targetId } }));
                }
            });
            conn.on('close', () => { 
                log('Signaling channel connection closed.');
                if (activeSignalingConn === conn) activeSignalingConn = null; 
            });
            conn.on('error', (err) => {
                log('Signaling channel error: ' + err.message);
            });
        }

        /**
         * WebRTC 피어 연결 및 데이터 채널을 설정합니다.
         */
        function setupWebRTCPeer(peerId, p) {
            const rawPc = p._pc;
            if (rawPc) {
                rawPc.addEventListener('icegatheringstatechange', () => {
                    log('ICE Gathering State: ' + rawPc.iceGatheringState);
                });
                rawPc.addEventListener('iceconnectionstatechange', () => {
                    log('ICE Connection State: ' + rawPc.iceConnectionState);
                    if (rawPc.iceConnectionState === 'failed') {
                        log('Direct connection failed or timed out. Checking TURN relay backup...');
                    }
                });
            }

            p.on('signal', data => { 
                const sdpStr = JSON.stringify(data);
                pendingSdpMap[peerId] = sdpStr;
                vscode.postMessage({ type: 'sdpGenerated', sdp: sdpStr, peerId }); 
                if (activeSignalingConn && activeSignalingConn.open) {
                    log('SDP generated. Sending SDP message to ' + (${initiator} ? 'guest' : 'host') + ' via signaling channel.');
                    activeSignalingConn.send({ type: 'SDP', sdp: sdpStr, peerId: remotePeerIdMap[peerId] || peerId });
                }
            });
            p.on('connect', () => { 
                log('SDP exchange success. WebRTC P2P channel connected.');
                let connType = 'Direct';
                /**
                 * 피어와의 연결 방식(TURN/직접 연결)을 감지하고 상태를 업데이트합니다.
                 */
                const updateStatus = () => {
                    const statusStr = connType === 'TURN' ? 'Connected (via TURN)' : 'Connected';
                    log('Successfully connected to peer (' + connType + ' connection established).');
                    st.innerText = statusStr; st.style.color = '#4ec9b0';
                    vscode.postMessage({ type: 'statusUpdate', value: statusStr, peerId }); 
                };

                if (p.getStats) {
                    setTimeout(() => {
                        p.getStats((err, stats) => {
                            if (!err && stats) {
                                let activePair = null;
                                stats.forEach(report => {
                                    if (report.type === 'candidate-pair' && (report.selected || report.nominated || report.state === 'succeeded')) {
                                        activePair = report;
                                    }
                                });
                                if (activePair) {
                                    if (activePair.remoteCandidateType === 'relay' || activePair.localCandidateType === 'relay') {
                                        connType = 'TURN';
                                    } else {
                                        const remoteCandId = activePair.remoteCandidateId;
                                        const localCandId = activePair.localCandidateId;
                                        const remoteCand = (stats.get && remoteCandId) ? stats.get(remoteCandId) : null;
                                        const localCand = (stats.get && localCandId) ? stats.get(localCandId) : null;
                                        
                                        if ((remoteCand && remoteCand.candidateType === 'relay') || 
                                            (localCand && localCand.candidateType === 'relay')) {
                                            connType = 'TURN';
                                        } else {
                                            stats.forEach(report => {
                                                if (report.id && (
                                                    report.id === remoteCandId || 
                                                    report.id === localCandId ||
                                                    (remoteCandId && report.id.includes(remoteCandId)) ||
                                                    (localCandId && report.id.includes(localCandId)) ||
                                                    (remoteCandId && remoteCandId.includes(report.id)) ||
                                                    (localCandId && localCandId.includes(report.id))
                                                )) {
                                                    if (report.candidateType === 'relay') {
                                                        connType = 'TURN';
                                                    }
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                            updateStatus();
                        });
                    }, 500);
                } else {
                    updateStatus();
                }
                if (activeSignalingConn) { activeSignalingConn.close(); activeSignalingConn = null; }
            });
            p.on('data', data => {
                const raw = new Uint8Array(data);
                if (raw.length !== 1 || raw[0] !== 255) {
                    vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw), peerId });
                }
            });
            p.on('error', err => { 
                log('P2P connection error: ' + err.message);
                delete peers[peerId];
                if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
            });
            p.on('close', () => {
                log('P2P connection closed.');
                delete peers[peerId];
                if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
            });
        }

        /**
         * 새로운 피어 연결 객체를 생성하고 관리 목록에 추가합니다.
         */
        function addPeer(peerId, isInitiator) {
            if (peers[peerId]) return;
            try {
                log('Initializing WebRTC peer connection (isInitiator: ' + isInitiator + ')...');
                const p = new SimplePeer({ 
                    initiator: isInitiator, trickle: false, 
                    config: { iceServers: iceServers } 
                });
                
                setupWebRTCPeer(peerId, p);
                peers[peerId] = p;
            } catch(e) { log('Error: ' + e.message); }
        }

        if (${autoStart}) addPeer('default', ${initiator}); 

        window.addEventListener('message', e => {
            const m = e.data;
            
            if (m.type === 'status') {
                st.innerText = m.status;
                if (m.status === 'Connected') st.style.color = '#4ec9b0';
                else if (m.status === 'Unconnected!') st.style.color = '#f44336';
                else st.style.color = '#ce9178';
                return;
            }
            
            if (m.type === 'log') { log(m.message); return; }
            
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
    `;
}
