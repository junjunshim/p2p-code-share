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
        (function() {
            // VS Code API가 전역적으로 없으면 획득하여 공유
            if (!window.vscode) {
                window.vscode = acquireVsCodeApi();
            }
            const vscode = window.vscode;

            const st = null;
            const logDiv = null;

            let peers = {};
            let pendingSdpMap = {}; 
            let remotePeerIdMap = {};
            let peerServer = null;
            let activeSignalingConn = null;
            let iceServers = [];
            let currentInitiator = false;

            /**
             * 로그 메시지를 콘솔에 출력합니다.
             */
            function log(m) { 
                console.log('[P2P Engine]', m);
            }

            /**
             * P2P 엔진 및 연결을 종료합니다.
             */
            function stopEngine() {
                log('Stopping P2P engine and disposing connections...');
                Object.keys(peers).forEach(id => {
                    try { peers[id].destroy(); } catch(e) {}
                    delete peers[id];
                });
                if (activeSignalingConn) {
                    try { activeSignalingConn.close(); } catch(e) {}
                    activeSignalingConn = null;
                }
                if (peerServer) {
                    try { peerServer.destroy(); } catch(e) {}
                    peerServer = null;
                }
                if (st) st.innerText = 'DISCONNECTED';
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
                    });
                }

                p.on('signal', data => { 
                    const sdpStr = JSON.stringify(data);
                    pendingSdpMap[peerId] = sdpStr;
                    vscode.postMessage({ type: 'sdpGenerated', sdp: sdpStr, peerId }); 
                    if (activeSignalingConn && activeSignalingConn.open) {
                        log('SDP generated. Sending SDP message to ' + (currentInitiator ? 'guest' : 'host') + ' via signaling channel.');
                        activeSignalingConn.send({ type: 'SDP', sdp: sdpStr, peerId: remotePeerIdMap[peerId] || peerId });
                    }
                });
                p.on('connect', () => { 
                    log('SDP exchange success. WebRTC P2P channel connected.');
                    let connType = 'Direct';
                    const updateStatus = () => {
                        const statusStr = connType === 'TURN' ? 'Connected (via TURN)' : 'Connected';
                        log('Successfully connected to peer (' + connType + ' connection established).');
                        if (st) { st.innerText = statusStr; st.style.color = '#4ec9b0'; }
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
                    if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
                    vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
                });
                p.on('close', () => {
                    log('P2P connection closed.');
                    delete peers[peerId];
                    if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
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

            /**
             * P2P 엔진 연결을 활성화합니다.
             */
            window.startEngine = function(initiator, autoStart, roomName, turnConfig, peerId) {
                stopEngine(); // 기존 실행 중인 엔진 정지

                currentInitiator = initiator;
                iceServers = [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' }
                ];
                if (turnConfig && turnConfig.url) {
                    iceServers.push({
                        urls: turnConfig.url,
                        username: turnConfig.username,
                        credential: turnConfig.credential
                    });
                }

                log('Starting P2P Engine...');

                function setupPeerJS(rName) {
                    const toSafeId = (n) => 'p2p_room_' + Array.from(n).map(c => c.charCodeAt(0).toString(16)).join('');
                    const pjsId = currentInitiator ? toSafeId(rName) : null;
                    
                    log('Connecting to PeerJS signaling server...');
                    peerServer = new Peer(pjsId, {
                        debug: 3,
                        config: { iceServers: iceServers }
                    });
                    let wasOpened = false;
                    peerServer.on('open', (id) => {
                        if (wasOpened) {
                            vscode.postMessage({ type: 'logMessage', level: 'info', text: 'PeerJS 시그널링 서버와의 재연결에 성공했습니다.' });
                        }
                        wasOpened = true;
                        log('Successfully connected to PeerJS signaling server.');
                        if (currentInitiator) {
                            log('Created room: "' + rName + '". Waiting for guest connection...');
                            vscode.postMessage({ type: 'roomNameSuccess' });
                        } else {
                            log('Connecting to room host for room: "' + rName + '"...');
                            const conn = peerServer.connect(toSafeId(rName));
                            handleSignalingConn(conn);
                        }
                    });
                    peerServer.on('connection', (conn) => { 
                        log('Received connection request from guest signaling client.');
                        handleSignalingConn(conn); 
                    });
                    peerServer.on('disconnected', () => {
                        if (wasOpened && peerServer && !peerServer.destroyed) {
                            log('PeerJS connection to signaling server lost. Reconnecting...');
                            vscode.postMessage({ type: 'logMessage', level: 'warning', text: 'PeerJS 시그널링 서버와의 연결이 끊어졌습니다. 자동으로 재연결을 시도합니다...' });
                            peerServer.reconnect();
                        }
                    });
                    peerServer.on('error', (err) => {
                        log('PeerJS Connection Error: ' + err.type);
                        if (!currentInitiator) {
                            if (err.type === 'peer-unavailable') {
                                vscode.postMessage({ type: 'roomNameError', errorType: 'unavailable' });
                            } else if (err.type === 'server-error' || err.type === 'network') {
                                vscode.postMessage({ type: 'roomNameError', errorType: 'server' });
                            }
                        }
                        if (currentInitiator) {
                            if (wasOpened) {
                                log('Host PeerJS reconnection error (temporary collision or issue): ' + err.type);
                                if (err.type === 'unavailable-id') {
                                    setTimeout(() => {
                                        if (peerServer && !peerServer.destroyed && peerServer.disconnected) {
                                            log('Retrying host PeerJS reconnection after temporary collision...');
                                            peerServer.reconnect();
                                        }
                                    }, 3000);
                                }
                                return;
                            }
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
                        log('Signaling channel established.');
                        if (!currentInitiator) {
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
                            const targetId = currentInitiator ? data.peerId : 'default';
                            if (peers[targetId] && peers[targetId].connected) return;
                            if (!currentInitiator) remotePeerIdMap['default'] = data.peerId;
                            log('Received SDP exchange signal from ' + (currentInitiator ? 'guest' : 'host') + '. Applying signal...');
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

                if (roomName) {
                    setupPeerJS(roomName);
                }
                if (autoStart) {
                    addPeer('default', currentInitiator);
                }
            };

            // 메시지 수신 및 라우팅 리스너
            window.addEventListener('message', e => {
                const m = e.data;
                if (m.type === 'startEngine') {
                    window.startEngine(m.initiator, m.autoStart, m.roomName, m.turnConfig, m.peerId);
                    return;
                }
                if (m.type === 'stopEngine') {
                    stopEngine();
                    return;
                }
                if (m.type === 'status') {
                    if (st) {
                        st.innerText = m.status;
                        if (m.status === 'Connected') st.style.color = '#4ec9b0';
                        else if (m.status === 'Unconnected!') st.style.color = '#f44336';
                        else st.style.color = '#ce9178';
                    }
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

            // 주기적 하트비트 전송
            setInterval(() => { Object.values(peers).forEach(p => { if (p.connected) p.send(new Uint8Array([255])); }); }, 5000);
        })();
    `;
}
