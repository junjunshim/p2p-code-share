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
                    case 'ready':
                        this.updateHistory(chatHistory, myId, others);
                        break;
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
        this._panel.webview.html = this._getHtmlForWebview();
    }

    /**
     * media 폴더의 정적 CSS, JS, HTML을 연결한 웹뷰 HTML을 생성합니다.
     * @returns {string} 웹뷰 HTML 마크업
     */
    private _getHtmlForWebview(): string {
        const webview = this._panel.webview;
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat', 'chat.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'chat', 'chat.js'));

        return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>P2P Chat Room</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="chatContainer">
        <div id="messageArea"></div>
        <div id="inputArea">
            <input type="text" id="chatInput" placeholder="메시지를 입력하세요...">
            <button id="sendBtn">전송</button>
        </div>
    </div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}

