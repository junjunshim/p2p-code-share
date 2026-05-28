/**
 * @file extension.ts
 * @description p2p-code-share를 위한 VS Code 확장 프로그램 진입점입니다.
 * 핵심 컴포넌트를 조율하고 확장 프로그램 명령어를 등록합니다.
 */

// VS Code API 및 핵심 확장 컴포넌트
import * as vscode from 'vscode';
import { SidebarProvider } from './ui/SidebarProvider';
import { HubManager } from './core/HubManager';
import { SyncEngine } from './core/SyncEngine';

/**
 * 확장 프로그램을 활성화합니다.
 * 주요 컴포넌트를 초기화하고 UI 및 P2P 로직을 위한 이벤트 핸들러를 설정합니다.
 * @param context VS Code 확장 프로그램 컨텍스트.
 */
export function activate(context: vscode.ExtensionContext) {
    // UI 제공자 및 핵심 P2P 엔진 초기화
    const sidebar = new SidebarProvider(context.extensionUri);
    const hub = new HubManager();
    const engine = new SyncEngine(hub, context, (state) => {
        // P2P 연결 상태에 따라 VS Code 컨텍스트 상태 업데이트
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', state.isConnected);
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', engine.isHost);
        
        // 상태 업데이트를 사이드바에 알림
        if (state.type === 'log') {
            // [수정] 로그는 엔진 웹뷰(getEngineTemplate)로만 전송
            hub.sendToEngine({ type: 'log', message: state.message });
        } else {
            sidebar.postMessage({
                type: 'renderState',
                isConnected: state.isConnected,
                isSetupMode: state.isSetupMode,
                files: state.files,
                participants: state,
                roomName: state.roomName,
                invitingSdp: state.invitingSdp
            });
        }
    });

    // 사이드바로부터 피어 초기화 요청 처리
    sidebar.onInitPeer = (initiator, roomName) => {
        // 기존 연결이 있다면 정리
        hub.dispose();
        engine.reset();

        // 방 이름이 있는 경우에만 Hub 생성 (수동 연결 방식을 위해 roomName이 빈 문자열일 수 있음)
        if (roomName) {
            hub.createHub(initiator, roomName);
        }
        engine.handleSetRole({ isHost: initiator, roomName });
    };

    // [추가] 방 참여 요청 처리
    sidebar.onJoinRoom = (roomName, description) => {
        hub.dispose();
        engine.reset();
        engine.sendJoinRequest(roomName, description);
    };

    // 사이드바가 준비되면 초기 UI 동기화 실행
    sidebar.onReady = () => { engine.pushUIUpdate(); };

    // 게스트 초대 프로세스 시작
    sidebar.onInviteGuest = () => {
        engine.inviteGuest();
    };

    // 특정 파일 공유 중지
    sidebar.onStopFileSharing = (fileName) => {
        engine.stopSharingByName(fileName);
    };

    // [추가] 승인 처리
    sidebar.onApproveRequest = (peerId) => {
        engine.approveRequest(peerId);
    };

    // [추가] 거절 처리
    sidebar.onRejectRequest = (peerId) => {
        engine.rejectRequest(peerId);
    };

    // P2P 연결을 위한 시그널링 데이터 적용
    sidebar.onSignal = (sdp, peerId) => hub.applySignal(sdp, peerId || 'default');
    
    // 취소 처리 및 엔진 상태 초기화
    sidebar.onCancel = (data?: any) => {
        if (engine.isConnected && engine.isHost && engine.isSetupMode) {
            // 설정 모드 종료
            engine.isSetupMode = false;
            engine.pushUIUpdate();
        } else {
            // 연결 해제 및 엔진 초기화
            hub.dispose();
            engine.reset();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    };

    // 사용자 이름 변경 처리
    sidebar.onRename = async () => {
        const n = await vscode.window.showInputBox({ placeHolder: "새 이름을 입력하세요" });
        if (n) engine.changeMyName(n);
    };

    // [추가] 강퇴 처리
    sidebar.onKick = (peerId) => {
        engine.kickPeer(peerId);
    };

    // [추가] 권한 제어 처리
    sidebar.onSetPermission = (peerId, permission) => {
        engine.setPeerPermission(peerId, permission);
    };

    // [추가] 파일 담당자 지정 처리
    sidebar.onAssignFileOwner = (fileName, assigneeId) => {
        engine.setFileAssignee(fileName, assigneeId);
    };

    // 시그널링을 위한 SDP 생성 처리
    hub.onSdpGenerated = (sdp, peerId) => {
        sidebar.postMessage({ type: 'sdpGenerated', sdp, peerId });
        engine.pushUIUpdate();
    };

    // 자동 시그널링 시 대기 중인 초대가 없을 경우 자동으로 초대 생성
    hub.onRequireInvite = () => {
        engine.inviteGuest(true);
    };

    // 방 이름 선점 성공 시 화면 전환
    hub.onRoomNameSuccess = () => {
        engine.isConnected = true;
        engine.pushUIUpdate();
    };

    // 방 이름 중복 또는 서버 에러 처리
    hub.onRoomNameError = (errorType: string) => {
        let msg = "";
        if (errorType === 'duplicate') {
            msg = "이미 사용 중인 방 이름입니다. 자동 연결 기능이 비활성화됩니다.";
        } else {
            msg = "PeerJS 서버 연결에 실패했습니다. 자동 연결 기능이 비활성화됩니다.";
        }
        vscode.window.showWarningMessage(`${msg} 수동 SDP 복사 방식을 이용해주세요.`);
        
        // 에러가 발생하더라도 수동 연결을 위해 방 화면으로 이동 허용
        engine.isConnected = true;
        engine.pushUIUpdate();
    };

    // P2P 상태 업데이트 관리
    hub.onStatusUpdate = (status, peerId) => {
        if (status === 'Connected') {
            // 연결 상태 알림
            hub.onDidReceiveData?.(JSON.stringify({ type: 'ON_CONNECTED' }), peerId);
        } else if (status === 'Disconnected') {
            // 피어 연결 해제 처리
            if (peerId === 'all') {
                engine.reset();
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
            } else {
                engine.handlePeerDisconnect(peerId);
            }
        }
    };

    // 확장 프로그램 명령어 및 제공자 등록
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebar),
        vscode.commands.registerCommand('p2p-code-share.shareActiveFile', (uri?: vscode.Uri) => {
            engine.shareActiveFile(uri);
        }),
        vscode.commands.registerCommand('p2p-code-share.stopSharing', () => engine.stopSharing()),
        vscode.commands.registerCommand('p2p-code-share.openSnapshot', (p) => vscode.workspace.openTextDocument(p).then(d => vscode.window.showTextDocument(d)))
    );
}

/**
 * 확장 프로그램을 비활성화합니다.
 */
export function deactivate() {}
