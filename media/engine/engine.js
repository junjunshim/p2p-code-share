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
    let isStoppingEngine = false; // stopEngine()에 의한 의도적 종료 중에는 disconnected 이벤트를 무시하기 위한 플래그
    let hasActiveRoomSession = false; // 시그널링 서버에 방/세션이 성립되어 재연결이 필요한 상태인지 여부
    let guestSignalingConn = null; // 게스트가 호스트와 통신하기 위한 시그널링 커넥션
    let guestSignalingConnectTimer = null;
    let peerSignalingConnMap = {}; // 피어 ID별 시그널링 커넥션 매핑
    let connPeerIdMap = new WeakMap(); // 커넥션 객체별 할당된 피어 ID 매핑
    let srflxAttemptMap = {}; // 피어별 srflx(공인 IP) 후보 수집 재시도 횟수
    let remoteSignalMap = {}; // 피어별 마지막 원격 signal (재시도 시 같은 offer 재적용용)
    let pendingSignalingQueue = [];
    let iceServers = [];
    let currentInitiator = false;

    // 확장 호스트에서 STUN 목록을 전달하지 못했을 때 사용하는 기본 STUN 서버
    const DEFAULT_STUN_URLS = [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302'
    ];

    /**
     * simple-peer가 ICE 수집 완료를 기다리는 시간(ms).
     * 기본값 5초보다 길게 잡아야 STUN 응답이 느린 네트워크에서도 srflx(공인 IP) 후보가 SDP에 포함됩니다.
     */
    const ICE_COMPLETE_TIMEOUT_MS = 5000;

    /** SDP를 전달하기 전에 실제 ICE 수집 완료를 추가로 기다리는 최대 시간(ms) */
    const ICE_GATHERING_WAIT_MS = 6000;

    /** 공인 IP(srflx) 후보를 얻지 못했을 때 SDP 생성을 다시 시도하는 최대 횟수 */
    const SRFLX_MAX_ATTEMPTS = 2;

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
        // PeerJS의 destroy()는 내부적으로 disconnect()를 호출해 'disconnected' 이벤트를 발생시키므로,
        // 의도적 종료 중에는 시그널링 재연결/알림 로직이 동작하지 않도록 플래그를 세웁니다.
        isStoppingEngine = true;
        hasActiveRoomSession = false;
        if (guestSignalingConnectTimer) {
            clearTimeout(guestSignalingConnectTimer);
            guestSignalingConnectTimer = null;
        }
        Object.keys(peers).forEach(id => {
            try { peers[id].destroy(); } catch(e) {}
            delete peers[id];
        });
        pendingSignalingQueue = [];
        peerSignalingConnMap = {};
        srflxAttemptMap = {};
        remoteSignalMap = {};
        if (guestSignalingConn) {
            try { guestSignalingConn.close(); } catch(e) {}
            guestSignalingConn = null;
        }
        if (peerServer) {
            try { peerServer.destroy(); } catch(e) {}
            peerServer = null;
        }
        if (st) st.innerText = 'DISCONNECTED';
    }

    /**
     * 대기 중인 게스트 시그널링 요청 큐를 확인하고 생성된 SDP 오퍼를 즉시 전송합니다.
     */
    function flushPendingSignalingRequests() {
        if (!currentInitiator || pendingSignalingQueue.length === 0) return;

        while (pendingSignalingQueue.length > 0) {
            // 아직 시그널링 채널에 바인딩되지 않았고, 미연결 상태이며, SDP 오퍼 생성이 완료된 슬롯 탐색
            const readyTargetId = Object.keys(peers).find(id => 
                !peers[id].connected && 
                peers[id].initiator && 
                pendingSdpMap[id] && 
                !peerSignalingConnMap[id]
            );

            if (!readyTargetId) break;

            const req = pendingSignalingQueue.shift();
            if (!req) break;

            try {
                if (req.conn && req.conn.open) {
                    const sdp = pendingSdpMap[readyTargetId];
                    log('Dispatching queued SDP offer to guest (targetId: ' + readyTargetId + ')...');
                    peerSignalingConnMap[readyTargetId] = req.conn;
                    connPeerIdMap.set(req.conn, readyTargetId);
                    req.conn.send({ type: 'SDP', sdp: sdp, peerId: readyTargetId });
                }
            } catch (err) {
                log('Failed to send SDP to queued connection: ' + err.message);
            }
        }
    }

    /**
     * SDP에 담긴 ICE 후보를 유형별로 집계합니다.
     */
    function countCandidatesByType(sdp) {
        const counts = {};
        String(sdp || '').split('\n').forEach(line => {
            const marker = line.indexOf(' typ ');
            if (line.indexOf('a=candidate:') !== 0 || marker < 0) return;
            const type = line.substring(marker + 5).trim().split(' ')[0];
            if (!type) return;
            counts[type] = (counts[type] || 0) + 1;
        });
        return counts;
    }

    /**
     * 후보 집계 결과를 로그용 문자열로 변환합니다.
     */
    function formatCandidateCounts(counts) {
        const keys = Object.keys(counts);
        if (keys.length === 0) return 'none';
        return keys.map(key => key + ' x' + counts[key]).join(', ');
    }

    /**
     * 공인 IP(srflx) 후보 포함 여부를 함께 기록합니다.
     */
    function logCandidateSummary(kind, counts) {
        log('[ICE Summary] ' + kind + ' SDP candidates -> ' + formatCandidateCounts(counts));
        if (!counts.srflx) {
            log('[ICE Warning] 공인 IP(srflx) 후보가 없습니다. STUN 응답을 받지 못했습니다.');
        }
    }

    /**
     * 실제 ICE 수집이 완료될 때까지 기다립니다(최대 timeoutMs).
     */
    function waitForIceGatheringComplete(pc, timeoutMs) {
        return new Promise(resolve => {
            if (!pc || pc.iceGatheringState === 'complete') { resolve(); return; }
            let settled = false;
            let timer = null;
            function onChange() { if (pc.iceGatheringState === 'complete') finish(); }
            function finish() {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                pc.removeEventListener('icegatheringstatechange', onChange);
                resolve();
            }
            pc.addEventListener('icegatheringstatechange', onChange);
            timer = setTimeout(finish, timeoutMs);
        });
    }

    /**
     * 원격 SDP에서 mDNS(.local) 후보를 제거합니다.
     * mDNS 후보는 같은 네트워크의 피어가 즉시 연결되게 만들어 Chromium이 STUN(srflx) 수집을
     * 조기에 끝내버립니다(공인 IP 후보 누락). mDNS 후보를 빼면 수집이 끝까지 진행되어 공인 IP를
     * 받을 수 있고, 상대는 우리 후보를 이미 갖고 있으므로 연결은 그대로 성립합니다.
     */
    function stripMdnsCandidates(sdp) {
        if (typeof sdp !== 'string' || sdp.indexOf('.local') < 0) return sdp;
        return sdp.split(/\r?\n/).filter(line => !(line.indexOf('a=candidate:') === 0 && line.indexOf('.local') >= 0)).join('\r\n');
    }

    /**
     * 게스트(비 initiator)가 원격 offer를 적용할 때 mDNS 후보를 제외한 signal을 만듭니다.
     */
    function parseSignalPayload(signal) {
        if (typeof signal !== 'string') return signal;
        try {
            const parsed = JSON.parse(signal);
            return (parsed && typeof parsed === 'object') ? parsed : signal;
        } catch (e) {
            return signal;
        }
    }

    function prepareRemoteSignalFor(p, signal) {
        const normalized = parseSignalPayload(signal);
        if (!normalized || typeof normalized.sdp !== 'string') return normalized;
        if (!p || p.initiator) return normalized;
        const filteredSdp = stripMdnsCandidates(normalized.sdp);
        if (filteredSdp !== normalized.sdp) {
            log('[ICE] 원격 offer에서 mDNS 후보를 제외하고 적용합니다. (STUN 공인 IP 수집 유지)');
            return { type: normalized.type, sdp: filteredSdp };
        }
        return normalized;
    }

    /**
     * 공인 IP(srflx) 후보가 빠진 SDP만 확정된 경우, 같은 시그널링 정보로 연결을 새로 만들어
     * 후보 수집을 다시 시도합니다. (STUN 응답이 일시적으로 누락된 경우 복구)
     */
    function retryPeerForPublicIp(peerId, p) {
        const isInitiator = p.initiator;
        const key = findPeerKey(p) || resolvePeerKey(peerId);
        const remoteSignal = remoteSignalMap[key] || remoteSignalMap[peerId];
        try { p.destroy(); } catch(e) {}
        delete peers[key];
        delete pendingSdpMap[key];
        if (!isInitiator && !remoteSignal) {
            return false;
        }
        addPeer(key, isInitiator);
        if (!peers[key]) {
            return false;
        }
        if (!isInitiator) {
            try {
                peers[key].signal(prepareRemoteSignalFor(peers[key], remoteSignal));
            } catch (e) {
                log('재시도 중 offer 적용 실패: ' + e.message);
                return false;
            }
        }
        return true;
    }

    /**
     * 새 SDP가 기존 SDP보다 더 많은 후보(특히 공인 IP)를 담고 있는지 확인합니다.
     */
    function isBetterSdp(candidateSdp, currentSdp) {
        const score = counts => Object.keys(counts).reduce((sum, key) => sum + counts[key], 0) + (counts.srflx ? 100 : 0);
        return score(countCandidatesByType(candidateSdp)) > score(countCandidatesByType(currentSdp));
    }

    /**
     * 생성된 SDP를 UI 및 시그널링 채널로 전달합니다.
     */
    function publishSdp(peerId, sdpStr) {
        pendingSdpMap[peerId] = sdpStr;
        vscode.postMessage({ type: 'sdpGenerated', sdp: sdpStr, peerId });

        if (currentInitiator) {
            flushPendingSignalingRequests();
        }

        const targetConn = currentInitiator ? peerSignalingConnMap[peerId] : guestSignalingConn;
        if (targetConn && targetConn.open) {
            log('SDP generated. Sending SDP message to ' + (currentInitiator ? 'guest' : 'host') + ' via signaling channel.');
            targetConn.send({ type: 'SDP', sdp: sdpStr, peerId: remotePeerIdMap[peerId] || peerId });
        }
    }

    /**
     * simple-peer가 ICE 수집 완료 전에 SDP를 방출하면 공인 IP(srflx) 후보가 빠지므로,
     * 실제 수집이 끝날 때까지 기다린 뒤 수집된 후보가 모두 담긴 SDP를 전달합니다.
     */
    function publishSignalWithFullCandidates(peerId, p, data) {
        const baseSdp = typeof data.sdp === 'string' ? data.sdp : '';
        const pc = p._pc;
        const attempt = srflxAttemptMap[peerId] || 0;

        function finalize(sdp) {
            if (peers[peerId] !== p || p.destroyed) {
                log('Peer was reset while waiting for ICE candidates. Discarding stale SDP.');
                return;
            }
            const counts = countCandidatesByType(sdp);
            logCandidateSummary(data.type, counts);
            if (counts.srflx || attempt >= SRFLX_MAX_ATTEMPTS - 1) {
                srflxAttemptMap[peerId] = 0;
                publishSdp(peerId, JSON.stringify({ type: data.type, sdp: sdp }));
                return;
            }
            srflxAttemptMap[peerId] = attempt + 1;
            log('공인 IP(srflx) 후보가 없어 후보 수집을 다시 시도합니다. (시도 ' + (attempt + 2) + '/' + SRFLX_MAX_ATTEMPTS + ')');
            if (!retryPeerForPublicIp(peerId, p)) {
                log('재시도가 불가능하여 수집된 후보만으로 SDP를 전달합니다.');
                srflxAttemptMap[peerId] = 0;
                publishSdp(peerId, JSON.stringify({ type: data.type, sdp: sdp }));
            }
        }

        if (!pc || pc.iceGatheringState === 'complete') {
            finalize(baseSdp);
            return;
        }

        log('ICE 수집이 끝나지 않아 공인 IP 후보가 누락될 수 있습니다. 수집 완료를 기다립니다...');
        const waitMs = attempt === 0 ? ICE_GATHERING_WAIT_MS : Math.floor(ICE_GATHERING_WAIT_MS / 2);
        const waitStarted = Date.now();
        waitForIceGatheringComplete(pc, waitMs).then(() => {
            log('ICE 수집 대기 종료 (' + (Date.now() - waitStarted) + 'ms, state=' + pc.iceGatheringState + ')');
            const liveSdp = pc.localDescription && pc.localDescription.sdp;
            if (liveSdp && isBetterSdp(liveSdp, baseSdp)) {
                log('수집된 후보가 더 많은 SDP로 갱신하여 전달합니다.');
                finalize(liveSdp);
                return;
            }
            finalize(baseSdp);
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
            // 수집되는 후보를 유형별로 기록하여 공인 IP(srflx) 수신 여부를 확인할 수 있게 합니다.
            rawPc.addEventListener('icecandidate', ev => {
                if (!ev.candidate) return;
                const parts = String(ev.candidate.candidate).split(' ');
                log('[ICE Candidate] typ=' + (parts[7] || '?') + ', protocol=' + (parts[2] || '?') + ', ip=' + (parts[4] || '?') + ':' + (parts[5] || '?'));
            });
            // STUN 조회 실패(701), 서버 응답 오류(400/401/500) 등 srflx 수집 실패 원인을 기록합니다.
            rawPc.addEventListener('icecandidateerror', ev => {
                log('[ICE Candidate Error] code=' + ev.errorCode + ', url=' + ev.url + ', text=' + ev.errorText);
            });
            rawPc.addEventListener('iceconnectionstatechange', () => {
                log('ICE Connection State: ' + rawPc.iceConnectionState);
                if (rawPc.iceConnectionState === 'failed') {
                    vscode.postMessage({ type: 'iceFailed', peerId });
                }
            });
        }

        p.on('signal', data => {
            if (data && (data.type === 'offer' || data.type === 'answer')) {
                publishSignalWithFullCandidates(peerId, p, data);
                return;
            }
            publishSdp(peerId, JSON.stringify(data));
        });

        p.on('connect', () => {
            // WebRTC 데이터 채널이 열린 시점부터 방 세션이 성립된 것으로 간주합니다(게스트 입장 완료).
            hasActiveRoomSession = true;
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
                            let selectedPair = null;
                            let nominatedPair = null;
                            let succeededPair = null;
                            const statsById = {};
                            stats.forEach(report => {
                                if (!report) return;
                                if (report.id) statsById[report.id] = report;
                                if (report.type !== 'candidate-pair') return;
                                if (report.selected) selectedPair = report;
                                else if (report.nominated) nominatedPair = report;
                                else if (report.state === 'succeeded') succeededPair = report;
                            });
                            const activePair = selectedPair || nominatedPair || succeededPair;
                            if (activePair) {
                                // simple-peer는 getStats 결과를 배열로 변환해 전달하므로 id로 직접 인덱싱합니다.
                                const candById = id => (id && (statsById[id] || (typeof stats.get === 'function' ? stats.get(id) : null))) || null;
                                const describeCand = (cand, fallbackType, id) => {
                                    const kind = (cand && cand.candidateType) || fallbackType || 'unknown';
                                    const addr = cand && (cand.address || cand.ip);
                                    return kind + (addr ? ' ' + addr + ':' + (cand.port || '?') : ' (id=' + id + ')');
                                };
                                const localCand = candById(activePair.localCandidateId);
                                const remoteCand = candById(activePair.remoteCandidateId);
                                const localCandType = (localCand && localCand.candidateType) || activePair.localCandidateType;
                                const remoteCandType = (remoteCand && remoteCand.candidateType) || activePair.remoteCandidateType;
                                if (localCandType === 'relay' || remoteCandType === 'relay') {
                                    connType = 'TURN';
                                }
                                const pairText = '[ICE Selected Pair] local=' + describeCand(localCand, activePair.localCandidateType, activePair.localCandidateId)
                                    + ', remote=' + describeCand(remoteCand, activePair.remoteCandidateType, activePair.remoteCandidateId)
                                    + ', protocol=' + ((localCand && localCand.protocol) || (remoteCand && remoteCand.protocol) || activePair.protocol || '?')
                                    + ', state=' + (activePair.state || '?');
                                log(pairText);
                                vscode.postMessage({ type: 'logMessage', level: 'debug', text: pairText });
                            }
                        }
                        updateStatus();
                    });
                }, 500);
            } else {
                updateStatus();
            }
            if (currentInitiator) {
                if (peerSignalingConnMap[peerId]) {
                    try { peerSignalingConnMap[peerId].close(); } catch(e) {}
                    delete peerSignalingConnMap[peerId];
                }
            } else {
                if (guestSignalingConn) {
                    try { guestSignalingConn.close(); } catch(e) {}
                    guestSignalingConn = null;
                }
            }
        });

        p.on('data', data => {
            const raw = new Uint8Array(data);
            if (raw.length !== 1 || raw[0] !== 255) {
                vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw), peerId });
            }
        });

        p.on('error', err => {
            log('P2P connection error: ' + err.message);
            // 후보 재수집을 위해 교체된 이전 연결의 이벤트는 현재 피어를 건드리지 않도록 무시합니다.
            const key = findPeerKey(p);
            if (!key) return;
            delete peers[key];
            delete pendingSdpMap[key];
            delete remoteSignalMap[key];
            delete srflxAttemptMap[key];
            if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId: key });
        });

        p.on('close', () => {
            log('P2P connection closed.');
            const key = findPeerKey(p);
            if (!key) return;
            delete peers[key];
            delete pendingSdpMap[key];
            delete remoteSignalMap[key];
            delete srflxAttemptMap[key];
            if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId: key });
        });
    }

    /**
     * 새로운 피어 연결 객체를 생성하고 관리 목록에 추가합니다.
     */
    /**
     * ASSIGN_PEER_ID 로 peers 키가 'default' -> 'guest_...' 로 바뀌어도 현재 살아있는 피어를 찾도록 키를 보정합니다.
     */
    function resolvePeerKey(id) {
        if (peers[id]) return id;
        const keys = Object.keys(peers);
        if (keys.length === 1) return keys[0];
        return id;
    }

    /**
     * 후보 재수집 등으로 교체되어 peers 맵에서 빠진 이전 피어 객체는 null 을 돌려줍니다.
     */
    function findPeerKey(target) {
        return Object.keys(peers).find(id => peers[id] === target) || null;
    }

    function addPeer(peerId, isInitiator) {
        if (peers[peerId]) return;
        try {
            log('Initializing WebRTC peer connection (isInitiator: ' + isInitiator + ')...');
            const p = new SimplePeer({
                initiator: isInitiator,
                trickle: false,
                iceCompleteTimeout: ICE_COMPLETE_TIMEOUT_MS,
                config: { iceServers: iceServers }
            });

            setupWebRTCPeer(peerId, p);
            peers[peerId] = p;
        } catch(e) { log('Error: ' + e.message); }
    }

    /**
     * P2P 엔진 연결을 활성화합니다.
     */
    window.startEngine = function(initiator, autoStart, roomName, turnConfig, peerId, stunServers) {
        stopEngine(); // 기존 실행 중인 엔진 정지
        // 새 세션 시작이므로 이전 엔진 정리 중 발생한 이벤트가 새 인스턴스에 영향을 주지 않도록 초기화합니다.
        isStoppingEngine = false;
        hasActiveRoomSession = false;

        currentInitiator = initiator;
        // 확장 호스트(Node)가 호스트 이름을 미리 IP로 해석해 전달한 STUN 목록을 우선 사용합니다.
        const stunUrls = (Array.isArray(stunServers) && stunServers.length > 0) ? stunServers : DEFAULT_STUN_URLS;
        iceServers = stunUrls.map(url => ({ urls: url }));
        log('STUN 서버 ' + iceServers.length + '개: ' + stunUrls.join(', '));
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
                    // 호스트는 방이 시그널링 서버에 등록된 시점부터 '방에 입장한 상태'로 간주합니다.
                    hasActiveRoomSession = true;
                    log('Created room: "' + rName + '". Waiting for guest connection...');
                    vscode.postMessage({ type: 'roomNameSuccess' });
                } else {
                    log('Connecting to room host for room: "' + rName + '"...');
                    const conn = peerServer.connect(toSafeId(rName));
                    handleSignalingConn(conn);

                    // 게스트 시그널링 채널 조기 타임아웃(3.5초) 설정
                    // 호스트가 아직 서버에 미등록 상태일 때 PeerJS 기본 타임아웃(20초 EXPIRE) 대기로 인한 기회 박탈 방지
                    if (guestSignalingConnectTimer) {
                        clearTimeout(guestSignalingConnectTimer);
                    }
                    guestSignalingConnectTimer = setTimeout(() => {
                        guestSignalingConnectTimer = null;
                        if (!currentInitiator && guestSignalingConn === conn && !conn.open) {
                            log('Guest signaling connection early timeout (3.5s): Host not responding yet. Closing connection to trigger retry probe...');
                            try { conn.close(); } catch(e) {}
                            vscode.postMessage({ type: 'roomNameError', errorType: 'unavailable' });
                        }
                    }, 3500);
                }
            });

            peerServer.on('connection', (conn) => {
                log('Received connection request from guest signaling client.');
                handleSignalingConn(conn);
            });

            peerServer.on('disconnected', () => {
                // stopEngine()의 destroy() 호출로 인한 의도적 종료라면 재연결/팝업을 수행하지 않습니다.
                if (isStoppingEngine || !wasOpened || !peerServer || peerServer.destroyed) return;
                // 방 세션이 성립된 상태(방에 입장해 있는 동안)에서만 자동 재연결을 시도합니다.
                if (!hasActiveRoomSession) {
                    log('Signaling server disconnected before an active room session. Skipping auto-reconnect.');
                    return;
                }
                log('PeerJS connection to signaling server lost. Reconnecting...');
                vscode.postMessage({ type: 'logMessage', level: 'warning', text: 'PeerJS 시그널링 서버와의 연결이 끊어졌습니다. 자동으로 재연결을 시도합니다...' });
                peerServer.reconnect();
            });

            peerServer.on('error', (err) => {
                log('PeerJS Connection Error: ' + err.type);
                if (!currentInitiator) {
                    if (guestSignalingConnectTimer) {
                        clearTimeout(guestSignalingConnectTimer);
                        guestSignalingConnectTimer = null;
                    }
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
                            }, 800);
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
            if (!currentInitiator) {
                guestSignalingConn = conn;
            }
            conn.on('open', () => {
                if (guestSignalingConnectTimer) {
                    clearTimeout(guestSignalingConnectTimer);
                    guestSignalingConnectTimer = null;
                }
                log('Signaling channel established.');
                if (!currentInitiator) {
                    log('Requesting SDP offer from host...');
                    conn.send({ type: 'REQ_OFFER' });
                }
            });

            conn.on('data', (data) => {
                if (data.type === 'REQ_OFFER') {
                    // 아직 시그널링 커넥션이 바인딩되지 않았고, SDP가 준비된 오퍼 슬롯 검색
                    const targetId = Object.keys(peers).find(id => 
                        !peers[id].connected && 
                        peers[id].initiator && 
                        pendingSdpMap[id] && 
                        !peerSignalingConnMap[id]
                    );
                    if (targetId && pendingSdpMap[targetId]) {
                        log('Sending SDP offer to guest immediately (targetId: ' + targetId + ')...');
                        peerSignalingConnMap[targetId] = conn;
                        connPeerIdMap.set(conn, targetId);
                        conn.send({ type: 'SDP', sdp: pendingSdpMap[targetId], peerId: targetId });
                    } else {
                        log('No unassigned SDP offer ready yet. Queuing signaling connection and requesting invite slot from host...');
                        pendingSignalingQueue.push({ conn, timestamp: Date.now() });
                        vscode.postMessage({ type: 'requireInvite' });
                    }
                } else if (data.type === 'SDP') {
                    let targetId;
                    if (currentInitiator) {
                        targetId = data.peerId || connPeerIdMap.get(conn);
                        if (!targetId) {
                            targetId = Object.keys(peers).find(id => !peers[id].connected && peers[id].initiator);
                        }
                        if (targetId) {
                            peerSignalingConnMap[targetId] = conn;
                            connPeerIdMap.set(conn, targetId);
                        }
                    } else {
                        targetId = 'default';
                        remotePeerIdMap['default'] = data.peerId;
                    }

                    if (!targetId || !peers[targetId]) {
                        log('Target peer not found for SDP signal (targetId: ' + targetId + ')');
                        return;
                    }
                    if (peers[targetId].connected) return;

                    log('Received SDP exchange signal from ' + (currentInitiator ? 'guest' : 'host') + ' (targetId: ' + targetId + '). Applying signal...');
                    window.dispatchEvent(new MessageEvent('message', { data: { type: 'signal', sdp: data.sdp, peerId: targetId } }));
                }
            });

            conn.on('close', () => {
                log('Signaling channel connection closed.');
                if (!currentInitiator && guestSignalingConn === conn) {
                    guestSignalingConn = null;
                }
                const boundPeerId = connPeerIdMap.get(conn);
                if (boundPeerId && peerSignalingConnMap[boundPeerId] === conn) {
                    delete peerSignalingConnMap[boundPeerId];
                }
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
            window.startEngine(m.initiator, m.autoStart, m.roomName, m.turnConfig, m.peerId, m.stunServers);
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
            remoteSignalMap[m.newId] = remoteSignalMap[m.oldId];
            srflxAttemptMap[m.newId] = srflxAttemptMap[m.oldId];
            delete peers[m.oldId];
            delete pendingSdpMap[m.oldId];
            delete remoteSignalMap[m.oldId];
            delete srflxAttemptMap[m.oldId];
        }
        if (m.type === 'disconnectPeer') {
            const pId = m.peerId;
            if (peers[pId]) {
                try { peers[pId].destroy(); } catch(e) {}
                delete peers[pId];
                delete pendingSdpMap[pId];
                if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
            }
            return;
        }
        if (m.type === 'addNewPeer') addPeer(m.peerId, m.initiator);
        if (m.type === 'signal') {
            const key = resolvePeerKey(targetId);
            if (peers[key]) {
                remoteSignalMap[key] = m.sdp;
                srflxAttemptMap[key] = 0;
                peers[key].signal(prepareRemoteSignalFor(peers[key], m.sdp));
            }
        }
        if (m.type === 'peerData') {
            const data = new TextEncoder().encode(JSON.stringify(m.value));

            function safeSend(peer, payload, retries = 3) {
                if (!peer) return;
                // 아직 연결 수립 중인 피어라면 100ms 후 최대 3회 재시도 (초기 핸드셰이크 시 패킷 유실 방지)
                if (!peer.connected) {
                    if (retries > 0) {
                        setTimeout(() => safeSend(peer, payload, retries - 1), 100);
                    }
                    return;
                }
                const channel = peer._channel;
                // SCTP 버퍼가 1MB 이상 적체된 경우 잠시 대기 후 안전 발송
                if (channel && channel.bufferedAmount > 1024 * 1024) {
                    setTimeout(() => {
                        if (peer.connected) {
                            try { peer.send(payload); } catch(e) {}
                        }
                    }, 50);
                } else {
                    try { peer.send(payload); } catch(e) {}
                }
            }

            if (m.targetPeerId) {
                const key = resolvePeerKey(m.targetPeerId);
                if (peers[key]) safeSend(peers[key], data);
            } else {
                Object.values(peers).forEach(p => safeSend(p, data));
            }
        }
    });

    // 주기적 하트비트 전송
    setInterval(() => {
        Object.values(peers).forEach(p => {
            if (p.connected) p.send(new Uint8Array([255]));
        });
    }, 5000);
})();
