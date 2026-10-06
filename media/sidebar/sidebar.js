window.vscode = acquireVsCodeApi();
const vscode = window.vscode;
window.onerror = function(message, source, lineno, colno, error) {
    vscode.postMessage({
        type: 'statusUpdate',
        value: 'Error: ' + message + ' (' + lineno + ':' + colno + ')',
        peerId: 'default'
    });
};
let showingRequests = false;

/** 요청 창의 표시 상태를 토글합니다. */
function toggleRequests() {
    showingRequests = !showingRequests;
    const ria = document.getElementById('roomInfoArea');
    const ra = document.getElementById('requestsArea');
    if (ria) ria.classList.toggle('hidden', showingRequests);
    if (ra) ra.classList.toggle('hidden', !showingRequests);
}

/** 게스트의 참가 요청을 승인합니다. */
function approve(peerId) { vscode.postMessage({ type: 'approveRequest', peerId }); }
/** 모든 대기 중인 게스트 참가 요청을 일괄 승인합니다. */
function approveAll() { vscode.postMessage({ type: 'approveAllRequests' }); }
/** 모든 게스트의 쓰기 권한을 일괄 해제(읽기 전용 전환)합니다. */
function revokeAllPermissions() { vscode.postMessage({ type: 'revokeAllPermissions' }); }
/** 게스트의 참가 요청을 거절합니다. */
function reject(peerId) { vscode.postMessage({ type: 'rejectRequest', peerId }); }

/** 커서 필터 상태 변경 요청을 보냅니다. */
function changeCursorFilter(val) {
    vscode.postMessage({ type: 'changeCursorFilter', filter: val });
}

/** 데코레이션 표시 온오프 토글 요청을 보냅니다. */
function toggleShowDecorations(checked) {
    vscode.postMessage({ type: 'toggleShowDecorations', show: checked });
}

/** 방에서 나가는 요청을 보냅니다. */
function leaveRoom() {
    setVisible('reconnectingBanner', false);
    vscode.postMessage({ type: 'leaveRoom' });
}

/** DOM 요소의 표시/숨김 상태를 토글하는 헬퍼 함수입니다. */
function setVisible(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    // 외부 CSS(sidebar.css) 로드 전에도 숨김이 보장되도록 클래스와 hidden 속성을 함께 토글합니다.
    el.classList.toggle('hidden', !visible);
    el.toggleAttribute('hidden', !visible);
}

/** 버튼 요소의 활성/비활성 상태를 제어하는 헬퍼 함수입니다. */
function setDisabled(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
}

/** 게스트 입장 진행 단계 정의. stages 순서대로 진행되며 현재 단계까지 완료 표시됩니다. */
const JOIN_PROGRESS_STEPS = [
    { label: 'PeerJS 서버 연결', stages: ['signaling', 'signaling-ready', 'join-retry'] },
    { label: 'ICE 준비 (STUN·TURN)', stages: ['ice-preparing'] },
    { label: '방 확인 (호스트 등록 여부)', stages: ['room-check'] },
    { label: '제어 채널 수립 (ICE 후보 교환)', stages: ['control-connecting', 'control-ready'] },
    { label: 'SDP 교환 (데이터 채널 협상)', stages: ['sdp-request', 'sdp-exchange'] },
    { label: '데이터 채널 연결', stages: ['data-ready'] },
    { label: '호스트 승인', stages: ['approval', 'approval-assigned', 'approval-ack'] }
];

/** 단계 키별 기본 설명(엔진/호스트가 문구를 주지 않았을 때 사용). */
const JOIN_STAGE_DETAILS = {
    'signaling': 'PeerJS 시그널링 서버에 연결하는 중입니다.',
    'signaling-ready': 'PeerJS 시그널링 서버 연결됨.',
    'ice-preparing': 'ICE 후보(사설 IP·공인 IP·TURN)를 준비하는 중입니다.',
    'room-check': '방이 시그널링 서버에 등록되어 있는지 확인하는 중입니다.',
    'control-connecting': '호스트와 제어 채널을 수립하는 중입니다. (ICE 후보 교환)',
    'control-ready': '제어 채널 연결됨. 데이터 채널 SDP를 교환하는 중입니다.',
    'sdp-request': '호스트에 SDP offer를 요청하는 중입니다.',
    'sdp-exchange': '데이터 채널 연결을 시도하는 중입니다. (사설 IP·공인 IP·TURN 후보)',
    'data-ready': '데이터 채널 연결됨. 호스트 승인을 기다리는 중입니다.',
    'approval': '호스트 승인을 기다리는 중입니다.',
    'approval-assigned': '게스트 ID를 받았습니다. 호스트 승인을 기다리는 중입니다.',
    'approval-ack': '호스트가 요청을 확인했습니다. 승인을 기다리는 중입니다.',
    'join-retry': '연결이 지연되어 자동으로 다시 시도합니다.',
    'failed': '연결 시간이 초과되었습니다.'
};

let joinProgressSignature = '';
let joinLastActiveIndex = -1;
let joinElapsedTimer = null;
let joinElapsedStartedAt = 0;

/** 진행 표시를 초기 상태로 되돌립니다(새 입장 시도 시작 시 호출). */
function resetJoinProgress() {
    joinProgressSignature = '';
    joinLastActiveIndex = -1;
    if (joinElapsedTimer) {
        clearInterval(joinElapsedTimer);
        joinElapsedTimer = null;
    }
    const detail = document.getElementById('joinProgressDetail');
    if (detail) { detail.innerText = ''; detail.classList.remove('failed'); }
    const elapsed = document.getElementById('joinProgressElapsed');
    if (elapsed) elapsed.innerText = '';
}

/** 경과 시간 표시를 시작합니다(이미 실행 중이면 그대로 유지). */
function startJoinElapsed() {
    if (joinElapsedTimer) return;
    const el = document.getElementById('joinProgressElapsed');
    if (!el) return;
    joinElapsedStartedAt = Date.now();
    const tick = () => {
        el.innerText = Math.floor((Date.now() - joinElapsedStartedAt) / 1000) + '초 경과';
    };
    tick();
    joinElapsedTimer = setInterval(tick, 1000);
}

/** 경과 시간 타이머를 멈춥니다(연결 완료 또는 화면 전환 시). */
function stopJoinProgress() {
    if (joinElapsedTimer) {
        clearInterval(joinElapsedTimer);
        joinElapsedTimer = null;
    }
}

/**
 * 게스트 승인 대기 영역에 현재 진행 단계를 그립니다.
 * @param {string} stage 단계 키.
 * @param {string} text 단계 설명(없으면 기본 문구 사용).
 * @param {string} roomName 입장하려는 방 이름.
 */
function renderJoinProgress(stage, text, roomName) {
    const stepsEl = document.getElementById('joinProgressSteps');
    if (!stepsEl) return;
    const roomEl = document.getElementById('joiningRoomText');
    if (roomEl && roomName) roomEl.innerText = '"' + roomName + '"';
    const detailText = text || JOIN_STAGE_DETAILS[stage] || '연결을 준비하는 중입니다.';
    const signature = stage + '|' + detailText + '|' + (roomName || '');
    if (signature === joinProgressSignature) return;
    joinProgressSignature = signature;

    const foundIndex = JOIN_PROGRESS_STEPS.findIndex(step => step.stages.indexOf(stage) >= 0);
    const isFailed = stage === 'failed';
    if (foundIndex >= 0) joinLastActiveIndex = foundIndex;
    // 실패하면 마지막으로 도달한 단계를 실패 표시로 남겨 어느 단계에서 멈췄는지 보여줍니다.
    const activeIndex = foundIndex >= 0 ? foundIndex : (isFailed ? joinLastActiveIndex : -1);
    let html = '';
    JOIN_PROGRESS_STEPS.forEach((step, index) => {
        let state = 'pending';
        if (activeIndex >= 0) {
            state = index < activeIndex ? 'done' : (index === activeIndex ? 'active' : 'pending');
        }
        if (isFailed && index === activeIndex) state = 'failed';
        const mark = state === 'done' ? '✓' : (state === 'failed' ? '✗' : (state === 'active' ? '<span class="join-step-spinner"></span>' : '•'));
        html += '<li class="join-step ' + state + '"><span class="join-step-mark">' + mark + '</span><span>' + step.label + '</span></li>';
    });
    stepsEl.innerHTML = html;

    const detailEl = document.getElementById('joinProgressDetail');
    if (detailEl) {
        detailEl.innerText = detailText;
        detailEl.classList.toggle('failed', stage === 'failed');
    }
}

/** 방 생성 폼을 보여주고 시작 버튼을 숨깁니다. */
function showHostForm() {
    const rnEl = document.getElementById('setupRoomName');
    if (rnEl) rnEl.value = '';

    const header = document.getElementById('hostDescHeader');
    const content = document.getElementById('hostDescContent');
    if (header && content) {
        content.classList.remove('expanded');
        header.classList.add('collapsed');
    }

    setVisible('hostForm', true);
    setVisible('startButtons', false);
}
/** 방 참가 폼을 보여주고 시작 버튼을 숨깁니다. */
function showGuestForm() {
    const rnEl = document.getElementById('joinRoomName');
    const unEl = document.getElementById('joinUserName');
    if (rnEl) rnEl.value = '';
    if (unEl) unEl.value = '';
    setVisible('guestForm', true);
    setVisible('startButtons', false);
}
/** 방 생성 전 안내 설명 아코디언을 토글합니다. */
function toggleHostDesc() {
    const header = document.getElementById('hostDescHeader');
    const content = document.getElementById('hostDescContent');
    if (header && content) {
        const isExpanded = content.classList.contains('expanded');
        if (isExpanded) {
            content.classList.remove('expanded');
            header.classList.add('collapsed');
        } else {
        content.classList.add('expanded');
        header.classList.remove('collapsed');
    }
}
}
/** 입력 폼들과 진행 상태를 기본 상태로 되돌립니다. */
function resetForms() {
    setVisible('hostForm', false);
    setVisible('guestForm', false);
    setVisible('startButtons', true);
    setVisible('reconnectingBanner', false);

    const setupRn = document.getElementById('setupRoomName');
    const joinRn = document.getElementById('joinRoomName');
    const joinUn = document.getElementById('joinUserName');
    if (setupRn) setupRn.value = '';
    if (joinRn) joinRn.value = '';
    if (joinUn) joinUn.value = '';

    const header = document.getElementById('hostDescHeader');
    const content = document.getElementById('hostDescContent');
    if (header && content) {
        content.classList.remove('expanded');
        header.classList.add('collapsed');
    }

    ['btnStartHost', 'btnJoinAuto', 'btnJoinManual', 'btnCancelHost', 'btnCancelGuest'].forEach(id => setDisabled(id, false));
    ['hostLoading', 'guestLoading'].forEach(id => setVisible(id, false));
}

/** 호스트 또는 게스트로서 초기 연결을 초기화합니다. */
function init(i) {
    try {
        let rn = '';
        let un = '';
        if(i) {
            const rnEl = document.getElementById('setupRoomName');
            rn = rnEl ? rnEl.value.trim() : '';
            if (!rn) { alert('Please enter a room name first!'); return; }
            setDisabled('btnStartHost', true);
            setDisabled('btnCancelHost', true);
            setVisible('hostLoading', true);
        } else {
        const rnEl = document.getElementById('joinRoomName');
        const unEl = document.getElementById('joinUserName');
        rn = rnEl ? rnEl.value.trim() : '';
        un = unEl ? unEl.value.trim() : '';
        if (!rn) { alert('Please enter the host room name!'); return; }
        if (!un) { alert('Please enter your name!'); return; }
        setDisabled('btnJoinAuto', true);
        setDisabled('btnJoinManual', true);
        const jrt = document.getElementById('joiningRoomText');
        if (jrt) jrt.innerText = '"' + rn + '"';
        resetJoinProgress();
        renderJoinProgress('', '', rn);
        setVisible('guestLoading', true);
        startJoinElapsed();
        vscode.postMessage({ type: 'joinRoom', roomName: rn, userName: un });
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

/** 수동으로 게스트 연결을 위한 준비를 설정합니다. */
function initManualGuest() {
    const apid = document.getElementById('activePeerId');
    const lsdp = document.getElementById('lsdp');
    const rsdp = document.getElementById('rsdp');
    if (apid) apid.value = 'default';
    if (lsdp) lsdp.value = '';
    if (rsdp) rsdp.value = '';
    vscode.postMessage({ type: 'initPeer', initiator: false, roomName: '' });
}

/** 게스트를 초대하기 위해 초대 연결 정보 생성을 시작합니다. */
function invite() {
    const lsdp = document.getElementById('lsdp');
    const rsdp = document.getElementById('rsdp');
    if (lsdp) lsdp.value = 'Generating...';
    if (rsdp) rsdp.value = '';
    vscode.postMessage({ type: 'inviteGuest' });
}

/** 제공된 SDP 값을 사용하여 상대방과 연결을 설정합니다. */
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

/** 연결 설정 상태나 로딩 상태에서 뒤로 가기를 처리합니다. */
function goBack() {
    const b = document.getElementById('badge');
    const isInv = b && b.innerText === 'CONNECTED';
    vscode.postMessage({ type: 'cancel', isInviting: isInv });
}
/** 자신의 이름을 변경 요청을 보냅니다. */
function rename() { vscode.postMessage({ type: 'rename' }); }
/** 특정 피어를 세션에서 강퇴합니다. */
function kick(peerId) { vscode.postMessage({ type: 'kick', peerId }); }

/** 특정 피어에 대해 파일 편집 권한을 지정합니다. */
function togglePermission(peerId, name, canEdit) {
    vscode.postMessage({
        type: 'setPermission',
        peerId: peerId,
        permission: {
            name: name,
            globalCanEdit: canEdit,
            filePermissions: {}
        }
    });
}

window.addEventListener('message', e => {
    try {
        const m = e.data;

        if (m.type === 'sdpGenerated') {
            const lsdp = document.getElementById('lsdp');
            const apid = document.getElementById('activePeerId');
            if (lsdp) lsdp.value = m.sdp;
            if (apid) apid.value = m.peerId || 'default';
        }

        if (m.type === 'renderState' || m.type === 'renderParticipants') {
            renderUI(m);
        }
    } catch (err) { console.error("Webview Error:", err); }
});

/** 연결 상태 배지를 업데이트합니다. */
function updateBadge(m) {
    const b = document.getElementById('badge');
    if (b) {
        const isReconnecting = m.isReconnecting || (m.participants && m.participants.isReconnecting);
        if (isReconnecting) {
            b.innerText = 'RECONNECTING...';
            b.className = 'badge reconnecting';
        } else if (m.isConnected) {
            const isMeHost = m.participants && m.participants.myId === 'host';
            b.innerText = (!isMeHost && m.connectionType === 'TURN') ? 'CONNECTED (TURN)' : 'CONNECTED';
            b.className = 'badge online';
        } else {
            b.innerText = 'OFFLINE';
            b.className = 'badge';
        }
    }
}

/** 대기 중인 참여 요청 목록을 화면에 렌더링합니다. */
function renderRequests(m) {
    const btnShowRequests = document.getElementById('btnShowRequests');
    const reqCountDisp = document.getElementById('reqCount');
    const isMeHost = m.participants.myId === 'host';
    if (isMeHost && m.participants.joinRequests && m.participants.joinRequests.length > 0) {
        setVisible('btnShowRequests', true);
        if (reqCountDisp) reqCountDisp.innerText = m.participants.joinRequests.length;
        const rl = document.getElementById('requestsList');
        if (rl) {
            rl.innerHTML = '';
            m.participants.joinRequests.forEach(req => {
                const item = document.createElement('div');
                item.className = 'request-item';
                item.innerHTML = '<div class="request-header">' +
                '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="color: var(--vscode-descriptionForeground);">' +
                '<path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 11H2v-.5A2.5 2.5 0 0 1 4.5 13h7a2.5 2.5 0 0 1 2.5 2.5v.5zM3.062 15h9.876A1.5 1.5 0 0 0 11.5 14h-7a1.5 1.5 0 0 0-1.438 1z"/>' +
                '</svg>' +
                '<span class="request-name">' + req.name + '</span>' +
                '</div>' +
                '<div class="request-desc" style="font-size: 11px; opacity: 0.75; margin: 4px 0 6px 0;">ID: ' + req.peerId + '</div>' +
                '<div class="request-actions">' +
                '<button class="approve-btn" onclick="approve(\'' + req.peerId + '\')">Approve</button>' +
                '<button class="reject-btn" onclick="reject(\'' + req.peerId + '\')">Reject</button>' +
                '</div>';
                rl.appendChild(item);
            });
        }
    } else {
        setVisible('btnShowRequests', false);
        if (showingRequests) toggleRequests();
    }
}

/** 접속자 목록에 내부 스크롤을 적용하기 시작하는 인원 수 (이 값을 초과하면 스크롤) */
const USER_LIST_SCROLL_THRESHOLD = 8;

/**
* 접속해 있는 참여자 목록을 화면에 렌더링합니다.
* 30명 동시 접속 시 스크롤 튐 및 DOM 재생성 과부하를 방지하기 위해 Diff 갱신 적용
* 표시 순서: 호스트 -> 나 -> 나머지(이름 내림차순)
*/
function renderUsers(m) {
    const udiv = document.getElementById('users');
    if (!udiv || !m.participants || !m.participants.others) return;

    // 스크롤은 아코디언이 인라인 max-height 로 관리하는 #users 에 직접 걸면 충돌하므로,
    // 목록 항목 전용 내부 래퍼를 두고 거기에 적용한다.
    let listWrap = udiv.querySelector('.users-scroll');
    if (!listWrap) {
        listWrap = document.createElement('div');
        listWrap.className = 'users-scroll';
        udiv.appendChild(listWrap);
    }

    const myId = m.participants.myId;
    const isMeHost = myId === 'host';
    const others = m.participants.others;
    const isMeId = (id) => (id === myId || (id === 'default' && myId !== 'host'));
    const currentPeerIds = new Set(Object.keys(others));

    // 표시 순서 계산: 호스트 -> 나 -> 나머지(이름 내림차순)
    const orderedIds = [];
    if (others['host']) orderedIds.push('host');
    Object.keys(others).forEach(id => {
        if (id !== 'host' && isMeId(id)) orderedIds.push(id);
    });
    const restIds = Object.keys(others).filter(id => id !== 'host' && !isMeId(id));
    restIds.sort((a, b) => {
        const nameA = (others[a] && others[a].name) || '';
        const nameB = (others[b] && others[b].name) || '';
        // 이름 내림차순(숫자 포함 자연 정렬), 이름이 같으면 id 내림차순으로 순서를 고정한다.
        const byName = nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
        return byName !== 0 ? byName : b.localeCompare(a);
    });
    orderedIds.push(...restIds);

    // 1. 퇴장한 피어의 DOM 엘리먼트 제거
    const existingElements = listWrap.querySelectorAll('.user-item[data-peer-id]');
    existingElements.forEach(el => {
        const peerId = el.getAttribute('data-peer-id');
        if (peerId && !currentPeerIds.has(peerId)) {
            el.remove();
        }
    });

    // 2. 피어 목록 순회하며 신규 추가 또는 변경된 피어만 부분 갱신
    Object.entries(others).forEach(([id, data]) => {
        const isMe = isMeId(id);
        const isHost = (id === 'host');
        const name = data.name || '';
        const canEdit = !!data.globalCanEdit;
        const initials = name ? name.substring(0, 2) : '??';

        let existingItem = listWrap.querySelector('.user-item[data-peer-id="' + id + '"]');
        if (!existingItem) {
            existingItem = document.createElement('div');
            existingItem.className = 'user-item';
            existingItem.setAttribute('data-peer-id', id);
            listWrap.appendChild(existingItem);
        }

        // 상태 데이터 변경 여부를 판별하기 위한 지문(Fingerprint)
        const statusClass = (isHost || isMe || data.connectionStatus !== 'reconnecting') ? 'connected' : 'reconnecting';
        const fingerprint = `${name}|${canEdit}|${statusClass}|${isMe}|${isHost}|${isMeHost}`;
        if (existingItem.getAttribute('data-fingerprint') === fingerprint) {
            return; // 내용이 변경되지 않은 피어는 DOM 재생성 생략
        }
        existingItem.setAttribute('data-fingerprint', fingerprint);

        let statusDotHTML = '';
        if (isMeHost) {
            const statusTitle = statusClass === 'connected' ? 'Connected' : 'Reconnecting... (No ping response)';
            statusDotHTML = '<span class="user-status-dot ' + statusClass + '" title="' + statusTitle + '"></span>';
        }

        const avatarHTML = '<div class="user-avatar-wrapper">' +
            '<div class="user-avatar">' + initials + '</div>' +
            statusDotHTML +
            '</div>';

        let editBtnHTML = '';
        if (isMe) {
            editBtnHTML = '<span class="edit-name-btn" onclick="rename()" title="Rename">' +
                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">' +
                '<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>' +
                '</svg>' +
                '</span>';
        }

        const nHTML = isMe ? '<b>' + name + '</b> &nbsp;(Me)' + editBtnHTML : name + (isHost ? ' <span class="host-badge">Host</span>' : '');

        let controlButtonsHTML = '';
        if (!isHost && !isMe && isMeHost) {
            controlButtonsHTML += '<label class="switch" title="Toggle Write Permission"><input type="checkbox" ' + (canEdit ? 'checked' : '') + ' onchange="togglePermission(\'' + id + '\', \'' + name + '\', this.checked)"><span class="slider"></span></label>';
            controlButtonsHTML += '<button class="user-action-btn kick-btn" onclick="kick(\'' + id + '\')" title="Kick" style="margin-left: 6px;">' +
                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z"/></svg>' +
                '</button>';
        }

        existingItem.innerHTML = avatarHTML +
            '<div class="user-name">' + nHTML + '</div>' +
            '<div class="action-area">' + controlButtonsHTML + '</div>';
    });

    // 3. 표시 순서(호스트 -> 나 -> 나머지)대로 DOM 재배치 (이미 순서가 맞으면 건드리지 않음)
    const currentOrder = Array.from(listWrap.querySelectorAll('.user-item[data-peer-id]'))
        .map(el => el.getAttribute('data-peer-id'));
    const orderChanged = currentOrder.length !== orderedIds.length
        || currentOrder.some((id, index) => id !== orderedIds[index]);
    if (orderChanged) {
        // appendChild 는 기존 노드를 이동시키므로, 원하는 순서대로 append 하면 최종 순서가 보장된다.
        orderedIds.forEach(id => {
            const el = listWrap.querySelector('.user-item[data-peer-id="' + id + '"]');
            if (el) listWrap.appendChild(el);
        });
    }

    // 4. 인원이 임계치를 넘으면 목록에 내부 스크롤 적용
    listWrap.classList.toggle('scrollable', orderedIds.length > USER_LIST_SCROLL_THRESHOLD);
}

/** 현재 상태에 맞춰 화면 레이아웃을 업데이트합니다. */
function updateModeLayout(m) {
    const lsdp = document.getElementById('lsdp');
    const dispRoom = document.getElementById('dispRoomName');

    if (m.isSetupMode) {
        // 1. 설정 모드 (SDP 교환 중)
        stopJoinProgress();
        setVisible('roleSelection', false);
        setVisible('connArea', true);
        setVisible('active', false);
        if (lsdp && m.invitingSdp) lsdp.value = m.invitingSdp;
        const isOffer = lsdp && lsdp.value && (lsdp.value.includes('offer') || lsdp.value === 'Generating...');
        const roleDisp = document.getElementById('roleTextDisp');
        if (roleDisp) roleDisp.innerText = isOffer ? 'INVITING NEW GUEST' : 'JOINING ROOM';
    } else if (m.isConnected || (m.isReconnecting && !m.isSetupMode)) {
        // 2. 연결 완료 모드 또는 재연결 유예 모드 (호스트 창 복구/게스트 재접속 중에도 방 화면과 참가자 목록 유지)
        setVisible('roleSelection', false);
        setVisible('connArea', false);
        stopJoinProgress();
        setVisible('active', true);
        if (dispRoom) dispRoom.innerText = m.roomName || 'Untitled Room';

        const isReconnecting = m.isReconnecting || (m.participants && m.participants.isReconnecting);
        setVisible('reconnectingBanner', !!isReconnecting);

        const isMeHost = m.participants.myId === 'host';
        setVisible('btnAddUser', isMeHost);
        setVisible('revokeAllOption', isMeHost);

        // 시그널링 서버 연결 상태 배지 업데이트 (호스트 전용 표시, 게스트에서는 숨김)
        const sigBadge = document.getElementById('signalingStatusBadge');
        const sigText = document.getElementById('signalingStatusText');
        if (sigBadge && sigText) {
            if (!isMeHost) {
                sigBadge.style.display = 'none';
            } else {
                sigBadge.style.display = 'inline-flex';
                if (m.isSignalingConnected) {
                    sigBadge.className = 'server-status-badge connected';
                    sigText.innerText = 'Server: Ready';
                    sigBadge.title = '시그널링 서버에 성공적으로 등록되어 게스트 접속 대기 중입니다.';
                } else {
                    sigBadge.className = 'server-status-badge connecting';
                    sigText.innerText = 'Server: Connecting...';
                    sigBadge.title = '시그널링 서버에 방 ID 등록 및 연결을 시도하고 있습니다.';
                }
            }
        }

        const cursorFilterSelect = document.getElementById('cursorFilterSelect');
        if (cursorFilterSelect && m.cursorFilter) {
            cursorFilterSelect.value = m.cursorFilter;
        }

        // 채팅 안 읽은 개수 배지 업데이트
        const unreadBadge = document.getElementById('unreadChatBadge');
        if (unreadBadge) {
            const count = m.unreadChatCount || 0;
            unreadBadge.innerText = count;
            unreadBadge.classList.toggle('hidden', count === 0);
        }

        // 팔로우 모드 체크박스 및 가시성 제어
        setVisible('followMeOption', isMeHost);
        const followMeCheck = document.getElementById('followMeCheck');
        if (followMeCheck) {
            followMeCheck.checked = !!m.isFollowMeMode;
        }

        // 자동 승인 체크박스 및 가시성 제어
        setVisible('autoApproveOption', isMeHost);
        const autoApproveCheck = document.getElementById('autoApproveCheck');
        if (autoApproveCheck) {
            const isAutoApprove = (m.isAutoApprove !== undefined) ? m.isAutoApprove : (m.participants && m.participants.isAutoApprove);
            autoApproveCheck.checked = !!isAutoApprove;
        }

        // 데코레이션 표시 토글 상태 동기화
        const showDecoCheck = document.getElementById('showDecoCheck');
        if (showDecoCheck && m.showDecorations !== undefined) {
            showDecoCheck.checked = !!m.showDecorations;
        }

        renderRequests(m);
        renderUsers(m);
    } else if (m.participants.myId === 'host' && m.roomName && m.roomName !== 'Untitled Room') {
        // 3. 호스트 생성/연결 중 모드
        setVisible('roleSelection', true);
        setVisible('connArea', false);
        setVisible('active', false);
        setVisible('startButtons', false);
        setVisible('hostForm', true);
        setVisible('hostLoading', true);
        setDisabled('btnStartHost', true);
        setDisabled('btnCancelHost', true);
    } else if (m.roomName && m.roomName !== 'Untitled Room' && m.participants.myId !== 'host') {
        // 4. 게스트 승인 대기 모드
        setVisible('roleSelection', true);
        setVisible('connArea', false);
        setVisible('active', false);
        setVisible('startButtons', false);
        setVisible('guestForm', true);
        setVisible('guestLoading', true);
        setDisabled('btnJoinAuto', true);
        setDisabled('btnJoinManual', true);
        const jrt = document.getElementById('joiningRoomText');
        if (jrt) jrt.innerText = '"' + m.roomName + '"';
        renderJoinProgress(m.participants.joinStage, m.participants.joinStageText, m.roomName);
        startJoinElapsed();
    } else {
        // 5. 초기 모드 (방 생성/참여 선택)
        setVisible('roleSelection', true);
        setVisible('connArea', false);
        setVisible('active', false);
        resetForms();
    }
}

/** 공유 중인 파일 목록을 화면에 렌더링합니다. */
const fileIconCache = new Map();

/** 공유 중인 파일 목록의 아이콘 SVG를 반환합니다 (캐싱 적용). */
function getFileIconSvg(fileName) {
    if (!fileName) {
        return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#858585" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/></svg>';
    }

    let base = fileName;
    if (base.endsWith('.shared')) {
        base = base.substring(0, base.length - 7);
        base = base.replace(new RegExp('_[0-9]+$'), '');
    } else {
        const lastDot = base.lastIndexOf('.');
        if (lastDot !== -1) {
            const ext = base.substring(lastDot);
            let nameWithoutExt = base.substring(0, lastDot);
            nameWithoutExt = nameWithoutExt.replace(/_[0-9]+$/, '');
            base = nameWithoutExt + ext;
        }
    }

    const lowerBase = base.toLowerCase();
    if (fileIconCache.has(lowerBase)) {
        return fileIconCache.get(lowerBase);
    }

    let svg = '';
    if (lowerBase === 'license') {
        svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-3 3a3 3 0 0 1 5.1-2.1L12.5 8.3c.4.4.4 1 0 1.4l-.8.8a1 1 0 0 1-1.4 0L9.1 9.3 8.3 10.1A3 3 0 0 1 3 6z" fill="#cbcb41"/><path d="M9.5 7.5l1.5 1.5M10.5 6.5l1.5 1.5" stroke="#cbcb41" stroke-width="1.5"/></svg>';
    } else if (lowerBase === '.gitignore') {
        svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 3.5C5 4.3 4.3 5 3.5 5S2 4.3 2 3.5 2.7 2 3.5 2 5 2.7 5 3.5zM14 12.5C14 13.3 13.3 14 12.5 14S11 13.3 11 12.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5zm-5.5-3.5c0-.8-.7-1.5-1.5-1.5S5.5 8.2 5.5 9s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5z" fill="#415a6b"/><path d="M3.5 5v6M12.5 11V7.5c0-1.4-1.1-2.5-2.5-2.5H7" stroke="#415a6b" stroke-width="1.5"/></svg>';
    } else if (lowerBase === 'makefile') {
        svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#cbcb41" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="2" stroke="#cbcb41" stroke-width="1"/></svg>';
    } else if (lowerBase === 'dockerfile') {
        svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 7.5h12v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z" fill="#519aba"/><rect x="3" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="6" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="9" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="6" y="1" width="2" height="2" rx="0.5" fill="#519aba"/></svg>';
    } else {
        const extIdx = base.lastIndexOf('.');
        const ext = extIdx !== -1 ? base.substring(extIdx + 1).toLowerCase() : '';
        switch (ext) {
            case 'ts':
            case 'tsx':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#519aba" text-anchor="middle">TS</text></svg>';
                break;
            case 'js':
            case 'jsx':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#cbcb41" text-anchor="middle">JS</text></svg>';
                break;
            case 'c':
            case 'h':
            case 'hpp':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#519aba" text-anchor="middle">C</text></svg>';
                break;
            case 'cpp':
            case 'cc':
            case 'cxx':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="9" font-weight="900" fill="#f34b7d" text-anchor="middle">C++</text></svg>';
                break;
            case 'py':
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M7.5 0.5C5.8 0.5 4.5 1.8 4.5 3.5V5.5H8.5V6H3C1.9 6 1 6.9 1 8C1 9.1 1.9 10 3 10H4.5V8.5C4.5 6.8 5.8 5.5 7.5 5.5H11.5V3.5C11.5 1.8 10.2 0.5 8.5 0.5H7.5Z" fill="#3572A5"/><path d="M8.5 15.5C10.2 15.5 11.5 14.2 11.5 12.5V10.5H7.5V10H13C14.1 10 15 9.1 15 8C15 6.9 14.1 6 13 6H11.5V7.5C11.5 9.2 10.2 10.5 8.5 10.5H4.5V12.5C4.5 14.2 5.8 15.5 7.5 15.5H8.5Z" fill="#F1E05A"/></svg>';
                break;
            case 'json':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="13" font-weight="bold" fill="#cbcb41" text-anchor="middle">{}</text></svg>';
                break;
            case 'html':
            case 'htm':
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 4L1 8L5 12M11 4L15 8L11 12" stroke="#e34c26" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                break;
            case 'css':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="15" font-family="sans-serif" font-size="14" font-weight="900" fill="#519aba" text-anchor="middle">#</text></svg>';
                break;
            case 'md':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14" font-family="sans-serif" font-size="12" font-weight="bold" fill="#519aba" text-anchor="middle">M</text></svg>';
                break;
            case 'java':
            case 'class':
            case 'jar':
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 5h9v6a3 3 0 01-3 3H5a3 3 0 01-3-3V5zm9 2h1.5a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H11" stroke="#cc3e44" stroke-width="1.5"/><path d="M4 1v2M7 1v2M10 1v2" stroke="#cc3e44" stroke-width="1.2" stroke-linecap="round"/></svg>';
                break;
            case 'go':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#00acd7" text-anchor="middle">GO</text></svg>';
                break;
            case 'rs':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#dea584" text-anchor="middle">RS</text></svg>';
                break;
            case 'yaml':
            case 'yml':
            case 'xml':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#cbcb41" text-anchor="middle">⚙</text></svg>';
                break;
            case 'sh':
            case 'bash':
            case 'zsh':
            case 'ps1':
            case 'bat':
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 3l6 5-6 5M9 13h5" stroke="#415a6b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                break;
            case 'sql':
            case 'db':
            case 'sqlite':
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 4c0-1.7 2.7-3 6-3s6 1.3 6 3v8c0 1.7-2.7 3-6 3s-6-1.3-6-3V4z" fill="#f34b7d" fill-opacity="0.1" stroke="#f34b7d" stroke-width="1.5"/><path d="M2 4c0 1.7 2.7 3 6 3s6-1.3 6-3M2 8c0 1.7 2.7 3 6 3s6-1.3 6-3" stroke="#f34b7d" stroke-width="1.5"/></svg>';
                break;
            case 'php':
                svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="9" font-weight="900" fill="#519aba" text-anchor="middle">PHP</text></svg>';
                break;
            case 'rb':
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M4 2h8l3 4-7 8-7-8 3-4z" fill="#cc3e44" stroke="#cc3e44" stroke-width="1.5" stroke-linejoin="round"/></svg>';
                break;
            default:
                svg = '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#858585" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/></svg>';
                break;
        }
    }

    fileIconCache.set(lowerBase, svg);
    return svg;
}

/** 공유 중인 파일 목록을 화면에 렌더링합니다 (Diff 갱신 적용). */
function renderFiles(m) {
    const fdiv = document.getElementById('files');
    if (!fdiv || !m.files) return;

    const currentFiles = m.files || [];
    const currentFileNames = new Set(currentFiles.map(f => f.name));

    // 1. 제거된 파일 DOM 삭제
    const existingItems = fdiv.querySelectorAll('.file-item[data-file-name]');
    existingItems.forEach(el => {
        const fn = el.getAttribute('data-file-name');
        if (fn && !currentFileNames.has(fn)) {
            el.remove();
        }
    });

    const isFinalHost = m.participants && m.participants.myId === 'host';
    const participantsListFingerprint = Object.entries(m.participants && m.participants.others || {})
        .map(([id, d]) => `${id}:${d.name}`)
        .sort()
        .join(',');

    currentFiles.forEach(f => {
        let item = fdiv.querySelector(`.file-item[data-file-name="${CSS.escape(f.name)}"]`);
        const fileFingerprint = `${f.name}|${f.assigneeId || ''}|${f.assigneeName || ''}|${isFinalHost}|${participantsListFingerprint}`;

        if (item && item.getAttribute('data-fingerprint') === fileFingerprint) {
            return; // 파일 정보 및 참여자 명단에 변동이 없으면 DOM 조작 스킵
        }

        if (!item) {
            item = document.createElement('div');
            item.className = 'file-item';
            item.setAttribute('data-file-name', f.name);
            fdiv.appendChild(item);
        }
        item.setAttribute('data-fingerprint', fileFingerprint);
        item.innerHTML = '';

        const infoContainer = document.createElement('div');
        infoContainer.style.display = 'flex';
        infoContainer.style.flexDirection = 'column';
        infoContainer.style.alignItems = 'flex-start';
        infoContainer.style.gap = '4px';
        infoContainer.style.flex = '1';
        infoContainer.style.overflow = 'hidden';

        const nameContainer = document.createElement('div');
        nameContainer.className = 'file-name-container';
        nameContainer.style.width = '100%';
        nameContainer.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });

        const fileIcon = document.createElement('span');
        fileIcon.className = 'file-icon';
        fileIcon.innerHTML = getFileIconSvg(f.name);

        const nameSpan = document.createElement('span');
        nameSpan.style.fontSize = '13px';
        nameSpan.innerText = f.name;

        nameContainer.appendChild(fileIcon);
        nameContainer.appendChild(nameSpan);
        infoContainer.appendChild(nameContainer);

        if (isFinalHost) {
            const select = document.createElement('select');
            select.style.marginLeft = '26px';
            select.style.fontSize = '12px';
            select.style.background = 'var(--vscode-dropdown-background)';
            select.style.color = 'var(--vscode-dropdown-foreground)';
            select.style.border = '1px solid var(--vscode-dropdown-border)';
            select.style.borderRadius = '2px';
            select.style.padding = '2px 4px';
            select.style.maxWidth = '180px';

            const optDefault = document.createElement('option');
            optDefault.value = '';
            optDefault.innerText = 'Anyone';
            select.appendChild(optDefault);

            Object.entries(m.participants.others).forEach(([id, data]) => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.innerText = id === 'host' ? data.name + ' (Host)' : data.name;
                if (f.assigneeId === id) {
                    opt.selected = true;
                }
                select.appendChild(opt);
            });

            select.onchange = (e) => {
                vscode.postMessage({
                    type: 'assignFileOwner',
                    fileName: f.name,
                    assigneeId: e.target.value
                });
            };
            select.onclick = (e) => { e.stopPropagation(); };
            infoContainer.appendChild(select);

            item.appendChild(infoContainer);

            const stopBtn = document.createElement('button');
            stopBtn.className = 'stop-btn';
            stopBtn.innerText = 'Stop';
            stopBtn.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'stopFileSharing', fileName: f.name }); };
            item.appendChild(stopBtn);
        } else {
            const assigneeSpan = document.createElement('span');
            assigneeSpan.className = 'file-assignee-badge';
            assigneeSpan.style.marginLeft = '26px';

            if (f.assigneeId) {
                if (f.assigneeId === m.participants.myId) {
                    assigneeSpan.innerText = 'Me (Owner)';
                    assigneeSpan.classList.add('owner');
                } else {
                    assigneeSpan.innerText = f.assigneeName || f.assigneeId;
                }
            } else {
                assigneeSpan.innerText = 'Anyone';
            }
            infoContainer.appendChild(assigneeSpan);
            item.appendChild(infoContainer);
        }
    });
}

/** 사용자가 접어 둔 데코레이션 파일 그룹(파일 이름) 상태. 목록이 다시 그려져도 접힘 상태를 유지합니다. */
const decoCollapsedFiles = new Set();

/** 사용자가 펼쳐 둔 데코레이션 메모(데코레이션 id) 상태. 목록이 다시 그려져도 유지합니다. */
const decoExpandedMemos = new Set();

/**
* 데코레이션 유형 코드를 한글 표시 이름으로 변환합니다.
* @param {string} type 데코레이션 유형 코드
* @returns {string} 표시 이름
*/
function getDecoTypeName(type) {
    switch (type) {
        case 'Typo': return '오타';
        case 'Grammar': return '문법 오류';
        case 'Logical': return '논리 오류';
        case 'Other': return '기타';
        default: return '하이라이트';
    }
}

/**
* 메모가 접힌 상태에서 2줄을 넘는 경우에만 "더 보기" 토글을 노출합니다.
* 조상이 max-height:0 으로 잘려 있어도 자식의 레이아웃 박스는 유지되므로 측정할 수 있습니다.
* @param {HTMLElement} item 데코레이션 항목 엘리먼트
* @param {string} decoId 데코레이션 id
*/
function refreshDecoMemoToggle(item, decoId) {
    const memo = item.querySelector('.deco-memo');
    const toggle = item.querySelector('.deco-memo-toggle');
    if (!memo || !toggle) return;
    const expanded = decoExpandedMemos.has(decoId);
    memo.classList.toggle('expanded', expanded);
    toggle.innerText = expanded ? '접기' : '더 보기';
    // 펼친 상태에서는 scrollHeight 와 clientHeight 가 같아져 잘림 여부를 알 수 없습니다.
    const truncated = memo.scrollHeight > memo.clientHeight + 1;
    toggle.classList.toggle('hidden', !expanded && !truncated);
}

/**
* 데코레이션 패널 아코디언의 높이를 현재 내용에 맞춰 재보정합니다.
* 파일 그룹 접기/펼치기는 클래스 변경이라 상위 MutationObserver 가 감지하지 못합니다.
*/
function recalcDecorationsHeight() {
    const decodiv = document.getElementById('decorations');
    if (decodiv && decodiv.classList.contains('expanded')) {
        decodiv.style.maxHeight = decodiv.scrollHeight + 'px';
    }
}

/**
* 데코레이션 삭제 버튼을 생성합니다.
* @param {string} decoId 데코레이션 id
* @returns {HTMLButtonElement} 삭제 버튼
*/
function createDecoDeleteButton(decoId) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'deco-delete-btn';
    deleteBtn.title = 'Delete review';
    deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2.5 1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1H2.5zm3 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zM8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5zm3 .5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 1 0z"/></svg>';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'deleteDecoration', id: decoId });
    };
    return deleteBtn;
}

/**
* 데코레이션 한 건의 DOM 을 생성합니다.
* @param {object} d 데코레이션 데이터
* @param {boolean} canDelete 삭제 버튼 노출 여부
* @returns {HTMLElement} 데코레이션 항목 엘리먼트
*/
function createDecoItem(d, canDelete) {
    const item = document.createElement('div');
    item.className = 'deco-item';
    item.setAttribute('data-deco-id', d.id);
    // 클릭 시 해당 위치로 이동
    item.onclick = () => {
        vscode.postMessage({
            type: 'jumpToDecoration',
            fileName: d.fileName,
            line: d.startLine,
            char: d.startChar
        });
    };

    const header = document.createElement('div');
    header.className = 'deco-header';

    const title = document.createElement('div');
    title.className = 'deco-title';

    const badge = document.createElement('span');
    badge.className = 'deco-badge ' + d.type;
    badge.innerText = getDecoTypeName(d.type);
    title.appendChild(badge);

    const lineSpan = document.createElement('span');
    lineSpan.className = 'deco-line';
    lineSpan.innerText = 'L.' + (d.startLine + 1);
    title.appendChild(lineSpan);

    header.appendChild(title);
    if (canDelete) header.appendChild(createDecoDeleteButton(d.id));
    item.appendChild(header);

    // 메모 (기본 2줄까지만 표시, 넘치면 "더 보기" 로 펼침)
    if (d.memo) {
        const memo = document.createElement('div');
        memo.className = 'deco-memo';
        memo.innerText = d.memo;
        item.appendChild(memo);

        const toggle = document.createElement('span');
        toggle.className = 'deco-memo-toggle hidden';
        toggle.onclick = (e) => {
            e.stopPropagation();
            if (decoExpandedMemos.has(d.id)) {
                decoExpandedMemos.delete(d.id);
            } else {
                decoExpandedMemos.add(d.id);
            }
            refreshDecoMemoToggle(item, d.id);
            recalcDecorationsHeight();
        };
        item.appendChild(toggle);
    }

    // 메타 데이터 (작성자 및 가시성)
    const meta = document.createElement('div');
    meta.className = 'deco-meta';

    const creator = document.createElement('span');
    creator.innerText = 'By: ' + d.creatorName;
    meta.appendChild(creator);

    const visibility = document.createElement('span');
    visibility.style.fontSize = '9px';
    visibility.style.opacity = '0.7';
    visibility.innerText = d.visibility === 'host' ? '🔒 Host Only' : '👥 Everyone';
    meta.appendChild(visibility);

    item.appendChild(meta);

    // 리렌더 직후 깜빡임 없이 펼침 상태를 먼저 적용합니다.
    // (잘림 여부 측정은 실제 레이아웃이 필요해 다음 프레임에 다시 수행합니다)
    if (d.memo) refreshDecoMemoToggle(item, d.id);
    return item;
}

/**
* 데코레이션 목록을 파일별 아코디언 그룹으로 렌더링합니다.
* 표시 순서: 파일 이름 오름차순, 그룹 내부는 시작 라인 오름차순.
*/
function renderDecorations(m) {
    const decodiv = document.getElementById('decorations');
    if (!decodiv) return;

    const decos = (m.decorations || []).slice();
    const myId = m.participants ? m.participants.myId : undefined;
    const isMeHost = myId === 'host';

    // 내용이 같으면 기존 DOM 을 그대로 두어 그룹 접힘/메모 펼침 상태를 보존합니다.
    const fingerprint = JSON.stringify([
        myId, isMeHost,
        decos.map(d => [d.id, d.fileName, d.startLine, d.startChar, d.type, d.memo, d.creatorId, d.creatorName, d.visibility])
    ]);
    if (decodiv.getAttribute('data-fingerprint') === fingerprint) {
        return;
    }
    decodiv.setAttribute('data-fingerprint', fingerprint);
    decodiv.innerHTML = '';

    if (decos.length === 0) {
        recalcDecorationsHeight();
        return;
    }

    // 1. 파일별 그룹화 (표시 순서: 파일 이름 오름차순)
    const groups = new Map();
    decos.forEach(d => {
        const key = d.fileName || '(알 수 없는 파일)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
    });

    const sortedFileNames = Array.from(groups.keys()).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    sortedFileNames.forEach(fileName => {
        const items = groups.get(fileName).slice().sort((a, b) => {
            if (a.startLine !== b.startLine) return a.startLine - b.startLine;
            if (a.startChar !== b.startChar) return a.startChar - b.startChar;
            return String(a.id).localeCompare(String(b.id));
        });

        const group = document.createElement('div');
        group.className = 'deco-file-group';
        group.setAttribute('data-file-name', fileName);

        // 2. 그룹 헤더 (파일 이름 + 건수, 클릭 시 접기/펼치기)
        const groupHeader = document.createElement('div');
        groupHeader.className = 'deco-file-header';
        groupHeader.title = fileName + ' (' + items.length + ')';

        const arrow = document.createElement('span');
        arrow.className = 'deco-file-arrow';
        arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'deco-file-name';
        nameSpan.innerText = fileName;

        const countSpan = document.createElement('span');
        countSpan.className = 'deco-file-count';
        countSpan.innerText = String(items.length);

        groupHeader.appendChild(arrow);
        groupHeader.appendChild(nameSpan);
        groupHeader.appendChild(countSpan);
        group.appendChild(groupHeader);

        const body = document.createElement('div');
        body.className = 'deco-file-body';
        group.appendChild(body);

        const collapsed = decoCollapsedFiles.has(fileName);
        group.classList.toggle('collapsed', collapsed);
        if (collapsed) body.style.display = 'none';

        groupHeader.onclick = () => {
            const nextCollapsed = !group.classList.contains('collapsed');
            group.classList.toggle('collapsed', nextCollapsed);
            body.style.display = nextCollapsed ? 'none' : '';
            if (nextCollapsed) {
                decoCollapsedFiles.add(fileName);
            } else {
                decoCollapsedFiles.delete(fileName);
                // display:none 동안에는 메모 높이를 측정할 수 없으므로 펼칠 때 다시 측정합니다.
                body.querySelectorAll('.deco-item[data-deco-id]').forEach(item => {
                    refreshDecoMemoToggle(item, item.getAttribute('data-deco-id'));
                });
            }
            recalcDecorationsHeight();
        };

        // 3. 항목 생성 (그룹을 먼저 문서에 붙여야 메모 높이를 측정할 수 있습니다)
        decodiv.appendChild(group);
        items.forEach(d => {
            const canDelete = isMeHost || d.creatorId === myId;
            body.appendChild(createDecoItem(d, canDelete));
        });
    });

    recalcDecorationsHeight();

    // 메모 잘림 여부는 실제 레이아웃이 필요하므로 다음 프레임에 측정합니다.
    // (최초 렌더 시점에는 메인 컨텐츠가 아직 숨겨져 있을 수 있습니다)
    requestAnimationFrame(() => {
        decodiv.querySelectorAll('.deco-item[data-deco-id]').forEach(item => {
            if (item.offsetParent !== null) {
                refreshDecoMemoToggle(item, item.getAttribute('data-deco-id'));
            }
        });
    });
}

/** UI의 상태 업데이트에 따른 렌더링을 일괄 수행합니다. */
function renderUI(m) {
    if (m.type === 'refresh' || !m.participants) return;

    // 1. 레이아웃 상태 및 데이터를 먼저 다 채워 놓습니다.
    updateBadge(m);
    updateModeLayout(m);
    renderFiles(m);
    renderDecorations(m);

    // 2. 렌더링 준비가 완료된 후, 로딩 창을 끄고 메인 컨텐츠를 보여줍니다.
    // (동일한 렌더 프레임 내에서 한 번에 그려지므로 초기 화면 깜빡임이 사라집니다)
    setVisible('loading', false);
    setVisible('mainContent', true);
}

// 아코디언 헤더 접기/펼치기 부드러운 애니메이션 이벤트 바인딩
document.querySelectorAll('#roomInfoArea .accordion-header').forEach(header => {
    const content = header.nextElementSibling;
    if (content && content.classList.contains('accordion-content')) {
        // 내부 돔 요소 변경 감지하여 콘텐츠가 채워질 때 높이를 재보정
        const observer = new MutationObserver(() => {
            if (content.classList.contains('expanded')) {
                content.style.maxHeight = content.scrollHeight > 0 ? content.scrollHeight + 'px' : '1000px';
            }
        });
        observer.observe(content, { childList: true, subtree: true, characterData: true });

        // 초기 상태에 대한 max-height 활성화 처리
        if (content.classList.contains('expanded')) {
            content.style.maxHeight = content.scrollHeight > 0 ? content.scrollHeight + 'px' : '1000px';
        }
    }

    header.addEventListener('click', (e) => {
        // 초청(+) 이나 요청 알림(종) 버튼 클릭 시 아코디언이 접히는 것을 방지
        if (e.target.closest('.invite-btn')) return;

        header.classList.toggle('collapsed');
        if (content && content.classList.contains('accordion-content')) {
            const isExpanding = !content.classList.contains('expanded');
            content.classList.toggle('expanded', isExpanding);

            if (isExpanding) {
                content.style.maxHeight = content.scrollHeight + 'px';
                // 트랜지션 완료 후 유연한 내부 변경을 위해 auto에 가깝게 변경 (새 데이터가 동적으로 들어왔을 때도 대응)
                setTimeout(() => {
                    if (content.classList.contains('expanded')) content.style.maxHeight = '1000px';
                }, 250);
            } else {
            // 닫을 때는 정확한 scrollHeight에서 0px로 전이
            content.style.maxHeight = content.scrollHeight + 'px';
            requestAnimationFrame(() => {
                content.style.maxHeight = '0px';
            });
        }
    }
});
});

/** 채팅방 팝업창을 열기 위해 이벤트를 전송합니다. */
function openChat() {
    vscode.postMessage({ type: 'openChat' });
}

/** 화면 동기화 팔로우 모드를 활성화/비활성화합니다. */
function toggleFollowMe(val) {
    vscode.postMessage({ type: 'setFollowMeMode', enabled: val });
}

/** 자동 승인 모드를 활성화/비활성화합니다. */
function toggleAutoApprove(val) {
    vscode.postMessage({ type: 'setAutoApprove', enabled: val });
}

vscode.postMessage({ type: 'ready' });

// 초기 로딩 지연 방어: 1.5초 이내에 renderState 메시지를 수신하지 못했을 경우 다시 ready 신호를 전송
setTimeout(() => {
    const loadingEl = document.getElementById('loading');
    if (loadingEl && !loadingEl.classList.contains('hidden')) {
        vscode.postMessage({ type: 'ready' });
    }
}, 1500);
