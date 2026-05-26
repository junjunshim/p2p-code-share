/**
 * @file SidebarProvider.ts
 * @description 확장 프로그램 사이드바를 위한 WebviewViewProvider를 구현합니다.
 * 사이드바 Webview와 확장 프로그램 호스트 간의 UI 상호작용 및 통신을 처리합니다.
 */

// VS Code API
import * as vscode from 'vscode';
// 사이드바를 위한 HTML 템플릿 제공자
import { getSidebarTemplate } from '../ui/templates';

/**
 * SidebarProvider 클래스.
 * 사이드바 Webview 콘텐츠와 이벤트 전달을 관리합니다.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    public onInitPeer?: (initiator: boolean, roomName: string) => void;
    public onJoinRoom?: (roomName: string, description: string) => void; // [추가]
    public onInviteGuest?: () => void;
    public onReady?: () => void;
    public onSignal?: (sdp: any, peerId?: string) => void;
    public onCancel?: (data?: any) => void;
    public onRename?: () => void;
    public onStopFileSharing?: (fileName: string) => void;
    public onKick?: (peerId: string) => void; // [추가]
    public onApproveRequest?: (peerId: string) => void; // [추가]
    public onRejectRequest?: (peerId: string) => void; // [추가]

    /**
     * SidebarProvider의 인스턴스를 생성합니다.
     * @param _extensionUri 확장 프로그램의 URI.
     */
    constructor(private readonly _extensionUri: vscode.Uri) {}

    /**
     * 웹뷰 뷰를 해결하고 HTML 및 메시징을 설정합니다.
     * @param webviewView 해결할 웹뷰 뷰.
     */
    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        // 웹뷰 옵션 구성
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        // 초기 HTML 템플릿 설정
        webviewView.webview.html = getSidebarTemplate();
        (webviewView as any).retainContextWhenHidden = true;

        // 웹뷰로부터의 메시지 처리
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                // UI 준비 이벤트
                case 'ready': this.onReady?.(); break;
                // 피어 초기화 요청
                case 'initPeer': this.onInitPeer?.(msg.initiator, msg.roomName); break;
                // [추가] 방 참여 요청
                case 'joinRoom': this.onJoinRoom?.(msg.roomName, msg.description); break;
                // 게스트 초대 동작
                case 'inviteGuest': this.onInviteGuest?.(); break;
                // 시그널링 데이터
                case 'signal': this.onSignal?.(msg.sdp, msg.peerId); break;
                // 취소 동작
                case 'cancel': this.onCancel?.(); break;
                // 이름 변경 요청
                case 'rename': this.onRename?.(); break;
                // 강퇴 요청
                case 'kick': this.onKick?.(msg.peerId); break;
                // 파일 스냅샷 열기 명령어
                case 'openFile': vscode.commands.executeCommand('p2p-code-share.openSnapshot', msg.path); break;
                // 파일 공유 중지 동작
                case 'stopFileSharing': this.onStopFileSharing?.(msg.fileName); break;
                // [추가] 승인/거절
                case 'approveRequest': this.onApproveRequest?.(msg.peerId); break;
                case 'rejectRequest': this.onRejectRequest?.(msg.peerId); break;
            }
        });
    }

    /**
     * 사이드바 웹뷰로 메시지를 전송합니다.
     * @param msg 보낼 메시지.
     */
    public postMessage(msg: any) {
        this._view?.webview.postMessage(msg);
    }
}
