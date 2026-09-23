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
import { ChatPanel } from './ui/ChatPanel';

/**
 * 확장 프로그램을 활성화합니다.
 * 주요 컴포넌트를 초기화하고 UI 및 P2P 로직을 위한 이벤트 핸들러를 설정합니다.
 * @param context VS Code 확장 프로그램 컨텍스트.
 */
export function activate(context: vscode.ExtensionContext) {
    // 확장 프로그램 활성화 시 에디터 마우스 휠 코드 줌 기능 자동 활성화
    try {
        const config = vscode.workspace.getConfiguration();
        if (config.get('editor.mouseWheelZoom') !== true) {
            config.update('editor.mouseWheelZoom', true, vscode.ConfigurationTarget.Global);
        }
    } catch (e) {
        console.error("Failed to update mouseWheelZoom config:", e);
    }

    // UI 제공자 및 핵심 P2P 엔진 초기화
    const sidebar = new SidebarProvider(context.extensionUri);
    const hub = new HubManager();
    activeHub = hub;
    const engine = new SyncEngine(hub, context, (state) => {
        // P2P 연결 상태에 따라 VS Code 컨텍스트 상태 업데이트
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', state.isConnected);
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', engine.isHost);
        
        // 상태 업데이트를 사이드바에 알림
        if (state.type === 'log') {
            // 엔진 웹뷰(media/engine/engine.js)로 로그 전송
            hub.sendToEngine({ type: 'log', message: state.message });
        } else {
            sidebar.postMessage({
                type: 'renderState',
                isConnected: state.isConnected,
                isSetupMode: state.isSetupMode,
                files: state.files,
                participants: state,
                roomName: state.roomName,
                invitingSdp: state.invitingSdp,
                connectionType: state.connectionType,
                decorations: state.decorations,
                cursorFilter: state.cursorFilter,
                unreadChatCount: state.unreadChatCount,
                isFollowMeMode: state.isFollowMeMode,
                isAutoApprove: state.isAutoApprove,
                isReconnecting: state.isReconnecting,
                isSignalingConnected: state.isSignalingConnected
            });
        }
    });
    activeEngine = engine;

    // 사이드바로부터 피어 초기화 요청 처리
    sidebar.onInitPeer = (initiator, roomName) => {
        // 기존 연결이 있다면 정리
        hub.dispose();
        engine.reset(true);

        engine.handleSetRole({ isHost: initiator, roomName });
    };

    // 방 참여 요청 처리 (게스트의 참가 요청 전송)
    sidebar.onJoinRoom = (roomName, userName) => {
        hub.dispose();
        engine.reset(true);
        engine.sendJoinRequest(roomName, userName);
    };

    // P2P 엔진 메시지 수신 연동
    sidebar.onEngineMessage = (msg) => {
        const pid = msg.peerId || 'default';
        if (msg.type === 'sendData') hub.onDidReceiveData?.(msg.value, pid);
        else if (msg.type === 'statusUpdate') hub.onStatusUpdate?.(msg.value, pid);
        else if (msg.type === 'requireInvite') hub.onRequireInvite?.();
        else if (msg.type === 'roomNameSuccess') hub.onRoomNameSuccess?.();
        else if (msg.type === 'roomNameError') hub.onRoomNameError?.(msg.errorType);
        else if (msg.type === 'iceFailed') hub.onIceFailed?.(pid);
        else if (msg.type === 'sdpGenerated') {
            hub.sdpMap.set(pid, msg.sdp);
            hub.onSdpGenerated?.(msg.sdp, pid);
        } else if (msg.type === 'logMessage') {
            if (msg.level === 'warning') {
                vscode.window.showWarningMessage(msg.text);
            } else if (msg.level === 'info') {
                vscode.window.showInformationMessage(msg.text);
            }
            engine.logToUI(msg.text);
        }
    };

    // 사이드바가 준비되면 초기 UI 동기화 및 이전 세션 자동 복원 검사
    sidebar.onReady = async () => {
        if (sidebar.webview) {
            hub.setWebview(sidebar.webview);
        }

        // 새 창이 열렸을 때 이전 창에서 넘어온 세션이 있는지 확인 (Reload Window / Open Folder 대응)
        if (!engine.sessionRecoveryManager.isRestoringSession) {
            const session = engine.sessionRecoveryManager.getRecoverableSession();
            if (session) {
                await engine.sessionRecoveryManager.restoreSession(session);
            } else {
                engine.pushUIUpdate();
            }
        } else {
            engine.pushUIUpdate();
        }
    };

    // 게스트 초대 프로세스 시작
    sidebar.onInviteGuest = () => {
        engine.inviteGuest();
    };

    // 특정 파일 공유 중지
    sidebar.onStopFileSharing = (fileName) => {
        engine.stopSharingByName(fileName);
    };

    // 호스트: 게스트의 참여 요청 개별 승인 처리
    sidebar.onApproveRequest = (peerId) => {
        engine.approveRequest(peerId);
    };

    // 호스트: 대기 중인 모든 게스트 참여 요청 일괄 승인 처리
    sidebar.onApproveAllRequests = () => {
        engine.approveAllRequests();
    };

    // 호스트: 게스트의 참여 요청 거절 처리
    sidebar.onRejectRequest = (peerId) => {
        engine.rejectRequest(peerId);
    };

    // P2P 연결을 위한 시그널링 데이터 적용
    sidebar.onSignal = (sdp, peerId) => hub.applySignal(sdp, peerId || 'default');
    
    // 취소 처리 및 엔진 상태 초기화
    sidebar.onCancel = async (data?: any) => {
        if (engine.isConnected && engine.isHost && engine.isSetupMode) {
            // 설정 모드 종료
            engine.isSetupMode = false;
            engine.pushUIUpdate();
        } else {
            // 연결 해제 및 세션 완전 삭제
            await engine.sessionRecoveryManager.clearSession();
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

    // 호스트: 특정 참가자 강제 퇴장(강퇴) 처리
    sidebar.onKick = (peerId) => {
        engine.kickPeer(peerId);
    };

    // 호스트: 피어별 쓰기 권한 제어 처리 (readOnly / readWrite)
    sidebar.onSetPermission = (peerId, permission) => {
        engine.setPeerPermission(peerId, permission);
    };

    // 호스트: 모든 게스트 쓰기 권한 일괄 해제
    sidebar.onRevokeAllPermissions = () => {
        engine.revokeAllWritePermissions();
    };

    // 호스트: 공유 파일별 전담 수정자(담당자) 지정 처리
    sidebar.onAssignFileOwner = (fileName, assigneeId) => {
        engine.setFileAssignee(fileName, assigneeId);
    };

    // 코드 리뷰 데코레이션(하이라이트/메모) 삭제 처리
    sidebar.onDeleteDecoration = (id) => {
        engine.deleteDecoration(id);
    };
    sidebar.onJumpToDecoration = (fileName, line, char) => {
        engine.jumpToDecoration(fileName, line, char);
    };
    sidebar.onToggleShowDecorations = (show) => {
        engine.setShowDecorations(show);
    };
    sidebar.onChangeCursorFilter = (filter) => {
        engine.setCursorFilter(filter);
    };
    sidebar.onLeaveRoom = () => {
        engine.leaveRoomFlow();
    };
    sidebar.onOpenChat = () => {
        engine.unreadChatCount = 0;
        engine.pushUIUpdate();
        
        engine.chatPanel = ChatPanel.createOrShow(
            context.extensionUri, 
            engine.chatHistory, 
            engine.myId,
            engine.participantManager.participants
        );
        engine.chatPanel.onSendMessage = (text) => {
            engine.sendChatMessage(text);
        };
        engine.chatPanel.onClose = () => {
            engine.chatPanel = undefined;
        };
    };
    sidebar.onSendChat = (text) => {
        engine.sendChatMessage(text);
    };
    sidebar.onSetFollowMeMode = (enabled) => {
        engine.setFollowMeMode(enabled);
    };
    sidebar.onSetAutoApprove = (enabled) => {
        engine.setAutoApprove(enabled);
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

    // 방 이름 선점 성공 시 화면 전환 및 게스트 수락 대기열(Invite Slot) 자동 생성
    hub.onRoomNameSuccess = () => {
        engine.sessionRecoveryManager.isRestoringSession = false;
        engine.sessionRecoveryManager.restoreRetryCount = 0;
        engine.isConnected = true;
        engine.isSignalingConnected = true; // 시그널링 서버 연결 완료 상태 플래그 설정
        engine.sessionRecoveryManager.startHeartbeat();

        // 호스트인 경우: 재연결 게스트 전원 + 신규 게스트 유입 버퍼(5개)만큼 슬롯을 사전 생성
        if (engine.isHost) {
            const guestCount = Object.keys(engine.participantManager.participants).filter(id => id !== 'host' && id !== 'default').length;
            // 기존 참가자 수 + 신규 참가자 대비 버퍼(최소 5개 확보)
            const slotsToCreate = Math.max(5, guestCount + 5);
            engine.logToUI(`Preparing ${slotsToCreate} invite slots for reconnecting guests (${guestCount}) and new guests...`);

            // 최초 5개는 0ms 즉시 생성하여 복구 직후 몰려오는 요청을 즉시 수용, 나머지는 50ms 간격으로 생성
            for (let i = 0; i < slotsToCreate; i++) {
                const delay = i < 5 ? 0 : (i - 4) * 50;
                setTimeout(() => {
                    if (engine.isConnected && engine.isHost) {
                        engine.participantManager.inviteGuest(true);
                    }
                }, delay);
            }
        }

        engine.pushUIUpdate();
    };

    // WebRTC ICE 바인딩 실패 시 조기 감지 및 빠른 재시도
    hub.onIceFailed = (peerId: string) => {
        if (!engine.isHost && engine.participantManager.isReconnecting) {
            engine.logToUI(`ICE connection failed for peer ${peerId}. Triggering early reconnection probe...`);
            engine.participantManager.onGuestReconnectProbeFailed();
        }
    };

    // 방 이름 중복 또는 서버 에러 처리
    hub.onRoomNameError = (errorType: string) => {
        engine.isSignalingConnected = false;
        if (!engine.isHost) {
            // 수동 연결 모드(수동 SDP 교환 중이거나 자동 참가가 아닌 경우):
            // 시그널링 서버를 통한 연결이 아니므로 시그널링 에러(방 부재/서버 오류 등)를 무시합니다.
            if (engine.isSetupMode || !engine.participantManager.isAutoJoin || !engine.roomName) {
                return;
            }

            // 게스트가 호스트 재연결 유예 기간(Grace Period) 중인 경우:
            // 호스트 창이 아직 서버에 안 떴거나 일시적으로 서버 연결 중일 수 있으므로 즉시 에러 팝업을 띄우거나 reset()하지 않음
            if (engine.participantManager.isReconnecting) {
                engine.logToUI(`Guest reconnect probe (${errorType}): Host room not ready yet, will retry...`);
                engine.participantManager.onGuestReconnectProbeFailed();
                return;
            }

            // 게스트가 이미 호스트와 P2P 연결되어 방에 정상 입장해 있는 경우:
            // 일시적인 시그널링 서버 연결 끊김/에러로 인해 진행 중인 P2P 세션에서 퇴장되지 않도록 보호합니다.
            // (PeerJS는 백그라운드에서 자동 재연결을 시도하며, 실제 P2P 통신은 WebRTC DataChannel을 통해 유지됩니다.)
            if (engine.isConnected) {
                engine.logToUI(`Signaling server notice while connected (${errorType}): P2P session remains active.`);
                engine.pushUIUpdate();
                return;
            }

            let msg = "호스트 연결에 실패했습니다.";
            if (errorType === 'unavailable') {
                msg = "호스트가 오프라인이거나 존재하지 않는 방 이름입니다.";
            } else if (errorType === 'server') {
                msg = "시그널링 서버 연결에 실패했습니다.";
            }
            vscode.window.showErrorMessage(msg);
            hub.dispose();
            engine.reset();
            return;
        }

        // 호스트인 경우: 이전 창의 소켓이 서버에서 정리되는 중일 수 있으므로(고스트 ID),
        // 세션 복구 중이라면 팝업을 띄우지 않고 0.8초 간격으로 최대 6회 조용히 재시도
        if (engine.sessionRecoveryManager.isRestoringSession && errorType === 'duplicate') {
            if (engine.sessionRecoveryManager.restoreRetryCount < 6) {
                engine.sessionRecoveryManager.restoreRetryCount++;
                engine.logToUI(`Previous host session ghost ID still clearing on server. Retrying in 800ms (${engine.sessionRecoveryManager.restoreRetryCount}/6)...`);
                setTimeout(() => {
                    if (engine.sessionRecoveryManager.isRestoringSession) {
                        hub.dispose();
                        hub.createHub(true, engine.roomName, 'none');
                    }
                }, 800);
                return;
            }
        }

        engine.sessionRecoveryManager.isRestoringSession = false;
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
        if (status.startsWith('Connected')) {
            if (status.includes('TURN')) {
                engine.connectionType = 'TURN';
            } else {
                engine.connectionType = 'Direct';
            }
            // 연결 상태 알림
            hub.onDidReceiveData?.(JSON.stringify({ type: 'ON_CONNECTED' }), peerId);
        } else if (status === 'Disconnected') {
            // 피어 연결 해제 처리
            if (!engine.isHost) {
                // 게스트는 peerId가 'all'이든 개별이든 유예 기간 로직(startGuestReconnectGracePeriod)을 태움
                engine.handlePeerDisconnect(peerId);
            } else {
                if (peerId === 'all') {
                    engine.reset();
                    vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
                    vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
                } else {
                    engine.handlePeerDisconnect(peerId);
                }
            }
        }
    };

    // 확장 프로그램 명령어 및 제공자 등록
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebar, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('p2p-code-share.shareActiveFile', (uri?: vscode.Uri) => {
            engine.shareActiveFile(uri);
        }),
        vscode.commands.registerCommand('p2p-code-share.stopSharing', () => engine.stopSharing()),
        vscode.commands.registerCommand('p2p-code-share.openSnapshot', (p) => vscode.workspace.openTextDocument(p).then(d => vscode.window.showTextDocument(d))),
        vscode.commands.registerCommand('p2p-code-share.addDecoration', () => engine.addDecorationFlow()),
        vscode.commands.registerCommand('p2p-code-share.deleteDecoration', (id: string) => engine.deleteDecoration(id))
    );

    // 창이 새로 로드되거나 폴더 전환 시, 사이드바를 직접 클릭하지 않아도 세션 복구가 즉각 실행되도록 트리거
    const recoverableSession = engine.sessionRecoveryManager.getRecoverableSession();
    if (recoverableSession) {
        // 사이드바 뷰를 포커스/활성화하여 resolveWebviewView 및 onReady -> restoreSession이 즉시 가동되도록 함
        vscode.commands.executeCommand('p2p-code-share-sidebar.focus');
    }
}

let activeHub: HubManager | undefined;
let activeEngine: SyncEngine | undefined;

/**
 * 확장 프로그램을 비활성화합니다.
 * 창 종료(Reload Window / Open Folder) 직전 최신 세션을 저장하고 소켓을 명시적으로 정리합니다.
 */
export function deactivate() {
    try {
        if (activeEngine && activeEngine.isConnected) {
            // 동기적으로 하트비트 타임스탬프 갱신
            activeEngine.sessionRecoveryManager.saveSession();
        }
        if (activeHub) {
            activeHub.dispose();
        }
    } catch (e) {}
}
