/**
 * @file script.ts
 * @description 사이드바 웹뷰 내 클라이언트 스크립트를 제공합니다.
 */

export function getSidebarScript(): string {
    return `
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

        /**
         * 요청 창의 표시 상태를 토글합니다.
         */
        function toggleRequests() {
            showingRequests = !showingRequests;
            const ria = document.getElementById('roomInfoArea');
            const ra = document.getElementById('requestsArea');
            if (ria) ria.classList.toggle('hidden', showingRequests);
            if (ra) ra.classList.toggle('hidden', !showingRequests);
        }

        /**
         * 게스트의 참가 요청을 승인합니다.
         */
        function approve(peerId) { vscode.postMessage({ type: 'approveRequest', peerId }); }
        /**
         * 게스트의 참가 요청을 거절합니다.
         */
        function reject(peerId) { vscode.postMessage({ type: 'rejectRequest', peerId }); }

        /**
         * 커서 필터 상태 변경 요청을 보냅니다.
         */
        function changeCursorFilter(val) {
            vscode.postMessage({ type: 'changeCursorFilter', filter: val });
        }

        /**
         * 방에서 나가는 요청을 보냅니다.
         */
        function leaveRoom() {
            vscode.postMessage({ type: 'leaveRoom' });
        }

        /**
         * 방 생성 폼을 보여주고 시작 버튼을 숨깁니다.
         */
        function showHostForm() { 
            const hf = document.getElementById('hostForm');
            const sb = document.getElementById('startButtons');
            if (hf) hf.classList.remove('hidden'); 
            if (sb) sb.classList.add('hidden'); 
        }
        /**
         * DOM 요소의 표시/숨김 상태를 토글하는 헬퍼 함수입니다.
         */
        function setVisible(id, visible) {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', !visible);
        }

        /**
         * 버튼 요소의 활성/비활성 상태를 제어하는 헬퍼 함수입니다.
         */
        function setDisabled(id, disabled) {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        }

        /**
         * 요청 창의 표시 상태를 토글합니다.
         */
        function toggleRequests() {
            showingRequests = !showingRequests;
            setVisible('roomInfoArea', !showingRequests);
            setVisible('requestsArea', showingRequests);
        }

        /**
         * 게스트의 참가 요청을 승인합니다.
         */
        function approve(peerId) { vscode.postMessage({ type: 'approveRequest', peerId }); }
        /**
         * 게스트의 참가 요청을 거절합니다.
         */
        function reject(peerId) { vscode.postMessage({ type: 'rejectRequest', peerId }); }

        /**
         * 방 생성 폼을 보여주고 시작 버튼을 숨깁니다.
         */
        function showHostForm() { 
            setVisible('hostForm', true);
            setVisible('startButtons', false);
        }
        /**
         * 방 참가 폼을 보여주고 시작 버튼을 숨깁니다.
         */
        function showGuestForm() { 
            setVisible('guestForm', true);
            setVisible('startButtons', false);
        }
        /**
         * 입력 폼들과 진행 상태를 기본 상태로 되돌립니다.
         */
        function resetForms() {
            setVisible('hostForm', false);
            setVisible('guestForm', false);
            setVisible('startButtons', true);
            
            ['btnStartHost', 'btnJoinAuto', 'btnJoinManual', 'btnCancelHost', 'btnCancelGuest'].forEach(id => setDisabled(id, false));
            ['hostLoading', 'guestLoading'].forEach(id => setVisible(id, false));
        }

        /**
         * 호스트 또는 게스트로서 초기 연결을 초기화합니다.
         */
        function init(i) { 
            try {
                let rn = '';
                let desc = '';
                if(i) {
                    const rnEl = document.getElementById('setupRoomName');
                    rn = rnEl ? rnEl.value.trim() : '';
                    if (!rn) { alert('Please enter a room name first!'); return; }
                    setDisabled('btnStartHost', true);
                    setDisabled('btnCancelHost', true);
                    setVisible('hostLoading', true);
                } else {
                    const rnEl = document.getElementById('joinRoomName');
                    const descEl = document.getElementById('joinDescription');
                    rn = rnEl ? rnEl.value.trim() : '';
                    desc = descEl ? descEl.value.trim() : '';
                    if (!rn) { alert('Please enter the host room name!'); return; }
                    setDisabled('btnJoinAuto', true);
                    setDisabled('btnJoinManual', true);
                    const jrt = document.getElementById('joiningRoomText');
                    if (jrt) jrt.innerText = '"' + rn + '"';
                    setVisible('guestLoading', true);
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

        /**
         * 수동으로 게스트 연결을 위한 준비를 설정합니다.
         */
        function initManualGuest() {
            const apid = document.getElementById('activePeerId');
            const lsdp = document.getElementById('lsdp');
            const rsdp = document.getElementById('rsdp');
            if (apid) apid.value = 'default';
            if (lsdp) lsdp.value = ''; 
            if (rsdp) rsdp.value = '';
            vscode.postMessage({ type: 'initPeer', initiator: false, roomName: '' }); 
        }

        /**
         * 게스트를 초대하기 위해 초대 연결 정보 생성을 시작합니다.
         */
        function invite() { 
            const lsdp = document.getElementById('lsdp');
            const rsdp = document.getElementById('rsdp');
            if (lsdp) lsdp.value = 'Generating...'; 
            if (rsdp) rsdp.value = '';
            vscode.postMessage({ type: 'inviteGuest' }); 
        }

        /**
         * 제공된 SDP 값을 사용하여 상대방과 연결을 설정합니다.
         */
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

        /**
         * 연결 설정 상태나 로딩 상태에서 뒤로 가기를 처리합니다.
         */
        function goBack() { 
            const b = document.getElementById('badge');
            const isInv = b && b.innerText === 'CONNECTED';
            vscode.postMessage({ type: 'cancel', isInviting: isInv }); 
        }
        /**
         * 자신의 이름을 변경 요청을 보냅니다.
         */
        function rename() { vscode.postMessage({ type: 'rename' }); }
        /**
         * 특정 피어를 세션에서 강퇴합니다.
         */
        function kick(peerId) { vscode.postMessage({ type: 'kick', peerId }); }

        /**
         * 특정 피어에 대해 파일 편집 권한을 지정합니다.
         */
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

        /**
         * 연결 상태 배지를 업데이트합니다.
         */
        function updateBadge(m) {
            const b = document.getElementById('badge');
            if (b) {
                if (m.isConnected) {
                    const isMeHost = m.participants && m.participants.myId === 'host';
                    b.innerText = (!isMeHost && m.connectionType === 'TURN') ? 'CONNECTED (TURN)' : 'CONNECTED';
                } else {
                    b.innerText = 'OFFLINE';
                }
                b.className = 'badge ' + (m.isConnected ? 'online' : '');
            }
        }

        /**
         * 대기 중인 참여 요청 목록을 화면에 렌더링합니다.
         */
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
                                         '<div class="request-desc">' + (req.description || '(No description)') + '</div>' +
                                         '<div class="request-actions">' +
                                            '<button class="approve-btn" onclick="approve(\\\'' + req.peerId + '\\\')">Approve</button>' +
                                            '<button class="reject-btn" onclick="reject(\\\'' + req.peerId + '\\\')">Reject</button>' +
                                         '</div>';
                        rl.appendChild(item);
                    });
                }
            } else {
                setVisible('btnShowRequests', false);
                if (showingRequests) toggleRequests();
            }
        }

        /**
         * 접속해 있는 참여자 목록을 화면에 렌더링합니다.
         */
        function renderUsers(m) {
            const udiv = document.getElementById('users');
            if (!udiv) return;
            udiv.innerHTML = '';
            const myId = m.participants.myId;
            const isMeHost = myId === 'host';
            Object.entries(m.participants.others).forEach(([id, data]) => {
                const isMe = (id === myId || (id === 'default' && myId !== 'host'));
                const isHost = (id === 'host');
                
                const name = data.name;
                const canEdit = data.globalCanEdit;

                const initials = name ? name.substring(0, 2) : '??';
                const avatarHTML = '<div class="user-avatar">' + initials + '</div>';

                // 본인의 경우 이름 오른쪽에 연필 아이콘
                let editBtnHTML = '';
                if (isMe) {
                    editBtnHTML = '<span class="edit-name-btn" onclick="rename()" title="Rename">' +
                        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">' +
                            '<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>' +
                        '</svg>' +
                    '</span>';
                }

                const nHTML = isMe ? '<b>' + name + '</b> &nbsp;(Me)' + editBtnHTML : name + (isHost ? ' <span class="host-badge">Host</span>' : '');
                
                // 쓰기 권한 토글 (호스트인 경우에만 게스트들을 대상으로 표시)
                let pHTML = '';
                if (isMeHost && !isMe && !isHost) {
                    pHTML = '<label class="switch" title="Toggle Write Permission"><input type="checkbox" ' + (canEdit ? 'checked' : '') + ' onchange="togglePermission(\\\'' + id + '\\\', \\\'' + name + '\\\', this.checked)"><span class="slider"></span></label>';
                }

                // 기여/손들기 버튼 및 강퇴 버튼
                let controlButtonsHTML = '';
                if (!isHost) {
                    // 게스트 및 내 화면
                    if (!isMe) {
                        if (isMeHost) {
                            controlButtonsHTML += pHTML;
                            // 손 모양 아이콘 버튼
                            controlButtonsHTML += '<button class="user-action-btn" title="Edit Permission Status" style="margin-left: 6px;">' +
                                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M14 6.5a2.5 2.5 0 0 0-5 0v3.08l-.83-.44a1.5 1.5 0 0 0-2 2.05l2.45 3.39A2.5 2.5 0 0 0 10.64 16h2.24a3 3 0 0 0 3-3V9a2.5 2.5 0 0 0-2.5-2.5zM8 4a2 2 0 1 1 4 0v2.5H8V4z"/></svg>' +
                            '</button>';
                            
                            // 강퇴 버튼 (마이너스 원형 아이콘)
                            controlButtonsHTML += '<button class="user-action-btn kick-btn" onclick="kick(\\\'' + id + '\\\')" title="Kick" style="margin-left: 6px;">' +
                                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z"/></svg>' +
                            '</button>';
                        }
                    }
                }

                udiv.innerHTML += '<div class="user-item">' + 
                                    avatarHTML +
                                    '<div class="user-name">' + nHTML + '</div>' + 
                                    '<div class="action-area">' + controlButtonsHTML + '</div>' + 
                                 '</div>';
            });
        }

        /**
         * 현재 상태에 맞춰 화면 레이아웃을 업데이트합니다.
         */
        function updateModeLayout(m) {
            const lsdp = document.getElementById('lsdp');
            const dispRoom = document.getElementById('dispRoomName');

            if (m.isSetupMode) {
                // 1. 설정 모드 (SDP 교환 중)
                setVisible('roleSelection', false);
                setVisible('connArea', true);
                setVisible('active', false);
                if (lsdp && m.invitingSdp) lsdp.value = m.invitingSdp;
                const isOffer = lsdp && lsdp.value && (lsdp.value.includes('offer') || lsdp.value === 'Generating...');
                const roleDisp = document.getElementById('roleTextDisp');
                if (roleDisp) roleDisp.innerText = isOffer ? 'INVITING NEW GUEST' : 'JOINING ROOM';
            } else if (m.isConnected) {
                // 2. 연결 완료 모드 (참가자 및 파일 목록)
                setVisible('roleSelection', false);
                setVisible('connArea', false);
                setVisible('active', true);
                if (dispRoom) dispRoom.innerText = m.roomName || 'Untitled Room';

                const isMeHost = m.participants.myId === 'host';
                setVisible('btnAddUser', isMeHost);

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
            } else {
                // 5. 초기 모드 (방 생성/참여 선택)
                setVisible('roleSelection', true);
                setVisible('connArea', false);
                setVisible('active', false);
                resetForms();
            }
        }

        /**
         * 공유 중인 파일 목록을 화면에 렌더링합니다.
         */
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
            if (lowerBase === 'license') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-3 3a3 3 0 0 1 5.1-2.1L12.5 8.3c.4.4.4 1 0 1.4l-.8.8a1 1 0 0 1-1.4 0L9.1 9.3 8.3 10.1A3 3 0 0 1 3 6z" fill="#cbcb41"/><path d="M9.5 7.5l1.5 1.5M10.5 6.5l1.5 1.5" stroke="#cbcb41" stroke-width="1.5"/></svg>';
            }
            if (lowerBase === '.gitignore') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 3.5C5 4.3 4.3 5 3.5 5S2 4.3 2 3.5 2.7 2 3.5 2 5 2.7 5 3.5zM14 12.5C14 13.3 13.3 14 12.5 14S11 13.3 11 12.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5zm-5.5-3.5c0-.8-.7-1.5-1.5-1.5S5.5 8.2 5.5 9s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5z" fill="#415a6b"/><path d="M3.5 5v6M12.5 11V7.5c0-1.4-1.1-2.5-2.5-2.5H7" stroke="#415a6b" stroke-width="1.5"/></svg>';
            }
            if (lowerBase === 'makefile') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#cbcb41" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="2" stroke="#cbcb41" stroke-width="1"/></svg>';
            }

            const extIdx = base.lastIndexOf('.');
            let ext = '';
            if (extIdx !== -1) {
                ext = base.substring(extIdx + 1).toLowerCase();
            }

            if (lowerBase === 'dockerfile') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 7.5h12v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z" fill="#519aba"/><rect x="3" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="6" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="9" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="6" y="1" width="2" height="2" rx="0.5" fill="#519aba"/></svg>';
            }

            switch (ext) {
                case 'ts':
                case 'tsx':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#519aba" text-anchor="middle">TS</text></svg>';
                case 'js':
                case 'jsx':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#cbcb41" text-anchor="middle">JS</text></svg>';
                case 'c':
                case 'h':
                case 'hpp':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#519aba" text-anchor="middle">C</text></svg>';
                case 'cpp':
                case 'cc':
                case 'cxx':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="9" font-weight="900" fill="#f34b7d" text-anchor="middle">C++</text></svg>';
                case 'py':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M7.5 0.5C5.8 0.5 4.5 1.8 4.5 3.5V5.5H8.5V6H3C1.9 6 1 6.9 1 8C1 9.1 1.9 10 3 10H4.5V8.5C4.5 6.8 5.8 5.5 7.5 5.5H11.5V3.5C11.5 1.8 10.2 0.5 8.5 0.5H7.5Z" fill="#3572A5"/><path d="M8.5 15.5C10.2 15.5 11.5 14.2 11.5 12.5V10.5H7.5V10H13C14.1 10 15 9.1 15 8C15 6.9 14.1 6 13 6H11.5V7.5C11.5 9.2 10.2 10.5 8.5 10.5H4.5V12.5C4.5 14.2 5.8 15.5 7.5 15.5H8.5Z" fill="#F1E05A"/></svg>';
                case 'json':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="13" font-weight="bold" fill="#cbcb41" text-anchor="middle">{}</text></svg>';
                case 'html':
                case 'htm':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 4L1 8L5 12M11 4L15 8L11 12" stroke="#e34c26" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                case 'css':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="15" font-family="sans-serif" font-size="14" font-weight="900" fill="#519aba" text-anchor="middle">#</text></svg>';
                case 'md':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14" font-family="sans-serif" font-size="12" font-weight="bold" fill="#519aba" text-anchor="middle">M</text></svg>';
                case 'java':
                case 'class':
                case 'jar':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 5h9v6a3 3 0 01-3 3H5a3 3 0 01-3-3V5zm9 2h1.5a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H11" stroke="#cc3e44" stroke-width="1.5"/><path d="M4 1v2M7 1v2M10 1v2" stroke="#cc3e44" stroke-width="1.2" stroke-linecap="round"/></svg>';
                case 'go':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#00acd7" text-anchor="middle">GO</text></svg>';
                case 'rs':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#dea584" text-anchor="middle">RS</text></svg>';
                case 'yaml':
                case 'yml':
                case 'xml':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#cbcb41" text-anchor="middle">⚙</text></svg>';
                case 'sh':
                case 'bash':
                case 'zsh':
                case 'ps1':
                case 'bat':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 3l6 5-6 5M9 13h5" stroke="#415a6b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                case 'sql':
                case 'db':
                case 'sqlite':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 4c0-1.7 2.7-3 6-3s6 1.3 6 3v8c0 1.7-2.7 3-6 3s-6-1.3-6-3V4z" fill="#f34b7d" fill-opacity="0.1" stroke="#f34b7d" stroke-width="1.5"/><path d="M2 4c0 1.7 2.7 3 6 3s6-1.3 6-3M2 8c0 1.7 2.7 3 6 3s6-1.3 6-3" stroke="#f34b7d" stroke-width="1.5"/></svg>';
                case 'php':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="9" font-weight="900" fill="#519aba" text-anchor="middle">PHP</text></svg>';
                case 'rb':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M4 2h8l3 4-7 8-7-8 3-4z" fill="#cc3e44" stroke="#cc3e44" stroke-width="1.5" stroke-linejoin="round"/></svg>';
                default:
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#858585" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/></svg>';
            }
        }

        /**
         * 공유 중인 파일 목록을 화면에 렌더링합니다.
         */
        function renderFiles(m) {
            const fdiv = document.getElementById('files');
            if (fdiv) {
                fdiv.innerHTML = '';
                const isFinalHost = m.participants.myId === 'host';
                m.files.forEach(f => {
                    const item = document.createElement('div'); 
                    item.className = 'file-item';
                    
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
                    fdiv.appendChild(item);
                });
            }
        }

        /**
         * 데코레이션 목록을 화면에 렌더링합니다.
         */
        function renderDecorations(m) {
            const decodiv = document.getElementById('decorations');
            if (!decodiv) return;
            decodiv.innerHTML = '';
            
            const decos = m.decorations || [];
            if (decos.length === 0) {
                return;
            }

            const myId = m.participants.myId;
            const isMeHost = myId === 'host';

            decos.forEach(d => {
                const item = document.createElement('div');
                item.className = 'deco-item';
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

                // 배지 표시
                const typeName = d.type === 'Typo' ? '오타' :
                                 d.type === 'Grammar' ? '문법 오류' :
                                 d.type === 'Logical' ? '논리 오류' :
                                 d.type === 'Other' ? '기타' : '하이라이트';
                
                const badge = document.createElement('span');
                badge.className = 'deco-badge ' + d.type;
                badge.innerText = typeName;
                title.appendChild(badge);

                // 파일명 및 라인
                const fileSpan = document.createElement('span');
                fileSpan.innerText = d.fileName.split('_')[0] + ' (L.' + (d.startLine + 1) + ')';
                title.appendChild(fileSpan);

                header.appendChild(title);

                // 삭제 버튼 (호스트이거나 본인이 작성한 데코레이션인 경우에만 표시)
                const canDelete = isMeHost || d.creatorId === myId;
                if (canDelete) {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'deco-delete-btn';
                    deleteBtn.title = 'Delete review';
                    deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2.5 1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1H2.5zm3 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zM8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5zm3 .5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 1 0z"/></svg>';
                    deleteBtn.onclick = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'deleteDecoration', id: d.id });
                    };
                    header.appendChild(deleteBtn);
                }

                item.appendChild(header);

                // 메모
                if (d.memo) {
                    const memo = document.createElement('div');
                    memo.className = 'deco-memo';
                    memo.innerText = d.memo;
                    item.appendChild(memo);
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

                decodiv.appendChild(item);
            });
        }

        /**
         * UI의 상태 업데이트에 따른 렌더링을 일괄 수행합니다.
         */
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

        /**
         * 채팅방 팝업창을 열기 위해 이벤트를 전송합니다.
         */
        function openChat() {
            vscode.postMessage({ type: 'openChat' });
        }

        /**
         * 화면 동기화 팔로우 모드를 활성화/비활성화합니다.
         */
        function toggleFollowMe(val) {
            vscode.postMessage({ type: 'setFollowMeMode', enabled: val });
        }

        vscode.postMessage({ type: 'ready' });
    `;
}
