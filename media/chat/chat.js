// P2P Chat Room Webview 클라이언트 스크립트
(function() {
    const vscode = acquireVsCodeApi();
    let myId = '';
    let participants = {};

    // 메시지 수신 리스너
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'initHistory' || message.type === 'updateHistory') {
            myId = message.myId || myId;
            participants = message.others || {};
            renderHistory(message.history || []);
        }
    });

    // 엔터 키 입력 시 메시지 전송 (Shift+Enter는 줄바꿈)
    document.getElementById('chatInput')?.addEventListener('keydown', handleKey);
    document.getElementById('sendBtn')?.addEventListener('click', sendMessage);

    // 웹뷰 준비 완료 알림
    vscode.postMessage({ type: 'ready' });

    function handleKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    }

    function sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        
        vscode.postMessage({
            type: 'send',
            text: text
        });
        input.value = '';
        input.focus();
    }

    // 참가자 명단(others)에서 최신 이름을 가져오거나 없으면 메시지의 발신자명을 사용
    function getSenderName(senderId, fallbackName) {
        if (senderId === 'host') {
            return participants['host']?.name || 'Host';
        }
        if (senderId === myId) {
            return participants[myId]?.name || fallbackName || 'Me';
        }
        return participants[senderId]?.name || fallbackName || senderId;
    }

    function getAvatarInitials(name) {
        return name ? name.substring(0, 2) : '??';
    }

    function formatTime(timestamp) {
        const date = new Date(timestamp);
        let hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? '오후' : '오전';
        hours = hours % 12;
        hours = hours ? hours : 12;
        return ampm + ' ' + hours + ':' + minutes;
    }

    function renderHistory(history) {
        const area = document.getElementById('messageArea');
        if (!area) return;
        const wasAtBottom = area.scrollHeight - area.scrollTop <= area.clientHeight + 50;
        area.innerHTML = '';

        history.forEach(msg => {
            const row = document.createElement('div');
            
            if (msg.isSystem) {
                row.className = 'msg-row system';
                row.innerHTML = '<div class="system-bubble">' + escapeHtml(msg.text) + '</div>';
            } else if (msg.senderId === myId) {
                row.className = 'msg-row me';
                row.innerHTML = '<div class="msg-wrapper">' +
                                    '<div class="msg-bubble">' + escapeHtml(msg.text) + '</div>' +
                                    '<div class="msg-time">' + formatTime(msg.timestamp) + '</div>' +
                                '</div>';
            } else {
                row.className = 'msg-row other';
                // 최신 닉네임 동적 조회
                const currentName = getSenderName(msg.senderId, msg.senderName);
                const initials = getAvatarInitials(currentName);
                row.innerHTML = '<div class="msg-avatar">' + initials + '</div>' +
                                '<div class="msg-wrapper">' +
                                    '<div class="msg-sender-name">' + escapeHtml(currentName) + '</div>' +
                                    '<div class="msg-content-wrapper">' +
                                        '<div class="msg-bubble">' + escapeHtml(msg.text) + '</div>' +
                                        '<div class="msg-time">' + formatTime(msg.timestamp) + '</div>' +
                                    '</div>' +
                                '</div>';
            }
            area.appendChild(row);
        });

        // 스크롤 아래로 내리기
        if (wasAtBottom || history.length > 0) {
            area.scrollTop = area.scrollHeight;
        }
    }

    function escapeHtml(text) {
        return (text || '')
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
})();
