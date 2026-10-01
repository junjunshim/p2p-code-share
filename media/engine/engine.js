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
    let pendingPeerAdds = {};  // 피어 생성 진행 중 플래그(중복 생성 및 TURN 요청 폭주 방지)
    let pendingIceServersPromise = null; // 진행 중인 iceServers 준비 Promise 공유용
    let remoteSignalMap = {}; // 피어별 마지막 원격 signal (재시도 시 같은 offer 재적용용)
    let pendingSignalingQueue = [];
    let iceServers = [];
    let currentInitiator = false;
    let myLocalIps = []; // 확장 호스트가 전달한 실제 사설 LAN IP 목록 (mDNS 난독화 host 후보 보강용)
    let turnRole = 'guest';        // 이 세션에서 Worker에 요청할 TURN 자격 증명 역할(host/guest)
    let sessionIceServers = [];    // 시그널링 채널용 iceServers (TURN 자격 증명 포함)
    let iceServersSettled = false; // TURN 조회까지 끝나 sessionIceServers 가 확정되었는지 여부
    let iceServersFallback = null; // 유예 시간 초과로 STUN-only 진행할 때 사용한 목록
    let turnGraceExceeded = false; // 유예 시간 초과로 STUN-only 진행을 이미 시작했는지 여부
    let turnUnavailableAt = 0;     // TURN 자격 증명 없이 확정된 시각(쿨다운 후 재시도용)
    let iceReadyPromise = null;    // 시그널링 소켓과 병렬로 진행하는 ICE 설정 확정 Promise
    let iceReadyResolved = false;  // ICE 설정(또는 유예 폴백)이 확정되어 제어 채널 connect 가 가능한지 여부
    let lastJoinStageKey = '';     // 게스트 진행 단계 표시의 중복 전송을 막기 위한 마지막 단계 키
    let roomUnavailableDetected = false; // 방이 서버에 없음(peer-unavailable) → 게스트의 추가 연결 시도 중단
    let controlExpandStats = { offer: 0, answer: 0, candidate: 0 }; // 제어 P2P 시그널링 후보 확장 횟수(진단용)
    let engineGeneration = 0;      // stopEngine/startEngine 마다 증가시켜 지연된 비동기 작업을 무효화
    let pendingTurnRequests = {};  // requestId -> Worker 응답 대기 resolver
    let pendingRemoteSignals = {}; // TURN 자격 증명을 받아 피어를 만드는 동안 도착한 원격 signal 보관소
    let incomingChunkBuffers = new Map(); // 분할 전송된 대용량 패킷(파일 스냅샷 등) 청크 조립 버퍼

    // 피어별 전송 FIFO 큐: 대용량 청크가 SCTP 버퍼에 적체되는 동안에도 순서를 보장하고,
    // 소형 패킷(예: 스냅샷 전송 중 발생한 Yjs 델타)이 재시도 예산 부족으로 조용히 유실되는 것을 막는다.
    const peerSendQueues = new Map(); // peer 객체 -> { items: [{ payload, enqueuedAt, group }], timer }
    const SEND_BUFFER_HIGH_WATER = 1024 * 1024; // SCTP bufferedAmount 상한(1MB)
    const SEND_RETRY_DELAY_MS = 50;
    const SEND_NOT_CONNECTED_DELAY_MS = 100;
    const SEND_ITEM_TIMEOUT_MS = 30000;

    /**
     * 큐에 전송 항목을 넣고 즉시 드레인을 시도합니다.
     * @param peer simple-peer 인스턴스.
     * @param payload 전송할 바이너리.
     * @param group 대용량 분할 전송의 묶음 식별자(일반 패킷은 undefined).
     */
    function enqueueSend(peer, payload, group) {
        if (!peer) return;
        let queue = peerSendQueues.get(peer);
        if (!queue) {
            queue = { items: [], timer: null };
            peerSendQueues.set(peer, queue);
        }
        queue.items.push({ payload, enqueuedAt: Date.now(), group: group || null });
        drainSendQueue(peer);
    }

    /**
     * 피어별 전송 큐를 앞에서부터 비웁니다. 미연결이거나 SCTP 버퍼가 적체되면 잠시 후 재시도합니다.
     * @param peer simple-peer 인스턴스.
     */
    function drainSendQueue(peer) {
        const queue = peerSendQueues.get(peer);
        if (!queue || queue.timer) return;

        if (!peer || peer.destroyed) {
            dropSendQueue(peer, 'P2P 피어가 종료되어 대기 중인 패킷을 폐기했습니다.');
            return;
        }

        while (queue.items.length > 0) {
            const item = queue.items[0];

            if (Date.now() - item.enqueuedAt > SEND_ITEM_TIMEOUT_MS) {
                queue.items.shift();
                if (item.group) {
                    const before = queue.items.length;
                    queue.items = queue.items.filter(it => it.group !== item.group);
                    log('P2P 전송 중단: 대용량 패킷이 제한 시간 내에 전송되지 않았습니다. (' + item.group + ', ' + (before - queue.items.length + 1) + '건 폐기)');
                } else {
                    log('P2P 전송 시간 초과로 대기 중이던 패킷 1건을 폐기했습니다.');
                }
                continue;
            }

            if (!peer.connected) {
                queue.timer = setTimeout(() => { queue.timer = null; drainSendQueue(peer); }, SEND_NOT_CONNECTED_DELAY_MS);
                return;
            }

            const channel = peer._channel;
            if (channel && channel.bufferedAmount > SEND_BUFFER_HIGH_WATER) {
                // 적체가 풀릴 때까지 순서를 유지한 채 대기한다(드롭 방지).
                queue.timer = setTimeout(() => { queue.timer = null; drainSendQueue(peer); }, SEND_RETRY_DELAY_MS);
                return;
            }

            queue.items.shift();
            try {
                peer.send(item.payload);
            } catch (e) {
                // 실패를 조용히 삼키면 호스트만 전송된 것처럼 보이므로 반드시 로그를 남긴다.
                log('P2P 전송 실패: ' + (e && e.message ? e.message : e));
            }
        }

        dropSendQueue(peer);
    }

    /**
     * 피어의 전송 큐와 예약된 재시도 타이머를 제거합니다.
     * @param peer simple-peer 인스턴스.
     * @param reason 로그로 남길 사유(선택).
     */
    function dropSendQueue(peer, reason) {
        const queue = peerSendQueues.get(peer);
        if (!queue) return;
        if (queue.timer) clearTimeout(queue.timer);
        if (reason && queue.items.length > 0) {
            log(reason + ' (대기 ' + queue.items.length + '건)');
        }
        peerSendQueues.delete(peer);
    }

    // 확장 호스트에서 STUN 목록을 전달하지 못했을 때 사용하는 기본 STUN 서버
    const DEFAULT_STUN_URLS = [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302'
    ];

    // 제어 채널(PeerJS 시그널링 DataConnection) 수명주기 계측: 간헐 실패 원인을 로그만으로 구분하기 위함.
    let signalingSocketOpens = 0;        // 세션 내 시그널링 소켓 open 횟수
    let signalingSocketReconnects = 0;   // 세션 내 시그널링 소켓 재연결 횟수(고스트/교체 창 추정 지표)
    let lastSignalingReconnectAt = 0;    // 마지막 재연결 시도 시각
    let signalingWasReconnecting = false; // 실패 시점에 재연결 진행 중이었는지 여부
    let activeRoomName = '';             // 현재 세션의 방 이름(제어 채널 재시도에 사용)
    let activeRoomPeerId = '';           // 현재 방의 PeerJS 피어 ID
    let controlChannelRetryCount = 0;    // 세션 내 제어 채널 재생성 횟수
    let guestSignalingConnOpenedAt = 0;  // 현재 게스트 제어 채널을 만든 시각(소켓 재연결 시 중복 connect 방지)
    let renamedPeerIds = {};             // updatePeerId 로 바뀐 이전 피어 키 -> 새 키(늦게 도착한 signal 라우팅용)
    let receivedRemoteSignalAt = 0;      // 이번 세션에서 원격 SDP signal 을 처음 적용한 시각(제어 채널 조기 종료 복구 판단용)
    let controlChannelProbeTimer = null; // 제어 채널 재생성 프로브 예약 타이머(이전 세션 지연 콜백 방지를 위해 세션 종료 시 정리)

    /** 분할 전송 조립 버퍼 키: peerId 는 세션 중 바뀔 수 있으므로 피어 객체에 고정 키를 부여합니다. */
    const peerTransferKeys = new WeakMap();
    let peerTransferKeySeq = 0;

    /** 피어 객체별로 세션 동안 변하지 않는 전송 조립 키를 돌려줍니다. */
    function getPeerTransferKey(peer) {
        let key = peerTransferKeys.get(peer);
        if (!key) {
            key = 'pk' + (++peerTransferKeySeq);
            peerTransferKeys.set(peer, key);
        }
        return key;
    }

    /** 원격 description을 받은 뒤 이 시간 동안 원격 후보가 0건이면 제어 채널이 멈춘 것으로 본다. */
    const CONTROL_CANDIDATE_WATCHDOG_MS = 4000;

    /** 세션당 제어 채널 재생성 최대 횟수(무한 재시도 방지) */
    const CONTROL_CHANNEL_RETRY_MAX = 3;

    /** 게스트 제어 채널이 진전을 보이지 않을 때 재생성 프로브를 트리거하는 시간(ms) */
    const GUEST_CONTROL_GUARD_MS = 8000;

    /** 이미 만든 제어 채널을 재사용할 최대 나이(ms). 이보다 오래됐고 아직 안 열렸으면 새로 만듭니다. */
    const GUEST_CONTROL_CONNECT_STALE_MS = 25000;

    /** 데이터 피어가 이 시간 동안 원격 signal 조차 받지 못하면 조기 실패로 보고합니다(30초 타임아웃 대기 방지). */
    const DATA_PEER_WATCHDOG_MS = 12000;

    /** SDP 재전송 간격/횟수: 시그널링 채널이 아직 열리지 않았을 때 SDP 를 잃지 않도록 재시도합니다. */
    const SDP_RESEND_INTERVAL_MS = 700;
    const SDP_RESEND_MAX_ATTEMPTS = 8;

    /** peerId -> { attempts, timer } : 시그널링 채널 미개방 상태의 SDP 재전송 상태 */
    const sdpResendState = {};

    /** peerId -> { conn, sdp } : 같은 시그널링 채널로 같은 SDP 를 두 번 보내지 않기 위한 기록 */
    const sentSdpMap = {};

    /** peerId 의 SDP 전송 기록을 지웁니다(피어 종료/키 변경 시). */
    function clearSentSdp(peerId) {
        delete sentSdpMap[peerId];
    }

    /**
     * 시그널링 채널로 SDP 를 전송합니다.
     * 같은 채널에 같은 SDP 를 두 번 보내면 상대가 answer 를 두 번 만들어 setLocalDescription 이
     * wrong state(stable) 로 실패하므로, 중복 전송을 건너뜁니다.
     * @returns 실제로 전송했으면 true, 중복이라 건너뛰었으면 false.
     */
    function sendSdpToConn(peerId, conn, sdpStr, label) {
        const last = sentSdpMap[peerId];
        if (last && last.conn === conn && last.sdp === sdpStr) {
            log('중복 SDP 전송 생략 (' + label + ', peer ' + peerId + ')');
            clearSdpResend(peerId);
            return false;
        }
        conn.send({ type: 'SDP', sdp: sdpStr, peerId: remotePeerIdMap[peerId] || peerId });
        sentSdpMap[peerId] = { conn: conn, sdp: sdpStr };
        clearSdpResend(peerId);
        return true;
    }

    /** SDP 재전송 타이머를 정리합니다(전송 성공/피어 종료 시). */
    function clearSdpResend(peerId) {
        const state = sdpResendState[peerId];
        if (!state) return;
        if (state.timer) clearTimeout(state.timer);
        delete sdpResendState[peerId];
    }

    /**
     * simple-peer가 ICE 수집 완료를 기다리는 시간(ms).
     * 기본값 5초보다 길게 잡아야 STUN 응답이 느린 네트워크에서도 srflx(공인 IP) 후보가 SDP에 포함됩니다.
     */
    const ICE_COMPLETE_TIMEOUT_MS = 5000;

    /** SDP를 전달하기 전에 실제 ICE 수집 완료를 추가로 기다리는 최대 시간(ms) */
    const ICE_GATHERING_WAIT_MS = 6000;

    /** Worker TURN 자격 증명 응답을 기다리는 최대 시간(ms). 초과하면 STUN만으로 SDP 교환을 진행합니다. */
    const TURN_REQUEST_TIMEOUT_MS = 6000;

    /**
     * TURN 자격 증명 응답을 "다음 단계 진행 전에" 기다리는 유예 시간(ms).
     * 이 시간을 넘기면 STUN-only 로 먼저 진행하고, 늦게 도착한 응답은 다음 피어 생성부터 반영합니다.
     * Worker 가 꺼져 있어도(404/무응답) 초기 연결이 지연되지 않게 하기 위한 값입니다.
     */
    const TURN_PREPARE_GRACE_MS = 1200;

    /**
     * TURN 자격 증명을 받지 못한 상태에서 다시 요청하기까지의 최소 간격(ms).
     * Worker가 꺼져 있으면 이 간격 동안은 재요청하지 않고 STUN-only로 즉시 진행하며,
     * Worker가 다시 살아나면 다음 피어 생성부터 TURN이 반영됩니다.
     */
    const TURN_UNAVAILABLE_RETRY_MS = 15000;

    /**
     * mDNS(*.local)로 난독화된 host 후보인지 판별합니다.
     * SDP 속성 라인('a=candidate:...')과 단일 후보 문자열('candidate:...')을 모두 처리합니다.
     */
    function isMdnsHostCandidate(line) {
        if (!line || typeof line !== 'string') return false;
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 8) return false;
        const head = tokens[0];
        if (head.indexOf('a=candidate:') !== 0 && head.indexOf('candidate:') !== 0) return false;
        return tokens[7] === 'host' && /\.local$/i.test(tokens[4]);
    }

    /**
     * mDNS로 난독화된 host 후보를 실제 사설 IP 후보들로 확장합니다.
     *
     * Chromium은 사설 IP 노출을 막기 위해 host 후보 주소를 mDNS 이름으로 바꿉니다. 서로 다른 장비 간
     * LAN 연결에서는 이 이름이 해석되지 않을 수 있으므로 실제 IP 후보가 필요합니다. 어떤 IP가 실제
     * 경로인지 알 수 없어 하나를 골라 치환하지 않고, 모든 로컬 IP 후보를 추가합니다(원본 mDNS 후보도 유지).
     * 도달 불가능한 후보는 ICE가 알아서 버립니다.
     */
    function expandMdnsCandidate(line) {
        if (!isMdnsHostCandidate(line) || myLocalIps.length === 0) return [line];
        const tokens = line.trim().split(/\s+/);
        const foundation = tokens[0];
        const expanded = [line];
        myLocalIps.forEach((ip, index) => {
            const candidate = tokens.slice();
            // 확장한 후보마다 서로 다른 foundation을 부여해 ICE가 중복 후보로 접어버리지 않게 합니다.
            candidate[0] = foundation + 'LAN' + (index + 1);
            candidate[4] = ip;
            expanded.push(candidate.join(' '));
        });
        return expanded;
    }

    /**
     * 시그널링으로 내보낼 후보 초기화 객체를 만듭니다.
     * RTCIceCandidate의 candidate/sdpMid/sdpMLineIndex 는 prototype getter 라 Object.assign 으로
     * 복사되지 않습니다. 재구성하면 sdpMid/sdpMLineIndex 가 사라져 수신 측 addIceCandidate 가
     * 실패하므로, toJSON() 이 있으면 사용하고 필요한 필드만 개별 복사합니다.
     */
    function buildCandidateInit(source, candidateLine) {
        const json = (source && typeof source.toJSON === 'function') ? source.toJSON() : source;
        const init = { candidate: candidateLine };
        if (json && json.sdpMid !== undefined && json.sdpMid !== null) {
            init.sdpMid = json.sdpMid;
        }
        if (json && json.sdpMLineIndex !== undefined && json.sdpMLineIndex !== null) {
            init.sdpMLineIndex = json.sdpMLineIndex;
        }
        if (json && typeof json.usernameFragment === 'string') {
            init.usernameFragment = json.usernameFragment;
        }
        return init;
    }

    /** SDP 본문의 mDNS host 후보를 로컬 IP 후보로 확장합니다. */
    function expandMdnsInSdp(sdp) {
        if (typeof sdp !== 'string' || sdp.length === 0 || myLocalIps.length === 0) return sdp;
        if (sdp.indexOf('.local') < 0) return sdp;
        const lines = sdp.split(/\r?\n/);
        const expandedLines = [];
        lines.forEach(line => {
            if (line.indexOf('a=candidate:') === 0) {
                expandMdnsCandidate(line).forEach(candidateLine => expandedLines.push(candidateLine));
            } else {
                expandedLines.push(line);
            }
        });
        return expandedLines.join('\r\n');
    }

    /**
     * PeerJS 시그널링 소켓으로 나가는 CANDIDATE/OFFER/ANSWER의 mDNS 주소를 확장합니다.
     * 호스트↔게스트 시그널링 채널 자체도 WebRTC DataConnection이므로, 후보가 mDNS뿐이면
     * 다른 장비와 시그널링 채널부터 연결되지 않습니다.
     */
    function installSignalingCandidateRewrite(server) {
        if (!server || !server.socket || typeof server.socket.send !== 'function') return;
        if (server.socket.__mdnsExpandInstalled) return;
        server.socket.__mdnsExpandInstalled = true;
        const originalSend = server.socket.send;

        server.socket.send = function (message) {
            try {
                if (message && message.payload && myLocalIps.length > 0) {
                    if (message.type === 'CANDIDATE' && message.payload.candidate &&
                        typeof message.payload.candidate.candidate === 'string') {
                        const candidateLines = expandMdnsCandidate(message.payload.candidate.candidate);
                        if (candidateLines.length > 1) {
                            controlExpandStats.candidate++;
                            if (controlExpandStats.candidate <= 8) {
                                log('[mDNS Expand] control CANDIDATE 확장: ' + candidateLines.length + '개 라인 (누적 ' + controlExpandStats.candidate + ')');
                            }
                            // 원본 후보 메시지는 손대지 않고 그대로 보냅니다(sdpMid/sdpMLineIndex 보존).
                            originalSend.call(this, message);
                            for (let i = 1; i < candidateLines.length; i++) {
                                const expanded = Object.assign({}, message, {
                                    payload: Object.assign({}, message.payload, {
                                        candidate: buildCandidateInit(message.payload.candidate, candidateLines[i])
                                    })
                                });
                                originalSend.call(this, expanded);
                            }
                            return;
                        }
                    } else if ((message.type === 'OFFER' || message.type === 'ANSWER') && message.payload.sdp) {
                        const sdpPayload = message.payload.sdp;
                        const sdpText = (typeof sdpPayload === 'string') ? sdpPayload : (typeof sdpPayload.sdp === 'string' ? sdpPayload.sdp : '');
                        const expandedSdp = sdpText ? expandMdnsInSdp(sdpText) : sdpText;
                        if (expandedSdp && expandedSdp !== sdpText) {
                            if (message.type === 'OFFER') controlExpandStats.offer++;
                            else controlExpandStats.answer++;
                            log('[mDNS Expand] control ' + message.type + ' SDP 후보 ' + formatCandidateCounts(countCandidatesByType(sdpText))
                                + ' -> ' + formatCandidateCounts(countCandidatesByType(expandedSdp)) + ' (주입 LAN IP ' + myLocalIps.length + '개)');
                            if (typeof sdpPayload === 'string') {
                                message.payload.sdp = expandedSdp;
                            } else {
                                message.payload.sdp = Object.assign({}, sdpPayload, { sdp: expandedSdp });
                            }
                        }
                    }
                }
            } catch (e) {
                log('[mDNS Expand] signaling candidate rewrite failed: ' + e.message);
            }
            return originalSend.apply(this, arguments);
        };
    }

    /** STUN 목록에 Worker에서 받은 TURN 자격 증명을 더해 RTCPeerConnection 설정을 만듭니다. */
    function buildIceServers(turnConfigs) {
        const servers = iceServers.slice();
        (Array.isArray(turnConfigs) ? turnConfigs : []).forEach(cfg => {
            if (!cfg) return;
            if (cfg.urls) {
                servers.push(cfg);
            } else if (cfg.url) {
                servers.push({ urls: cfg.url, username: cfg.username, credential: cfg.credential });
            }
        });
        return servers;
    }

    /**
     * 확장 호스트(Node)에 Cloudflare Worker TURN 자격 증명 발급을 요청합니다.
     * Worker가 404/오류/무응답이면 빈 배열을 돌려주고, 호출 측은 STUN만으로 SDP 교환을 진행합니다.
     */
    function requestTurnCredentials() {
        return new Promise(resolve => {
            const requestId = 'turn_' + Date.now() + '_' + Math.random().toString(36).slice(2);
            let settled = false;
            const finish = list => {
                if (settled) return;
                settled = true;
                delete pendingTurnRequests[requestId];
                resolve(Array.isArray(list) ? list : []);
            };
            pendingTurnRequests[requestId] = finish;
            setTimeout(() => {
                if (pendingTurnRequests[requestId]) {
                    log('TURN 자격 증명 응답 시간 초과: STUN만으로 SDP 교환을 진행합니다.');
                }
                finish([]);
            }, TURN_REQUEST_TIMEOUT_MS);
            try {
                vscode.postMessage({ type: 'requestTurnCredentials', requestId, role: turnRole });
            } catch (e) {
                log('TURN 자격 증명 요청 전송 실패: ' + e.message);
                finish([]);
            }
        });
    }

    /**
     * SDP/시그널링 채널을 만들기 직전에 호출되어 TURN 자격 증명까지 포함한 iceServers 를 준비합니다.
     * Worker 응답이 없으면 STUN 목록만 반환하므로 SDP 교환은 그대로 진행됩니다.
     */
    function prepareIceServers() {
        const callGeneration = engineGeneration;

        // 같은 세션에서 여러 피어가 동시에 만들어질 때 TURN 자격 증명 요청이 중복되지 않도록
        // 진행 중인 요청을 공유합니다.
        // TURN 없이 확정된 경우에는 쿨다운이 지난 뒤에만 다시 요청합니다(Worker 재가동 반영).
        const turnRetryAllowed = turnUnavailableAt === 0 || (Date.now() - turnUnavailableAt) >= TURN_UNAVAILABLE_RETRY_MS;
        if (!pendingIceServersPromise && !iceServersSettled && turnRetryAllowed) {
            const generation = callGeneration;
            const pending = requestTurnCredentials()
                .then(turnConfigs => {
                    const servers = buildIceServers(turnConfigs);
                    if (generation !== engineGeneration) return servers;
                    log('ICE servers - STUN ' + iceServers.length + ', TURN ' + (servers.length - iceServers.length));
                    sessionIceServers = servers;
                    if (servers.length === iceServers.length) {
                        // TURN 없음: 세션 전체를 STUN-only로 굳히지 않고 쿨다운 후 다시 시도합니다.
                        turnUnavailableAt = Date.now();
                        log('TURN 자격 증명 없음(Worker 미가동/실패). STUN-only 로 진행합니다. (' + (TURN_UNAVAILABLE_RETRY_MS / 1000) + '초 후 재시도)');
                    } else {
                        // 늦게 도착한 응답도 다음 피어 생성/제어 채널부터 반영되도록 세션 값으로 확정합니다.
                        iceServersSettled = true;
                    }
                    return servers;
                })
                .then(result => {
                    // 엔진이 재시작되었거나 이미 새 요청으로 교체되었다면 공유 캐시를 건드리지 않습니다.
                    if (generation === engineGeneration && pendingIceServersPromise === pending) {
                        pendingIceServersPromise = null;
                    }
                    return result;
                }, error => {
                    if (generation === engineGeneration && pendingIceServersPromise === pending) {
                        pendingIceServersPromise = null;
                    }
                    throw error;
                });
            pendingIceServersPromise = pending;
        }

        // TURN 조회가 이미 끝났으면 확정된 목록을 즉시 사용합니다.
        if (iceServersSettled) {
            return Promise.resolve(sessionIceServers);
        }
        // 이미 유예 시간을 넘겨 STUN-only 로 진행 중이면 같은 목록을 즉시 돌려줍니다.
        if (turnGraceExceeded) {
            return Promise.resolve(iceServersFallback || buildIceServers([]));
        }
        if (!pendingIceServersPromise) {
            return Promise.resolve(buildIceServers([]));
        }

        // 응답이 유예 시간 안에 오면 TURN 포함 목록으로, 늦으면 STUN-only 로 진행합니다.
        return Promise.race([
            pendingIceServersPromise,
            new Promise(resolve => setTimeout(() => {
                const stunOnly = buildIceServers([]);
                if (callGeneration === engineGeneration) {
                    turnGraceExceeded = true;
                    iceServersFallback = stunOnly;
                    log('TURN 자격 증명 응답이 ' + TURN_PREPARE_GRACE_MS + 'ms 안에 도착하지 않아 STUN-only 로 먼저 진행합니다. (응답이 오면 다음 피어부터 반영)');
                }
                resolve(stunOnly);
            }, TURN_PREPARE_GRACE_MS))
        ]);
    }

    /**
     * 이미 생성된 PeerJS 피어의 ICE 설정에 확정된 iceServers 를 반영합니다.
     * PeerJS 는 DataConnection 협상 시점(_startPeerConnection)에 provider.options.config 를 읽으므로,
     * connect() 직전에 갱신하면 해당 연결부터 TURN 후보가 적용됩니다.
     */
    function applyIceServersToPeerServer() {
        if (!peerServer || peerServer.destroyed) return;
        try {
            const opts = peerServer.options;
            if (!opts) return;
            opts.config = Object.assign({}, opts.config || {}, { iceServers: sessionIceServers });
            log('시그널링 소켓에 ICE 설정을 반영했습니다 (STUN ' + (iceServers ? iceServers.length : 0)
                + ', 전체 ' + sessionIceServers.length + ').');
        } catch (e) {
            log('ICE 설정을 PeerJS 옵션에 반영하지 못했습니다: ' + (e && e.message ? e.message : e));
        }
    }

    /**
     * ICE 설정(또는 유예 폴백)이 확정될 때까지 기다리는 Promise 를 반환합니다.
     * 이미 확정됐으면 즉시 해결됩니다.
     */
    function whenIceReady() {
        if (iceReadyResolved) {
            return Promise.resolve(sessionIceServers.length ? sessionIceServers : buildIceServers([]));
        }
        if (iceReadyPromise) {
            return iceReadyPromise.then(servers => {
                iceReadyResolved = true;
                return servers;
            });
        }
        return Promise.resolve(sessionIceServers.length ? sessionIceServers : buildIceServers([]));
    }

    /** TURN 자격 증명을 기다리는 동안 도착한 원격 signal 을 보관합니다. */
    function queueRemoteSignal(peerId, signal) {
        if (signal === undefined || signal === null) return;
        (pendingRemoteSignals[peerId] = pendingRemoteSignals[peerId] || []).push(signal);
    }


    /**
     * 로그 메시지를 콘솔에 출력합니다.
     */
    function log(m) {
        console.log('[P2P Engine]', m);
    }

    /**
     * 게스트 화면의 진행 단계 표시를 갱신합니다. 호스트에게는 표시되지 않으므로 게스트일 때만 보냅니다.
     * 같은 단계는 다시 보내지 않아 시그널링 채널을 불필요하게 점유하지 않습니다.
     * @param key 단계 키(예: 'signaling', 'control-connecting', 'approval').
     * @param text 사용자에게 보여 줄 설명 문구.
     */
    function postJoinStage(key, text) {
        if (currentInitiator) return;
        if (key === lastJoinStageKey) return;
        lastJoinStageKey = key;
        try {
            vscode.postMessage({ type: 'joinProgress', stage: key, text: text || '' });
        } catch (e) {
            // 확장 호스트가 아직 준비되지 않은 경우는 무시합니다.
        }
    }

    /**
     * P2P 엔진 및 연결을 종료합니다.
     */
    function stopEngine() {
        log('Stopping P2P engine and disposing connections...');
        myLocalIps = [];
        controlExpandStats = { offer: 0, answer: 0, candidate: 0 };
        signalingSocketOpens = 0;
        signalingSocketReconnects = 0;
        lastSignalingReconnectAt = 0;
        signalingWasReconnecting = false;
        activeRoomName = '';
        activeRoomPeerId = '';
        controlChannelRetryCount = 0;
        guestSignalingConnOpenedAt = 0;
        renamedPeerIds = {};
        receivedRemoteSignalAt = 0;
        if (controlChannelProbeTimer) {
            clearTimeout(controlChannelProbeTimer);
            controlChannelProbeTimer = null;
        }
        Object.keys(sdpResendState).forEach(id => clearSdpResend(id));
        Object.keys(sentSdpMap).forEach(id => clearSentSdp(id));
        // 진행 중이던 비동기 작업(TURN 조회 등)의 결과가 새 세션에 영향을 주지 않도록 세대를 올립니다.
        engineGeneration++;
        sessionIceServers = [];
        iceServersSettled = false;
        iceServersFallback = null;
        turnGraceExceeded = false;
        turnUnavailableAt = 0;
        lastJoinStageKey = '';
        roomUnavailableDetected = false;
        pendingTurnRequests = {};
        pendingRemoteSignals = {};
        pendingPeerAdds = {};
        pendingIceServersPromise = null;
        iceReadyPromise = null;
        iceReadyResolved = false;
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
        peerSendQueues.clear();
        pendingSignalingQueue = [];
        peerSignalingConnMap = {};
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
                    sendSdpToConn(readyTargetId, req.conn, sdp, 'invite flush');
                }
            } catch (err) {
                log('Failed to send SDP to queued connection: ' + err.message);
            }
        }
    }

    /**
     * 제어 P2P(PeerJS DataConnection)의 선택된 ICE 쌍을 로그로 남깁니다.
     * host/srflx/relay 중 무엇으로 시그널링 채널이 열렸는지 확인하기 위한 진단용입니다.
     */
    function logControlSelectedPair(pc, tag) {
        if (!pc || typeof pc.getStats !== 'function') return;
        pc.getStats().then(stats => {
            const byId = {};
            let selected = null;
            stats.forEach(report => {
                if (!report) return;
                if (report.id) byId[report.id] = report;
                if (report.type !== 'candidate-pair') return;
                if (report.selected) selected = report;
                else if (!selected && report.state === 'succeeded') selected = report;
            });
            if (!selected) return;
            const describe = (id, fallback) => {
                const cand = byId[id];
                const kind = (cand && cand.candidateType) || fallback || 'unknown';
                const addr = cand && (cand.address || cand.ip);
                return kind + (addr ? ' ' + addr + ':' + (cand.port || '?') : '');
            };
            const text = '[Control ICE Selected Pair] local=' + describe(selected.localCandidateId, selected.localCandidateType)
                + ', remote=' + describe(selected.remoteCandidateId, selected.remoteCandidateType)
                + ', state=' + (selected.state || '?');
            log(text);
            vscode.postMessage({ type: 'logMessage', level: 'debug', text: text });
        }).catch(() => {});
    }

    /**
     * 제어 P2P의 ICE 상태 변화와 로컬 후보 구성을 로그로 남깁니다.
     * 제어 채널이 어떤 후보로 열렸는지 확인할 수 없던 부분을 채웁니다.
     */
    function attachControlConnectionDiagnostics(conn, onStalled) {
        if (!conn || conn.__controlDiagnosticsAttached) return;
        conn.__controlDiagnosticsAttached = true;
        const tag = currentInitiator ? 'host' : 'guest';
        let attempts = 0;
        function attach() {
            const pc = conn.peerConnection;
            if (!pc) {
                if (attempts++ < 40 && !conn.open) setTimeout(attach, 250);
                return;
            }
            if (pc.__controlDiagnosticsAttached) return;
            pc.__controlDiagnosticsAttached = true;
            log('[Control ICE] 진단 시작 (role=' + tag + ')');
            pc.addEventListener('iceconnectionstatechange', () => {
                log('[Control ICE] iceConnectionState=' + pc.iceConnectionState + ' (role=' + tag + ')');
            });
            pc.addEventListener('icegatheringstatechange', () => {
                log('[Control ICE] iceGatheringState=' + pc.iceGatheringState + ' (role=' + tag + ')');
                if (pc.iceGatheringState === 'complete' && pc.localDescription && pc.localDescription.sdp) {
                    log('[Control ICE] 로컬 SDP 후보 -> ' + formatCandidateCounts(countCandidatesByType(pc.localDescription.sdp))
                        + ' / 전송 시 주입한 LAN IP ' + myLocalIps.length + '개');
                }
            });
            // 원격 후보 수신 계측: ANSWER까지 받고도 원격 후보가 0건인 실패를 로그만으로 구분하기 위함.
            const stats = conn.__controlStats || { remoteCandidates: 0, remoteDescriptionAt: 0, firstRemoteCandidateAt: 0 };
            conn.__controlStats = stats;

            if (typeof pc.setRemoteDescription === 'function' && !pc.__remoteDescWrapped) {
                pc.__remoteDescWrapped = true;
                const originalSetRemoteDescription = pc.setRemoteDescription.bind(pc);
                pc.setRemoteDescription = function (description) {
                    try {
                        if (description && description.type) {
                            stats.remoteDescriptionAt = Date.now();
                            log('[Control Timeline] 원격 description 적용 (type=' + description.type
                                + ', 후보 ' + formatCandidateCounts(countCandidatesByType(description.sdp)) + ')');
                        }
                    } catch (e) {}
                    return originalSetRemoteDescription(description);
                };
            }

            if (typeof pc.addIceCandidate === 'function' && !pc.__addCandidateWrapped) {
                pc.__addCandidateWrapped = true;
                const originalAddIceCandidate = pc.addIceCandidate.bind(pc);
                pc.addIceCandidate = function (candidate) {
                    stats.remoteCandidates++;
                    if (stats.remoteCandidates === 1) {
                        stats.firstRemoteCandidateAt = Date.now();
                        const line = (candidate && candidate.candidate) ? String(candidate.candidate) : 'unknown';
                        log('[Control Timeline] 첫 원격 후보 수신: ' + line.slice(0, 100));
                    }
                    return originalAddIceCandidate(candidate);
                };
            }

            const timer = setInterval(() => {
                const state = pc.iceConnectionState;
                if (state === 'connected' || state === 'completed') {
                    clearInterval(timer);
                    setTimeout(() => logControlSelectedPair(pc, tag), 500);
                } else if (state === 'failed' || state === 'closed') {
                    clearInterval(timer);
                }
            }, 500);
            setTimeout(() => clearInterval(timer), 45000);

            // 워치독: 원격 description 이 적용된 뒤 CONTROL_CANDIDATE_WATCHDOG_MS 동안 원격 후보가 0건이면
            // 소켓 교체/고스트 창에 handshake 가 걸린 것으로 보고 재생성 콜백을 호출한다.
            const watchdogStartedAt = Date.now();
            const watchdog = setInterval(() => {
                const state = pc.iceConnectionState;
                const hasRemote = !!pc.remoteDescription || stats.remoteDescriptionAt > 0;
                if (stats.remoteCandidates > 0 || conn.open || state === 'connected' || state === 'completed'
                    || state === 'failed' || state === 'closed' || pc.signalingState === 'closed') {
                    clearInterval(watchdog);
                    return;
                }
                if (hasRemote && Date.now() - watchdogStartedAt >= CONTROL_CANDIDATE_WATCHDOG_MS) {
                    clearInterval(watchdog);
                    if (typeof onStalled === 'function') onStalled(conn, stats);
                }
            }, 500);
            setTimeout(() => clearInterval(watchdog), 20000);
        }
        attach();
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
    function logCandidateSummary(kind, counts, hasLanDirect) {
        log('[ICE Summary] ' + kind + ' SDP candidates -> ' + formatCandidateCounts(counts));
        if (!counts.srflx && !counts.relay && !hasLanDirect) {
            log('[ICE Warning] 공인 IP(srflx) 후보가 없습니다. STUN 응답을 받지 못했습니다.');
        } else if (!counts.srflx && !counts.relay && hasLanDirect) {
            log('[ICE Note] 공인 IP(srflx) 후보는 없지만 LAN 사설 IP 후보로 직결을 시도합니다.');
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
            const boundBefore = peerSignalingConnMap[peerId];
            // 대기 중이던 시그널링 커넥션에 이 SDP 를 전달합니다(flush 내부에서 바인딩 후 전송).
            flushPendingSignalingRequests();
            // flush 가 이 피어에 커넥션을 새로 바인딩해 이미 전송했다면 중복 전송하지 않습니다.
            // 같은 SDP 를 두 번 보내면 게스트가 answer 를 두 번 만들어 setLocalDescription 이 실패합니다.
            if (!boundBefore && peerSignalingConnMap[peerId]) {
                return;
            }
        }

        const targetConn = currentInitiator ? peerSignalingConnMap[peerId] : guestSignalingConn;
        if (targetConn && targetConn.open) {
            log('SDP generated. Sending SDP message to ' + (currentInitiator ? 'guest' : 'host') + ' via signaling channel.');
        postJoinStage('sdp-exchange', '데이터 채널 연결을 시도하는 중입니다. (사설 IP·공인 IP·TURN 후보)');
            try {
                sendSdpToConn(peerId, targetConn, sdpStr, 'publish');
            } catch (e) {
                log('SDP 전송 실패, 재전송을 예약합니다: ' + (e && e.message ? e.message : e));
                scheduleSdpResend(peerId);
            }
            return;
        }
        // SDP 생성이 시그널링 채널 수립보다 빠르거나 전송 직전에 채널이 닫힌 경우, SDP 를 조용히 버리지 않고
        // 시그널링 채널이 열릴 때까지 재전송을 예약합니다.
        log('SDP 전송 보류: 시그널링 채널이 아직 열리지 않았습니다. (peer ' + peerId + ', connOpen=' + !!(targetConn && targetConn.open) + ')');
        scheduleSdpResend(peerId);
    }

    /**
     * 시그널링 채널이 열리기 전에 만들어진 SDP 를 잃지 않도록 재전송을 예약합니다.
     * 전송에 성공하면 clearSdpResend 로 정리되고, 한도를 넘으면 로그를 남기고 포기합니다.
     */
    function scheduleSdpResend(peerId) {
        const existing = sdpResendState[peerId];
        if (existing && existing.timer) return;
        const state = existing || { attempts: 0, timer: null };
        sdpResendState[peerId] = state;
        if (state.attempts >= SDP_RESEND_MAX_ATTEMPTS) {
            log('SDP 재전송 한도(' + SDP_RESEND_MAX_ATTEMPTS + '회)를 초과했습니다. (peer ' + peerId + ')');
            clearSdpResend(peerId);
            return;
        }
        state.attempts++;
        state.timer = setTimeout(() => {
            state.timer = null;
            if (sdpResendState[peerId] !== state) return;
            const sdp = pendingSdpMap[peerId];
            const peer = peers[peerId];
            if (!sdp || !peer || peer.destroyed || peer.connected) {
                clearSdpResend(peerId);
                return;
            }
            publishSdp(peerId, sdp);
        }, SDP_RESEND_INTERVAL_MS);
    }

    /**
     * simple-peer가 ICE 수집 완료 전에 SDP를 방출하면 공인 IP(srflx) 후보가 빠지므로,
     * 실제 수집이 끝날 때까지 기다린 뒤 수집된 후보가 모두 담긴 SDP를 전달합니다.
     */
    function publishSignalWithFullCandidates(peerId, p, data) {
        const baseSdp = typeof data.sdp === 'string' ? data.sdp : '';
        const pc = p._pc;

        function finalize(sdp) {
            if (peers[peerId] !== p || p.destroyed) {
                log('Peer was reset while waiting for ICE candidates. Discarding stale SDP.');
                return;
            }
            // mDNS host 후보를 실제 LAN IP 후보로 확장한 뒤 집계합니다. 사설 IP 도 정상적인 연결 경로입니다.
            const expandedSdp = expandMdnsInSdp(sdp);
            const counts = countCandidatesByType(expandedSdp);
            const hasLanDirect = myLocalIps.length > 0;
            logCandidateSummary(data.type, counts, hasLanDirect);
            // ICE 수집이 끝난 SDP 를 '한 번만' 전달합니다.
            // 예전에는 srflx 후보가 없으면 피어를 파괴하고 새 offer 를 만들었는데, 그 사이 상대가
            // 이전 offer 로 answer 를 만들면 'wrong state: stable' 오류로 데이터 채널이 실패했습니다.
            // 수집 완료를 기다린 SDP 하나만 보내는 편이 훨씬 안전합니다.
            publishSdp(peerId, JSON.stringify({ type: data.type, sdp: expandedSdp }));
        }

        if (!pc || pc.iceGatheringState === 'complete') {
            finalize(baseSdp);
            return;
        }

        log('ICE 수집이 끝나지 않아 공인 IP 후보가 누락될 수 있습니다. 수집 완료를 기다립니다...');
        const waitStarted = Date.now();
        waitForIceGatheringComplete(pc, ICE_GATHERING_WAIT_MS).then(() => {
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
            // trickle 후보가 개별 signal로 오는 경우에도 mDNS 후보를 로컬 IP 후보로 확장합니다.
            if (data && data.candidate && typeof data.candidate.candidate === 'string') {
                const candidateLines = expandMdnsCandidate(data.candidate.candidate);
                if (candidateLines.length > 1) {
                    // 원본 후보는 그대로 보내고, 추가한 LAN IP 후보만 별도 메시지로 보냅니다.
                    publishSdp(peerId, JSON.stringify(data));
                    for (let i = 1; i < candidateLines.length; i++) {
                        const candidate = buildCandidateInit(data.candidate, candidateLines[i]);
                        publishSdp(peerId, JSON.stringify(Object.assign({}, data, { candidate })));
                    }
                    return;
                }
            }
            publishSdp(peerId, JSON.stringify(data));
        });

        // 데이터 피어 워치독: 제한 시간 안에 연결되지 않았고 원격 signal 조차 적용되지 않았다면
        // (오퍼 유실/제어 채널 스톨) ICE 가 시작될 수 없으므로 확장 호스트에 조기 실패를 알린다.
        const dataWatchdogGeneration = engineGeneration;
        setTimeout(() => {
            if (dataWatchdogGeneration !== engineGeneration) return;
            if (!findPeerKey(p)) return;            // 이미 교체/정리된 피어
            if (p.destroyed || p.connected) return;
            if (p.__lastAppliedSignal) return;      // 원격 신호는 도착했으므로 ICE 진행 중으로 본다
            log('데이터 피어가 ' + DATA_PEER_WATCHDOG_MS + 'ms 동안 원격 signal 을 받지 못했습니다. 조기 실패로 보고합니다.');
            vscode.postMessage({ type: 'iceFailed', peerId: peerId });
        }, DATA_PEER_WATCHDOG_MS);

        p.on('connect', () => {
            if (guestSignalingConnectTimer) {
                clearTimeout(guestSignalingConnectTimer);
                guestSignalingConnectTimer = null;
            }
            // WebRTC 데이터 채널이 열린 시점부터 방 세션이 성립된 것으로 간주합니다(게스트 입장 완료).
            hasActiveRoomSession = true;
            controlChannelRetryCount = 0;
            log('SDP exchange success. WebRTC P2P channel connected.');
            postJoinStage('data-ready', '데이터 채널 연결됨. 호스트 승인을 기다리는 중입니다.');
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
            // 하트비트(1바이트 0xFF)는 데이터가 아니므로 무시
            if (raw.length === 1 && raw[0] === 255) return;

            const text = new TextDecoder().decode(raw);
            // 분할 전송된 대용량 패킷이면 청크를 모아 원본 JSON 문자열로 복원한다. (O(1) prefix 검사)
            if (text.startsWith('{"__isChunk":true,')) {
                try {
                    const chunkInfo = JSON.parse(text);
                    // peerId 는 세션 중 'guest_xxx' 로 바뀔 수 있으므로 피어 객체에 고정된 키를 사용합니다.
                    const bufferKey = getPeerTransferKey(p) + '_' + chunkInfo.id;
                    let buf = incomingChunkBuffers.get(bufferKey);
                    if (!buf) {
                        buf = {
                            chunks: new Array(chunkInfo.total),
                            received: 0,
                            timer: setTimeout(() => {
                                // 일부 청크가 유실된 채 30초가 지나면 조립 버퍼를 정리한다.
                                incomingChunkBuffers.delete(bufferKey);
                            }, 30000)
                        };
                        incomingChunkBuffers.set(bufferKey, buf);
                    }
                    // 중복 수신된 청크는 무시하고, 도착 순서와 무관하게 index 위치에 저장한다.
                    if (!buf.chunks[chunkInfo.index]) {
                        buf.chunks[chunkInfo.index] = chunkInfo.data;
                        buf.received++;
                    }
                    if (buf.received === chunkInfo.total) {
                        clearTimeout(buf.timer);
                        incomingChunkBuffers.delete(bufferKey);
                        // 완성된 원본 페이로드만 확장 호스트로 1회 전달한다(중간 청크는 IPC를 타지 않음).
                        vscode.postMessage({ type: 'sendData', value: buf.chunks.join(''), peerId });
                    }
                    return;
                } catch (e) {}
            }

            vscode.postMessage({ type: 'sendData', value: text, peerId });
        });

        p.on('error', err => {
            log('P2P connection error: ' + err.message);
            // 후보 재수집을 위해 교체된 이전 연결의 이벤트는 현재 피어를 건드리지 않도록 무시합니다.
            const key = findPeerKey(p);
            if (!key) return;
            delete peers[key];
            clearSdpResend(key);
            clearSentSdp(key);
            // 연결이 끊긴 피어의 대기 큐는 더 이상 전송할 수 없으므로 정리한다.
            dropSendQueue(p, 'P2P 연결 오류로 대기 중인 패킷을 폐기했습니다.');
            delete pendingSdpMap[key];
            delete remoteSignalMap[key];
            if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
            vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId: key });
        });

        p.on('close', () => {
            log('P2P connection closed.');
            const key = findPeerKey(p);
            if (!key) return;
            delete peers[key];
            clearSdpResend(key);
            clearSentSdp(key);
            // 연결이 닫힌 피어의 대기 큐와 재시도 타이머를 정리한다.
            dropSendQueue(p);
            delete pendingSdpMap[key];
            delete remoteSignalMap[key];
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
        // 'default' -> 'guest_xxx' 로 키가 바뀐 뒤 늦게 도착한 시그널이 이전 키로 라우팅되어
        // 유실되지 않도록 별칭을 따라갑니다.
        const alias = renamedPeerIds[id];
        if (alias && peers[alias]) return alias;
        // 게스트의 경우 자신이 연결된 유일한 호스트 피어가 존재하면 반환 (게스트는 호스트와만 1:1)
        if (!currentInitiator) {
            const keys = Object.keys(peers);
            if (keys.length === 1) return keys[0];
        }
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
        // 자격 증명 조회가 끝나기 전에 같은 피어로 다시 호출되면 피어와 TURN 요청이 중복 생성되므로 무시합니다.
        if (pendingPeerAdds[peerId]) return;
        pendingPeerAdds[peerId] = true;
        const generation = engineGeneration;
        // SDP 를 생성하는 PeerConnection 이므로, 만들기 직전에 Worker 에서 TURN 자격 증명을 받아 적재합니다.
        prepareIceServers().then(servers => {
            delete pendingPeerAdds[peerId];
            if (generation !== engineGeneration || peers[peerId]) return;
            try {
                log('Initializing WebRTC peer connection (isInitiator: ' + isInitiator + ')...');
                const p = new SimplePeer({
                    initiator: isInitiator,
                    trickle: false,
                    iceCompleteTimeout: ICE_COMPLETE_TIMEOUT_MS,
                    config: { iceServers: servers }
                });

                setupWebRTCPeer(peerId, p);
                peers[peerId] = p;

                // TURN 자격 증명을 기다리는 동안 도착한 offer/answer 를 이제 적용합니다.
                const queued = pendingRemoteSignals[peerId];
                delete pendingRemoteSignals[peerId];
                if (queued && queued.length > 0) {
                    queued.forEach(signal => {
                        const prepared = prepareRemoteSignalFor(p, signal);
                        remoteSignalMap[peerId] = signal;
                        p.__lastAppliedSignal = (typeof prepared === 'string') ? prepared : JSON.stringify(prepared);
                        try { p.signal(prepared); }
                        catch (err) { log('보관된 원격 signal 적용 실패: ' + err.message); }
                    });
                }
            } catch(e) { log('Error: ' + e.message); }
        }).catch(e => {
            delete pendingPeerAdds[peerId];
            log('피어 초기화 실패: ' + (e && e.message ? e.message : e));
        });
    }

    /**
     * P2P 엔진 연결을 활성화합니다.
     */
    window.startEngine = function(initiator, autoStart, roomName, peerId, stunServers, localIps, role) {
        stopEngine(); // 기존 실행 중인 엔진 정지

        // 새 세션 시작이므로 이전 엔진 정리 중 발생한 이벤트가 새 인스턴스에 영향을 주지 않도록 초기화합니다.
        isStoppingEngine = false;
        hasActiveRoomSession = false;

        currentInitiator = initiator;
        myLocalIps = Array.isArray(localIps) ? localIps.filter(ip => typeof ip === 'string' && ip.length > 0) : [];
        if (myLocalIps.length > 0) {
            log('[Local IPs] mDNS host 후보 확장에 사용할 LAN IP: ' + myLocalIps.join(', '));
        }
        // 확장 호스트(Node)가 호스트 이름을 미리 IP로 해석해 전달한 STUN 목록을 우선 사용합니다.
        const stunUrls = (Array.isArray(stunServers) && stunServers.length > 0) ? stunServers : DEFAULT_STUN_URLS;
        iceServers = stunUrls.map(url => ({ urls: url }));
        // TURN 자격 증명은 여기서 미리 받지 않고, SDP/시그널링 채널을 만들기 직전에 Worker 에 요청합니다.
        turnRole = (role === 'host') ? 'host' : 'guest';
        log('STUN servers - ' + stunUrls.length);
        log('Starting P2P Engine...');
        lastJoinStageKey = '';
        roomUnavailableDetected = false;
        postJoinStage('signaling', '시그널링 서버에 연결하는 중입니다.');

        function setupPeerJS(rName) {
            const toSafeId = (n) => 'p2p_room_' + Array.from(n).map(c => c.charCodeAt(0).toString(16)).join('');
            const pjsId = currentInitiator ? toSafeId(rName) : null;
            // 제어 채널 재생성 시 같은 방으로 다시 연결할 수 있도록 보관합니다.
            activeRoomName = rName;
            activeRoomPeerId = toSafeId(rName);

            log('Connecting to PeerJS signaling server...');
            peerServer = new Peer(pjsId, {
                debug: 3,
                config: { iceServers: (sessionIceServers && sessionIceServers.length ? sessionIceServers : iceServers), iceTransportPolicy: 'all', iceCandidatePoolSize: 6 }
            });
            installSignalingCandidateRewrite(peerServer);
            let wasOpened = false;

            peerServer.on('open', (id) => {
                if (wasOpened) {
                    signalingSocketReconnects++;
                    vscode.postMessage({ type: 'logMessage', level: 'info', text: 'PeerJS 시그널링 서버와의 재연결에 성공했습니다.' });
                }
                wasOpened = true;
                signalingSocketOpens++;
                signalingWasReconnecting = false;
                // PeerJS 는 재연결할 때 내부 소켓 객체를 새로 만들기 때문에 이전에 설치한 mDNS 후보 확장 훅이 사라집니다.
                // 소켓이 열린 시점에 다시 설치합니다.
                installSignalingCandidateRewrite(peerServer);
                const reconnectedAfterSec = (signalingSocketReconnects > 0 && lastSignalingReconnectAt > 0)
                    ? Math.round((Date.now() - lastSignalingReconnectAt) / 1000) : -1;
                log('Successfully connected to PeerJS signaling server.');
                postJoinStage('signaling-ready', '시그널링 서버 연결됨. 방 호스트를 찾는 중입니다.');
                log('[Control Timeline] 시그널링 소켓 open (open #' + signalingSocketOpens + ', reconnects=' + signalingSocketReconnects
                    + (reconnectedAfterSec >= 0 ? ', 직전 재연결 후 ' + reconnectedAfterSec + 's' : '') + ')');
                if (currentInitiator) {
                    // 호스트는 방이 시그널링 서버에 등록된 시점부터 '방에 입장한 상태'로 간주합니다.
                    hasActiveRoomSession = true;
                    log('Created room: "' + rName + '". Waiting for guest connection...');
                    vscode.postMessage({ type: 'roomNameSuccess' });
                    return;
                }
                // 시그널링 소켓은 ICE 와 무관하므로 open 즉시 사용할 수 있지만, 제어 채널 connect 는
                // TURN 까지 반영된 ICE 설정이 확정된 뒤에 수행해야 그 연결에 TURN 후보가 적재됩니다.
                maybeConnectGuestControlChannel();
            });

            peerServer.on('connection', (conn) => {
                log('Received connection request from guest signaling client.');
                // 수신측(호스트)은 offer 를 받는 순간 PeerJS 가 RTCPeerConnection 을 만들므로, ICE 설정이
                // 늦게 도착하면 이 제어 채널만 TURN 없이 협상될 수 있습니다. 다만 핸들러 부착을 미루면
                // 게스트가 보낸 REQ_OFFER 를 놓치므로, 즉시 부착하고 진단만 남깁니다.
                if (!iceReadyResolved) {
                    log('[Control Timeline] 수신 제어 연결 시점에 ICE 설정이 아직 확정 전입니다(TURN 미반영 가능).');
                }
                handleSignalingConn(conn);
            });

            peerServer.on('disconnected', () => {
                // stopEngine()의 destroy() 호출로 인한 의도적 종료라면 재연결/팝업을 수행하지 않습니다.
                if (isStoppingEngine || !wasOpened || !peerServer || peerServer.destroyed) return;
                // 게스트는 데이터 채널이 아직 열리지 않았어도(제어 채널 수립 중) 재연결해야 합니다.
                // hasActiveRoomSession 은 데이터 채널이 열린 시점에만 true 가 되므로 이를 조건으로 걸면
                // 초기 연결 중 소켓이 끊긴 게스트가 아무 이벤트 없이 30초 타임아웃까지 멈춥니다.
                log('PeerJS connection to signaling server lost. Reconnecting...');
                signalingWasReconnecting = true;
                lastSignalingReconnectAt = Date.now();
                log('[Control Timeline] 시그널링 소켓 재연결 시도 (reconnects=' + (signalingSocketReconnects + 1) + ')');
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
                        // 방이 시그널링 서버에 등록되어 있지 않다. 제어 채널 재생성 프로브/가드까지 멈춰
                        // 추가 연결 시도가 이어지지 않게 합니다(호스트 등록 경합은 확장 호스트가 1회만 재시도).
                        stopGuestConnectionAttempts('peer-unavailable');
                        postJoinStage('failed', '호스트가 오프라인이거나 존재하지 않는 방 이름입니다.');
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
            // 제어 P2P가 어떤 후보(host/srflx/relay)로 열렸는지 확인할 수 있도록 진단을 붙입니다.
            // 원격 후보가 전혀 도착하지 않는 실패(고스트/소켓 교체 창)는 reportControlChannelStall 로 보고됩니다.
            attachControlConnectionDiagnostics(conn, reportControlChannelStall);
            if (!currentInitiator) {
                guestSignalingConn = conn;
            }
            conn.on('open', () => {
                const controlAttempt = controlChannelRetryCount;
                const stats = conn.__controlStats;
                log('[Control Timeline] 제어 채널 open (제어 채널 시도 ' + (controlAttempt + 1) + '회'
                    + (stats ? ', 원격 후보 ' + stats.remoteCandidates + '건' : '') + ')');
                if (guestSignalingConnectTimer) {
                    clearTimeout(guestSignalingConnectTimer);
                    guestSignalingConnectTimer = null;
                }
                log('Signaling channel established.');
                postJoinStage('control-ready', '제어 채널 연결됨. 데이터 채널 SDP를 교환하는 중입니다.');
                log('[mDNS Expand] 제어 채널 후보 확장 누적: offer ' + controlExpandStats.offer + ', answer ' + controlExpandStats.answer + ', candidate ' + controlExpandStats.candidate);
                if (!currentInitiator) {
                    log('Requesting SDP offer from host...');
                    postJoinStage('sdp-request', '호스트에 SDP offer를 요청하는 중입니다.');
                    try { conn.send({ type: 'REQ_OFFER' }); } catch (e) { log('REQ_OFFER 전송 실패: ' + (e && e.message ? e.message : e)); }
                    // 채널은 열렸지만 호스트가 SDP 를 보내지 않으면(슬롯 부족/고스트 창) 재생성 프로브로 복구합니다.
                    scheduleGuestConnectGuard(conn, GUEST_CONTROL_GUARD_MS);
                }
            });

            conn.on('data', (data) => {
                if (guestSignalingConnectTimer) {
                    clearTimeout(guestSignalingConnectTimer);
                    guestSignalingConnectTimer = null;
                }
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
                        sendSdpToConn(targetId, conn, pendingSdpMap[targetId], 'req-offer');
                    } else {
                        log('No unassigned SDP offer ready yet. Queuing signaling connection and requesting invite slot from host...');
                        pendingSignalingQueue.push({ conn, timestamp: Date.now() });
                        vscode.postMessage({ type: 'requireInvite' });
                    }
                } else if (data.type === 'SDP') {
                    receivedRemoteSignalAt = Date.now();
                    let targetId;
                    if (currentInitiator) {
                        targetId = data.peerId || connPeerIdMap.get(conn);
                        if (!targetId) {
                            // 피어 ID가 명시되지 않은 경우, 이 시그널링 커넥션(conn)이 바인딩된 피어만 검색
                            targetId = Object.keys(peerSignalingConnMap).find(id => peerSignalingConnMap[id] === conn);
                        }
                        if (targetId) {
                            peerSignalingConnMap[targetId] = conn;
                            connPeerIdMap.set(conn, targetId);
                        }
                    } else {
                        targetId = 'default';
                        remotePeerIdMap['default'] = data.peerId;
                    }

                    // updatePeerId 로 키가 바뀐 뒤 늦게 도착한 SDP 도 찾을 수 있도록 별칭을 해석합니다.
                    targetId = resolvePeerKey(targetId);
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
                    guestSignalingConnOpenedAt = 0;
                    if (guestSignalingConnectTimer) {
                        clearTimeout(guestSignalingConnectTimer);
                        guestSignalingConnectTimer = null;
                    }
                    // 호스트가 SDP 를 보내기 전에 제어 채널이 닫히면(고스트 소켓/호스트 초기화) 아무 신호도 없이
                    // 멈추므로 재생성 프로브를 예약합니다. SDP 를 이미 받은 뒤라면 데이터 채널 협상을 방해하지 않도록
                    // 재생성하지 않습니다.
                    if (!hasActiveRoomSession && !receivedRemoteSignalAt) {
                        log('제어 채널이 SDP 교환 전에 닫혔습니다. 재생성 프로브를 예약합니다.');
                        scheduleControlChannelProbe('SDP 수신 전 제어 채널 종료', 600, () => {
                            return !currentInitiator && !hasActiveRoomSession && !receivedRemoteSignalAt
                                && !guestSignalingConn && peerServer && !peerServer.destroyed && peerServer.open;
                        });
                    }
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

        /**
         * 제어 채널이 원격 description 까지는 받았는데 원격 ICE 후보가 전혀 도착하지 않은 경우를 처리합니다.
         * 소켓 교체/고스트 창에 handshake 가 걸렸을 때 발생하며, 게스트는 제어 채널을 재생성해 빠르게 복구합니다.
         * @param conn 멈춘 것으로 판단된 제어 채널(PeerJS DataConnection).
         * @param stats 원격 후보 수신 계측값.
         */
        /**
         * 방이 존재하지 않거나 재시도가 무의미해졌을 때 게스트의 추가 연결 시도를 모두 중단합니다.
         * 제어 채널 재생성 프로브/가드 타이머를 정리하고 진행 중인 제어 채널도 닫습니다.
         * @param reason 로그에 남길 중단 사유.
         */
        function stopGuestConnectionAttempts(reason) {
            if (currentInitiator) return;
            roomUnavailableDetected = true;
            if (controlChannelProbeTimer) {
                clearTimeout(controlChannelProbeTimer);
                controlChannelProbeTimer = null;
            }
            if (guestSignalingConnectTimer) {
                clearTimeout(guestSignalingConnectTimer);
                guestSignalingConnectTimer = null;
            }
            if (guestSignalingConn) {
                const stalled = guestSignalingConn;
                guestSignalingConn = null;
                guestSignalingConnOpenedAt = 0;
                try { stalled.close(); } catch (e) {}
            }
            log('[Control ICE] 추가 연결 시도를 중단합니다. (' + reason + ')');
        }

        function reportControlChannelStall(conn, stats) {
            if (roomUnavailableDetected) return; // 방 없음이 확인된 뒤에는 재생성 프로브를 만들지 않습니다.
            const elapsed = (stats && stats.remoteDescriptionAt) ? Math.round((Date.now() - stats.remoteDescriptionAt) / 1000) : -1;
            log('[Control ICE] 원격 후보가 ' + CONTROL_CANDIDATE_WATCHDOG_MS + 'ms 동안 도착하지 않았습니다. (role=' + (currentInitiator ? 'host' : 'guest')
                + ', socketReconnects=' + signalingSocketReconnects + ', wasReconnecting=' + signalingWasReconnecting
                + ', remoteDesc 경과=' + elapsed + 's)');

            if (currentInitiator) {
                // 호스트는 게스트가 다시 접속하는 구조라 로컬 재생성 대신 진단 로그만 남깁니다.
                return;
            }
            if (controlChannelRetryCount >= CONTROL_CHANNEL_RETRY_MAX) {
                log('[Control ICE] 제어 채널 재생성 한도(' + CONTROL_CHANNEL_RETRY_MAX + '회)를 초과했습니다. 엔진 재시작이 필요합니다.');
                return;
            }
            if (conn !== guestSignalingConn) return;

            controlChannelRetryCount++;
            log('[Control ICE] 제어 채널 재생성 시도 ' + controlChannelRetryCount + '/' + CONTROL_CHANNEL_RETRY_MAX
                + ' (socketReconnects=' + signalingSocketReconnects + ')');
            guestSignalingConn = null;
            guestSignalingConnOpenedAt = 0;
            if (guestSignalingConnectTimer) {
                clearTimeout(guestSignalingConnectTimer);
                guestSignalingConnectTimer = null;
            }
            try { conn.close(); } catch (e) {}

            scheduleControlChannelProbe('제어 채널 재시도 ' + controlChannelRetryCount, 300);
        }

        /**
         * 게스트 제어 채널 복구(재생성) 프로브를 세대 가드와 함께 예약합니다.
         * 이전 세션의 지연 콜백이 새 세션에 채널을 만들지 않도록 engineGeneration 을 확인합니다.
         * @param reason 로그에 남길 생성 사유.
         * @param delayMs 예약 지연(ms).
         * @param guard 추가 조건(없으면 이벤트 루프/플래그만 검사).
         */
        function scheduleControlChannelProbe(reason, delayMs, guard) {
            const generation = engineGeneration;
            if (controlChannelProbeTimer) clearTimeout(controlChannelProbeTimer);
            controlChannelProbeTimer = setTimeout(() => {
                controlChannelProbeTimer = null;
                if (generation !== engineGeneration) return;
                if (typeof guard === 'function' && !guard()) return;
                connectGuestControlChannel(reason);
            }, delayMs);
        }

        /**
         * 게스트 제어 채널(호스트와의 시그널링 DataConnection)을 새로 만듭니다.
         * 소켓 재연결/스톨 복구 시에도 같은 방으로 다시 연결하며, 이미 살아있는 채널이 있으면 중복 생성하지 않습니다.
         * @param reason 로그에 남길 생성 사유.
         */
        function connectGuestControlChannel(reason) {
            if (currentInitiator || !peerServer || peerServer.destroyed || !peerServer.open) return;
            if (roomUnavailableDetected) return; // 방이 없다고 확인된 뒤에는 다시 연결하지 않습니다.
            if (guestSignalingConn) return;
            // ICE 설정(특히 TURN)이 확정되기 전에 connect 하면 PeerJS 가 이 시점에 RTCPeerConnection 을
            // 만들므로 이 제어 채널에 TURN 후보가 빠집니다. 확정될 때까지 미뤘다가 다시 진행합니다.
            if (!iceReadyResolved) {
                postJoinStage('ice-preparing', 'ICE 후보(사설 IP·공인 IP·TURN)를 준비하는 중입니다.');
                log('[Control Timeline] ICE 설정 확정을 기다린 뒤 제어 채널 connect 를 진행합니다. (' + reason + ')');
                const waitGeneration = engineGeneration;
                whenIceReady().then(() => {
                    if (engineGeneration !== waitGeneration) return;
                    connectGuestControlChannel(reason);
                });
                return;
            }
            log('Connecting to room host for room: "' + activeRoomName + '" (' + reason + ')...');
            postJoinStage('control-connecting', '호스트와 제어 채널을 수립하는 중입니다. (ICE 후보 교환)');
            log('[Control Timeline] 제어 채널 connect() 호출 (room="' + activeRoomName + '", 시도 ' + (controlChannelRetryCount + 1) + '회)');
            const conn = peerServer.connect(activeRoomPeerId || activeRoomName);
            guestSignalingConnOpenedAt = Date.now();
            handleSignalingConn(conn);
            scheduleGuestConnectGuard(conn, GUEST_CONTROL_GUARD_MS);
        }

        /**
         * 시그널링 소켓이 열린 뒤 게스트 제어 채널 connect 를 수행합니다.
         * 이미 방에 입장했거나 살아있는 제어 채널이 있으면 중복 생성하지 않습니다.
         * (ICE 확정 대기와 실제 connect 는 connectGuestControlChannel 이 담당합니다.)
         * @param reason 로그에 남길 생성 사유.
         */
        function maybeConnectGuestControlChannel(reason) {
            if (currentInitiator || !peerServer || peerServer.destroyed || !peerServer.open) return;
            if (roomUnavailableDetected) return;
            if (hasActiveRoomSession) {
                log('[Control Timeline] 제어 채널 connect() 생략 (이미 방에 입장함)');
                return;
            }
            const existing = guestSignalingConn;
            const existingAge = guestSignalingConnOpenedAt > 0 ? (Date.now() - guestSignalingConnOpenedAt) : -1;
            if (existing && (existing.open || (existingAge >= 0 && existingAge < GUEST_CONTROL_CONNECT_STALE_MS))) {
                log('[Control Timeline] 제어 채널 connect() 생략 (기존 채널 재사용, open=' + !!existing.open + ', age=' + existingAge + 'ms)');
                return;
            }
            connectGuestControlChannel(reason || '최초 연결');
        }

        /**
         * 게스트 제어 채널이 제한 시간 안에 진전(채널 open + 원격 description 수신)을 보이지 않으면
         * 제어 채널 재생성 프로브를 트리거합니다. 호스트 미등록/고스트 소켓 창에서 30초 타임아웃까지 멈추지 않게 합니다.
         * @param conn 감시할 제어 채널.
         * @param delayMs 진전 없음을 판단할 때까지 기다릴 시간(ms).
         */
        function scheduleGuestConnectGuard(conn, delayMs) {
            if (guestSignalingConnectTimer) {
                clearTimeout(guestSignalingConnectTimer);
                guestSignalingConnectTimer = null;
            }
            guestSignalingConnectTimer = setTimeout(() => {
                guestSignalingConnectTimer = null;
                if (currentInitiator || guestSignalingConn !== conn || hasActiveRoomSession) return;
                const stats = conn.__controlStats || {};
                if (stats.remoteDescriptionAt > 0) return; // SDP 교환이 이미 진행 중이면 워치독에 맡깁니다.
                log('Guest control channel made no progress within ' + delayMs + 'ms (open=' + conn.open + '). Triggering retry probe...');
                reportControlChannelStall(conn, stats);
            }, delayMs);
        }

        // ICE 설정(시그널링 소켓과 무관)은 시그널링 연결과 병렬로 준비합니다.
        // 시그널링 소켓을 먼저 열어 두면 방 존재 여부(peer-unavailable)를 더 빨리 판정할 수 있고,
        // 제어 채널 connect 는 ICE 설정이 확정된 뒤 maybeConnectGuestControlChannel() 에서 수행합니다.
        // Worker 가 404/무응답이면 빈 목록이 돌아오고 STUN 만으로 그대로 진행합니다.
        const generation = engineGeneration;
        iceReadyPromise = prepareIceServers().then(servers => {
            if (generation !== engineGeneration) return servers;
            sessionIceServers = servers;
            applyIceServersToPeerServer();
            return servers;
        }).catch(() => {
            return (sessionIceServers && sessionIceServers.length) ? sessionIceServers : buildIceServers([]);
        }).then(servers => {
            if (generation !== engineGeneration) return servers;
            iceReadyResolved = true;
            if (autoStart) {
                addPeer('default', currentInitiator);
            }
            // 시그널링 소켓이 먼저 열려 대기하던 제어 채널 connect 를 이어서 진행합니다.
            maybeConnectGuestControlChannel('ICE 확정');
            return servers;
        });

        if (roomName) {
            setupPeerJS(roomName);
        }
    };

    // 메시지 수신 및 라우팅 리스너
    window.addEventListener('message', e => {
        const m = e.data;
        if (m.type === 'startEngine') {
            window.startEngine(m.initiator, m.autoStart, m.roomName, m.peerId, m.stunServers, m.localIps, m.turnRole);
            return;
        }
        if (m.type === 'turnCredentialsResult') {
            const finish = pendingTurnRequests[m.requestId];
            if (finish) finish(m.turnServers);
            return;
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
            // 이전 키를 가리키던 별칭들을 새 키로 연결해 체인을 유지합니다.
            Object.keys(renamedPeerIds).forEach(k => {
                if (renamedPeerIds[k] === m.oldId) renamedPeerIds[k] = m.newId;
            });
            renamedPeerIds[m.oldId] = m.newId;
            const movedResend = sdpResendState[m.oldId];
            if (movedResend) {
                sdpResendState[m.newId] = movedResend;
                delete sdpResendState[m.oldId];
            }
            // 새 키로 다시 보내야 하므로 이전 키의 SDP 전송 기록은 지웁니다.
            clearSentSdp(m.oldId);
            delete peers[m.oldId];
            delete pendingSdpMap[m.oldId];
            delete remoteSignalMap[m.oldId];
        }
        if (m.type === 'disconnectPeer') {
            const pId = m.peerId;
            if (peers[pId]) {
                try { peers[pId].destroy(); } catch(e) {}
                delete peers[pId];
                clearSdpResend(pId);
                clearSentSdp(pId);
                delete pendingSdpMap[pId];
                if (Object.keys(peers).length === 0 && st) st.innerText = 'DISCONNECTED';
            }
            return;
        }
        if (m.type === 'addNewPeer') addPeer(m.peerId, m.initiator);
        if (m.type === 'signal') {
            receivedRemoteSignalAt = Date.now();
            const key = resolvePeerKey(targetId);
            if (peers[key]) {
                const prepared = prepareRemoteSignalFor(peers[key], m.sdp);
                // 같은 원격 signal 이 중복 도착하면(offer 재전송/큐 flush 중복) 두 번 적용하지 않습니다.
                // answer 를 두 번 만들면 setLocalDescription 이 wrong state(stable) 오류로 실패합니다.
                const fingerprint = (typeof prepared === 'string') ? prepared : JSON.stringify(prepared);
                if (peers[key].__lastAppliedSignal === fingerprint) {
                    log('Duplicate remote signal ignored (peer ' + key + ').');
                    return;
                }
                peers[key].__lastAppliedSignal = fingerprint;
                remoteSignalMap[key] = m.sdp;
                peers[key].signal(prepared);
            } else {
                // TURN 자격 증명을 받아 피어를 만드는 동안 도착한 signal 은 버리지 않고 보관합니다.
                queueRemoteSignal(key, m.sdp);
            }
        }
        if (m.type === 'peerData') {
            const rawStr = JSON.stringify(m.value);
            const CHUNK_SIZE = 16384; // 16KB 안전 MTU 규격

            // 피어별 FIFO 큐(전역)로 전송하여 순서를 보장하고 소형 패킷 유실을 막는다.
            function dispatchPayload(payload, group) {
                if (m.targetPeerIds && Array.isArray(m.targetPeerIds)) {
                    // 호스트 팬아웃: 페이로드는 위에서 1회만 직렬화하고, 대상 피어에게만 뿌린다.
                    m.targetPeerIds.forEach(id => {
                        const key = resolvePeerKey(id);
                        if (peers[key]) enqueueSend(peers[key], payload, group);
                    });
                } else if (m.targetPeerId) {
                    const key = resolvePeerKey(m.targetPeerId);
                    if (peers[key]) enqueueSend(peers[key], payload, group);
                } else {
                    Object.keys(peers).forEach(key => enqueueSend(peers[key], payload, group));
                }
            }

            // WebRTC DataChannel 의 max-message-size(256KB)를 넘는 패킷은 그대로 보내면 전송이 실패하므로
            // 16KB 단위로 분할해 보내고 수신 측에서 재조립한다. (파일 스냅샷 등 대용량 페이로드)
            if (rawStr.length <= CHUNK_SIZE) {
                // 16KB 이하 일반 패킷: 단일 전송 (타자, 커서, 핑퐁, 채팅 등)
                dispatchPayload(new TextEncoder().encode(rawStr));
            } else {
                const transferId = 'c_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                const totalChunks = Math.ceil(rawStr.length / CHUNK_SIZE);
                for (let i = 0; i < totalChunks; i++) {
                    const chunkData = rawStr.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                    const chunkPacket = JSON.stringify({
                        __isChunk: true,
                        id: transferId,
                        index: i,
                        total: totalChunks,
                        data: chunkData
                    });
                    // 청크는 같은 transferId 그룹으로 묶어, 적체로 전송이 지연되면 묶음 단위로 중단/정리한다.
                    dispatchPayload(new TextEncoder().encode(chunkPacket), transferId);
                }
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
