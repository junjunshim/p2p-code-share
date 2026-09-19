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
 * VS Code 사이드바 패널 영역에 웹뷰(WebviewView)를 등록하고,
 * 사이드바 UI와의 이벤트 통신(방 생성, 방 참여, 참가자 권한 변경, 초대, 채팅, 데코레이션 조작 등)을 중계합니다.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
    /** 사이드바 웹뷰 뷰 인스턴스 참조 */
    private _view?: vscode.WebviewView;

    /** 피어 초기화 요청 시 호출되는 콜백 */
    public onInitPeer?: (initiator: boolean, roomName: string) => void;

    /** 게스트가 방 참여 요청 시 호출되는 콜백 */
    public onJoinRoom?: (roomName: string, userName: string) => void;

    /** 게스트 초대 버튼 클릭 시 호출되는 콜백 */
    public onInviteGuest?: () => void;

    /** 사이드바 웹뷰 UI 로드 완료 시 호출되는 콜백 */
    public onReady?: () => void;

    /** WebRTC 시그널링 데이터 송수신 시 호출되는 콜백 */
    public onSignal?: (sdp: any, peerId?: string) => void;

    /** 작업 취소 시 호출되는 콜백 */
    public onCancel?: (data?: any) => void;

    /** 사용자 이름 변경 요청 시 호출되는 콜백 */
    public onRename?: () => void;

    /** 특정 파일 공유 중지 요청 시 호출되는 콜백 */
    public onStopFileSharing?: (fileName: string) => void;

    /** 참가자 강제 퇴장 요청 시 호출되는 콜백 */
    public onKick?: (peerId: string) => void;

    /** 특정 피어의 권한 변경 시 호출되는 콜백 */
    public onSetPermission?: (peerId: string, permission: any) => void;

    /** 모든 게스트 쓰기 권한 일괄 해제 요청 시 호출되는 콜백 */
    public onRevokeAllPermissions?: () => void;

    /** 단일 참여 요청 승인 시 호출되는 콜백 */
    public onApproveRequest?: (peerId: string) => void;

    /** 모든 대기 중인 참여 요청 일괄 승인 시 호출되는 콜백 */
    public onApproveAllRequests?: () => void;

    /** 참여 요청 거절 시 호출되는 콜백 */
    public onRejectRequest?: (peerId: string) => void;

    /** 파일 단독 편집 담당자 지정 시 호출되는 콜백 */
    public onAssignFileOwner?: (fileName: string, assigneeId: string) => void;

    /** 데코레이션 삭제 요청 시 호출되는 콜백 */
    public onDeleteDecoration?: (id: string) => void;

    /** 데코레이션 위치로 에디터 점프 요청 시 호출되는 콜백 */
    public onJumpToDecoration?: (fileName: string, line: number, char: number) => void;

    /** 커서 렌더링 필터 변경 시 호출되는 콜백 */
    public onChangeCursorFilter?: (filter: 'host' | 'editable' | 'all') => void;

    /** 방 나가기(퇴장) 요청 시 호출되는 콜백 */
    public onLeaveRoom?: () => void;

    /** WebRTC 엔진 내부 이벤트 라우팅 시 호출되는 콜백 */
    public onEngineMessage?: (msg: any) => void;

    /** 채팅 메시지 전송 요청 시 호출되는 콜백 */
    public onSendChat?: (text: string) => void;

    /** 별도 창 채팅 패널 열기 요청 시 호출되는 콜백 */
    public onOpenChat?: () => void;

    /** 화면 동기화(팔로우 모드) 토글 시 호출되는 콜백 */
    public onSetFollowMeMode?: (enabled: boolean) => void;

    /** 자동 승인 모드 토글 시 호출되는 콜백 */
    public onSetAutoApprove?: (enabled: boolean) => void;

    /** 데코레이션 표시/숨김 토글 시 호출되는 콜백 */
    public onToggleShowDecorations?: (show: boolean) => void;

    /**
     * 현재 바인딩된 Webview 인스턴스를 반환합니다.
     */
    public get webview(): vscode.Webview | undefined {
        return this._view?.webview;
    }

    /**
     * SidebarProvider 인스턴스를 생성합니다.
     * @param _extensionUri 확장 프로그램 루트 URI.
     */
    constructor(private readonly _extensionUri: vscode.Uri) {}

    /**
     * 사이드바 WebviewView를 해결하고 HTML 및 이벤트 리스너를 바인딩합니다.
     * @param webviewView VS Code에 의해 생성된 WebviewView 인스턴스.
     * @returns {void}
     */
    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        // 웹뷰 옵션 구성
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        // 초기 HTML 템플릿 설정
        webviewView.webview.html = getSidebarTemplate();
        (webviewView as any).retainContextWhenHidden = true;

        // 웹뷰로부터의 메시지 수신 및 라우팅 처리
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                // UI 준비 완료 이벤트
                case 'ready': this.onReady?.(); break;
                // 피어 초기화 요청
                case 'initPeer': this.onInitPeer?.(msg.initiator, msg.roomName); break;
                // 방 참여 요청
                case 'joinRoom': this.onJoinRoom?.(msg.roomName, msg.userName); break;
                // 게스트 초대 동작
                case 'inviteGuest': this.onInviteGuest?.(); break;
                // WebRTC 시그널링 데이터
                case 'signal': this.onSignal?.(msg.sdp, msg.peerId); break;
                // 연결/작업 취소 동작
                case 'cancel': this.onCancel?.(); break;
                // 닉네임 변경 요청
                case 'rename': this.onRename?.(); break;
                // 강제 퇴장 요청
                case 'kick': this.onKick?.(msg.peerId); break;
                // 권한 변경
                case 'setPermission': this.onSetPermission?.(msg.peerId, msg.permission); break;
                case 'revokeAllPermissions': this.onRevokeAllPermissions?.(); break;
                // 파일 스냅샷 열기 명령어 실행
                case 'openFile': vscode.commands.executeCommand('p2p-code-share.openSnapshot', msg.path); break;
                // 파일 공유 중지 동작
                case 'stopFileSharing': this.onStopFileSharing?.(msg.fileName); break;
                // 참여 요청 승인/일괄승인/거절
                case 'approveRequest': this.onApproveRequest?.(msg.peerId); break;
                case 'approveAllRequests': this.onApproveAllRequests?.(); break;
                case 'rejectRequest': this.onRejectRequest?.(msg.peerId); break;
                // 파일 전담자 지정
                case 'assignFileOwner': this.onAssignFileOwner?.(msg.fileName, msg.assigneeId); break;
                // 데코레이션 관련 조작
                case 'deleteDecoration': this.onDeleteDecoration?.(msg.id); break;
                case 'jumpToDecoration': this.onJumpToDecoration?.(msg.fileName, msg.line, msg.char); break;
                case 'toggleShowDecorations': this.onToggleShowDecorations?.(msg.show); break;
                case 'changeCursorFilter': this.onChangeCursorFilter?.(msg.filter); break;
                case 'leaveRoom': this.onLeaveRoom?.(); break;
                // 채팅방 팝업 및 메시지 전송
                case 'openChat': this.onOpenChat?.(); break;
                case 'sendChat': this.onSendChat?.(msg.text); break;
                // 화면 동기화 팔로우 모드 토글
                case 'setFollowMeMode': this.onSetFollowMeMode?.(msg.enabled); break;
                // 자동 승인 모드 토글
                case 'setAutoApprove': this.onSetAutoApprove?.(msg.enabled); break;
                // P2P 엔진 시그널링 및 상태 메시지 라우팅
                case 'sendData':
                case 'statusUpdate':
                case 'requireInvite':
                case 'roomNameSuccess':
                case 'roomNameError':
                case 'sdpGenerated':
                    this.onEngineMessage?.(msg);
                    break;
            }
        });
    }

    /**
     * 사이드바 웹뷰로 상태 갱신 메시지를 전송합니다.
     * @param msg 웹뷰로 전달할 데이터 메시지 객체.
     * @returns {void}
     */
    public postMessage(msg: any): void {
        this._view?.webview.postMessage(msg);
    }
}
