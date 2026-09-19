/**
 * @file ChatPanel.ts
 * @description P2P 실시간 협업 세션 내 참가자들 간의 다자간 채팅을 지원하는 Webview 패널입니다.
 */

import * as vscode from 'vscode';
import { ChatMessage } from '../types';

/**
 * ChatPanel 클래스.
 * VS Code WebviewPanel을 기반으로 실시간 채팅 윈도우를 렌더링하고,
 * 메시지 송수신, 참가자 닉네임 동적 반영, 읽지 않은 메시지 관리 및 HTML 라이프사이클을 관리합니다.
 */
export class ChatPanel {
    /** 현재 열려 있는 단일 ChatPanel 인스턴스 (싱글톤) */
    public static currentPanel: ChatPanel | undefined;

    /** 채팅 UI를 호스팅하는 VS Code WebviewPanel 인스턴스 */
    private readonly _panel: vscode.WebviewPanel;

    /** 확장 프로그램 루트 URI (웹뷰 리소스 로딩용) */
    private readonly _extensionUri: vscode.Uri;

    /** 패널 해제 시 정리할 구독 리소스 목록 */
    private _disposables: vscode.Disposable[] = [];

    /** 사용자가 채팅 메시지를 입력하고 전송했을 때 호출되는 콜백 */
    public onSendMessage?: (text: string) => void;

    /** 채팅 패널 탭이 닫힐 때 호출되는 콜백 */
    public onClose?: () => void;

    /**
     * 채팅 패널을 새로 열거나 이미 열려 있는 경우 포커스를 가져옵니다.
     * @param extensionUri 확장 프로그램 루트 URI.
     * @param chatHistory 현재까지 누적된 채팅 메시지 이력 배열.
     * @param myId 현재 사용자의 피어 ID.
     * @param others 참가자 권한 및 닉네임 정보 맵.
     * @returns 생성되거나 활성화된 ChatPanel 인스턴스.
     */
    public static createOrShow(extensionUri: vscode.Uri, chatHistory: ChatMessage[], myId: string, others: any): ChatPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChatPanel.currentPanel) {
            ChatPanel.currentPanel._panel.reveal(column);
            ChatPanel.currentPanel.updateHistory(chatHistory, myId, others);
            return ChatPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'p2pChat',
            'P2P Chat Room',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, chatHistory, myId, others);
        return ChatPanel.currentPanel;
    }

    /**
     * ChatPanel 내부 인스턴스를 생성하고 이벤트 리스너를 설정합니다.
     * @param panel VS Code WebviewPanel 인스턴스.
     * @param extensionUri 확장 프로그램 루트 URI.
     * @param chatHistory 초기 채팅 기록.
     * @param myId 로컬 사용자 ID.
     * @param others 참가자 맵.
     */
    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, chatHistory: ChatMessage[], myId: string, others: any) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // HTML 세팅
        this._updateHtml(chatHistory, myId, others);

        // 패널 닫기 감지
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 웹뷰 메시지 리스너
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'send':
                        if (this.onSendMessage && message.text) {
                            this.onSendMessage(message.text);
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * 최신 채팅 이력 및 참가자 정보를 Webview로 전달하여 화면을 갱신합니다.
     * @param chatHistory 갱신된 채팅 메시지 이력 배열.
     * @param myId 로컬 사용자 ID.
     * @param others 최신 참가자 명단 맵.
     * @returns {void}
     */
    public updateHistory(chatHistory: ChatMessage[], myId: string, others: any): void {
        this._panel.webview.postMessage({
            type: 'updateHistory',
            history: chatHistory,
            myId: myId,
            others: others
        });
    }

    /**
     * 채팅 패널과 등록된 모든 리소스를 해제합니다.
     * @returns {void}
     */
    public dispose(): void {
        if (this.onClose) {
            this.onClose();
        }
        ChatPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Webview의 HTML 본문을 갱신합니다.
     * @param chatHistory 채팅 메시지 이력.
     * @param myId 로컬 사용자 ID.
     * @param others 참가자 맵.
     * @returns {void}
     */
    private _updateHtml(chatHistory: ChatMessage[], myId: string, others: any): void {
        this._panel.webview.html = this._getHtmlForWebview(chatHistory, myId, others);
    }

    private _getHtmlForWebview(chatHistory: ChatMessage[], myId: string, others: any): string {
        return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>P2P Chat Room</title>
    <style>
        * { box-sizing: border-box; }
        body, html {
            margin: 0;
            padding: 0;
            height: 100%;
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            background-color: var(--vscode-editor-background); /* VS Code 에디터 배경 */
            color: var(--vscode-foreground);
        }
        #chatContainer {
            display: flex;
            flex-direction: column;
            height: 100vh;
            max-width: 800px;
            margin: 0 auto;
            background-color: var(--vscode-editor-background);
        }
        #messageArea {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        /* 메시지 스크롤바 디자인 */
        #messageArea::-webkit-scrollbar {
            width: 8px;
        }
        #messageArea::-webkit-scrollbar-track {
            background: transparent;
        }
        #messageArea::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, rgba(255, 255, 255, 0.1));
            border-radius: 4px;
        }
        #messageArea::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255, 255, 255, 0.15));
        }

        /* 말풍선 공통 스타일 */
        .msg-row {
            display: flex;
            width: 100%;
            align-items: flex-start;
        }
        .msg-wrapper {
            display: flex;
            flex-direction: column;
            max-width: 70%;
        }
        .msg-bubble {
            padding: 8px 12px;
            border-radius: 12px;
            font-size: 13px;
            line-height: 1.45;
            word-break: break-all;
            white-space: pre-wrap;
            position: relative;
            box-shadow: 0 1px 2px rgba(0,0,0,0.15);
        }
        .msg-time {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            align-self: flex-end;
            margin: 0 6px;
            white-space: nowrap;
        }

        /* 나(내 채팅) 스타일: 우측 배치 및 VS Code 버튼색 어두운/밝은 파란색 계열 매칭 */
        .msg-row.me {
            justify-content: flex-end;
        }
        .msg-row.me .msg-wrapper {
            flex-direction: row;
            justify-content: flex-end;
        }
        .msg-row.me .msg-bubble {
            background-color: var(--vscode-button-background); /* VS Code 활성 테마 버튼색 */
            color: var(--vscode-button-foreground);
            border-top-right-radius: 2px;
        }
        .msg-row.me .msg-time {
            order: -1; /* 시간 표시가 말풍선 왼쪽으로 가게 설정 */
        }

        /* 상대방 스타일: 좌측 배치 및 어두운 카드/타일 배경 매칭 */
        .msg-row.other {
            justify-content: flex-start;
            gap: 8px;
        }
        .msg-row.other .msg-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: var(--vscode-badge-background, #3a3d41);
            color: var(--vscode-badge-foreground, #cccccc);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: bold;
            text-transform: uppercase;
            flex-shrink: 0;
            border: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.1));
        }
        .msg-row.other .msg-sender-name {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 3px;
            font-weight: 500;
        }
        .msg-row.other .msg-content-wrapper {
            display: flex;
            align-items: flex-end;
        }
        .msg-row.other .msg-bubble {
            background-color: var(--vscode-welcomePage-tileBackground, var(--vscode-sideBar-background));
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-widget-border, transparent);
            border-top-left-radius: 2px;
        }

        /* 시스템 메시지 스타일: 중앙 배치 */
        .msg-row.system {
            justify-content: center;
            margin: 8px 0;
        }
        .msg-row.system .system-bubble {
            background-color: var(--vscode-welcomePage-tileBackground, rgba(128, 128, 128, 0.15));
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-widget-border, transparent);
            font-size: 11px;
            padding: 4px 16px;
            border-radius: 20px;
            text-align: center;
        }

        /* 입력창 디자인 */
        #inputArea {
            background-color: var(--vscode-editor-background);
            padding: 10px 16px;
            display: flex;
            gap: 10px;
            align-items: center;
            border-top: 1px solid var(--vscode-widget-border, rgba(255, 255, 255, 0.08));
        }
        #chatInput {
            flex: 1;
            height: 38px;
            border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.15));
            border-radius: 20px;
            padding: 0 16px;
            font-size: 13px;
            outline: none;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        #chatInput:focus {
            border-color: var(--vscode-focusBorder);
        }
        #sendBtn {
            width: 60px;
            height: 38px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 20px;
            font-weight: bold;
            font-size: 13px;
            cursor: pointer;
            outline: none;
            transition: background-color 0.15s ease;
        }
        #sendBtn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="chatContainer">
        <div id="messageArea"></div>
        <div id="inputArea">
            <input type="text" id="chatInput" placeholder="메시지를 입력하세요..." onkeydown="handleKey(event)">
            <button id="sendBtn" onclick="sendMessage()">전송</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let myId = '${myId}';
        let participants = ${JSON.stringify(others)};

        // 페이지 로드 시 기존 기록 렌더링
        const initialHistory = ${JSON.stringify(chatHistory)};
        renderHistory(initialHistory);

        // 메시지 수신 리스너
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateHistory') {
                myId = message.myId;
                participants = message.others || {};
                renderHistory(message.history);
            }
        });

        function handleKey(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        }

        function sendMessage() {
            const input = document.getElementById('chatInput');
            const text = input.value.trim();
            if (!text) return;
            
            vscode.postMessage({
                type: 'send',
                text: text
            });
            input.value = '';
            input.focus();
        }

        // 참가자 명단(others)에서 최신 이름을 가져오거나 없으면 메시지의 발신자명을 씀
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
            const wasAtBottom = area.scrollHeight - area.scrollTop <= area.clientHeight + 50;
            area.innerHTML = '';

            history.forEach(msg => {
                const row = document.createElement('div');
                
                if (msg.isSystem) {
                    row.className = 'msg-row system';
                    row.innerHTML = '<div class="system-bubble">' + msg.text + '</div>';
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
                                        '<div class="msg-sender-name">' + currentName + '</div>' +
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
            return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
    }
}
