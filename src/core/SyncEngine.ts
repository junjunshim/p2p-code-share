/**
 * @file SyncEngine.ts
 * @description 피어 간 파일 내용, 커서 및 상태를 동기화하기 위한 핵심 엔진입니다.
 * 각 서브매니저들을 조정하는 Orchestrator 역할을 수행합니다.
 */

import * as vscode from 'vscode';
import { HubManager } from './HubManager';
import { SharedFile, P2PMessage, PeerPermission, FileDecoration, ChatMessage } from '../types';
import { ChatPanel } from '../ui/ChatPanel';
import { isPathEqual } from '../utils/helpers';

import { FileStorageManager } from './sync/FileStorageManager';
import { ParticipantManager } from './sync/ParticipantManager';
import { CursorManager } from './sync/CursorManager';
import { DecorationManager } from './sync/DecorationManager';
import { DocumentSyncManager } from './sync/DocumentSyncManager';
import { SessionRecoveryManager } from './sync/SessionRecoveryManager';

/**
 * SyncEngine 클래스.
 * P2P 파일 공유 및 실시간 코드 협업의 중앙 오케스트레이터(Orchestrator) 엔진입니다.
 * 하위 매니저(FileStorageManager, ParticipantManager, CursorManager, DecorationManager,
 * DocumentSyncManager, SessionRecoveryManager)를 총괄 제어하며, WebRTC 메시지 라우팅,
 * 화면 동기화(Follow Me), 실시간 채팅 및 에디터 이벤트 처리를 중계합니다.
 */
export class SyncEngine {
    /** 세션 내 누적된 전체 채팅 메시지 이력 */
    public chatHistory: ChatMessage[] = [];

    /** 실시간 채팅 Webview 패널 인스턴스 참조 */
    public chatPanel?: ChatPanel;

    /** 사용자가 아직 확인하지 않은 안 읽은 채팅 메시지 수 카운터 */
    public unreadChatCount = 0;

    /** 호스트 화면 스크롤/탭 전환을 게스트가 실시간으로 추종하는 팔로우 모드 활성화 여부 */
    public isFollowMeMode = false;

    /** 공유 파일 목록 및 로컬 스토리지 I/O를 전담하는 매니저 */
    public fileStorageManager: FileStorageManager;

    /** 방 참여자, 승인 대기열, 권한 및 핑퐁 상태를 전담하는 매니저 */
    public participantManager: ParticipantManager;

    /** 피어별 커서/선택영역 동기화 및 렌더링을 전담하는 매니저 */
    public cursorManager: CursorManager;

    /** 인라인 피드백 데코레이션(오타, 문법, 메모 등)을 전담하는 매니저 */
    public decorationManager: DecorationManager;

    /** Yjs CRDT 문서 상태 및 에디터 텍스트 동기화를 전담하는 매니저 */
    public documentSyncManager: DocumentSyncManager;

    /** 창 새로고침/작업공간 전환 시 세션 영속화 및 자동 복구를 전담하는 매니저 */
    public sessionRecoveryManager: SessionRecoveryManager;

    /** 현재 사용자가 세션의 호스트(Host)인지 여부 플래그 */
    public isHost = false;

    /** 현재 사용자의 표시 닉네임 */
    public myName = '';

    /** 현재 사용자의 고유 피어 ID (호스트: 'host', 게스트: 고유 ID) */
    public myId = '';

    /** 세션 시작 시 지정되었던 초기 닉네임 */
    public initialName = '';

    /** 참여 중인 P2P 방 이름 */
    public roomName = '';

    /** 방 생성/참여 설정 단계(초대 대기 등)에 있는지 여부 플래그 */
    public isSetupMode = false;

    /** P2P 데이터 채널이 성공적으로 연결되었는지 여부 플래그 */
    public isConnected = false;

    /** 시그널링 서버와의 WebSocket 연결이 완료되었는지 여부 플래그 */
    public isSignalingConnected = false;

    /** 연결 유형 문자열 ('Direct' | 'TURN') */
    public connectionType = 'Direct';

    /** 원격 사용자의 타이핑으로 인해 내 에디터 입력을 잠그는 플래그 맵 */
    public remoteTypingLocked = new Map<string, boolean>();

    /** 내 타이핑 종료 후 잠금 해제 메시지(TYPING_UNLOCK)를 발송하기 위한 타이머 맵 */
    public localTypingUnlockTimers = new Map<string, NodeJS.Timeout>();

    /**
     * 현재 세션에서 공유 중인 파일 목록을 반환합니다 (FileStorageManager 위임).
     */
    public get sharedFiles(): SharedFile[] {
        return this.fileStorageManager.sharedFiles;
    }

    /**
     * 현재 세션의 참가자 권한 목록을 반환합니다 (ParticipantManager 위임).
     */
    public get participants(): { [key: string]: PeerPermission } {
        return this.participantManager.participants;
    }

    /**
     * 현재 등록된 데코레이션 목록을 반환합니다 (DecorationManager 위임).
     */
    public get decorations(): FileDecoration[] {
        return this.decorationManager.decorations;
    }

    /**
     * 현재 설정된 커서 필터링 모드를 반환합니다 (CursorManager 위임).
     */
    public get cursorFilter(): 'host' | 'editable' | 'all' {
        return this.cursorManager.cursorFilter;
    }

    /**
     * SyncEngine 인스턴스를 생성하고 모든 서브 매니저와 이벤트 리스너를 초기화합니다.
     * @param hub WebRTC P2P 통신을 중계하는 HubManager 인스턴스.
     * @param context VS Code 확장 컨텍스트.
     * @param updateUI 사이드바 Webview UI 갱신을 트리거하는 콜백 함수.
     */
    constructor(
        public hub: HubManager,
        public context: vscode.ExtensionContext,
        private updateUI: (state: any) => void
    ) {
        // 서브 매니저 인스턴스 생성 및 주입
        this.fileStorageManager = new FileStorageManager(this);
        this.participantManager = new ParticipantManager(this);
        this.cursorManager = new CursorManager(this);
        this.decorationManager = new DecorationManager(this);
        this.documentSyncManager = new DocumentSyncManager(this);
        this.sessionRecoveryManager = new SessionRecoveryManager(this, this.context);

        // 초기 이벤트 핸들러 및 리스너 설정
        this.setupHandlers();
        this.setupTextListeners();
    }

    /**
     * P2P 데이터 메시지를 위한 이벤트 핸들러를 설정하고 메시지를 라우팅합니다.
     */
    public setupHandlers() {
        this.hub.onDidReceiveData = async (text, peerId) => {
            this.logToUI(`Data received from peer: ${peerId}`);
            try {
                // 호스트인 경우 게스트로부터 정상적인 데이터 수신 시 생존(Alive) 시간 갱신
                if (this.isHost && peerId) {
                    this.participantManager.handlePong(peerId);
                }

                // 수신된 P2P 메시지 파싱
                const msg = JSON.parse(text) as P2PMessage;
                switch (msg.type) {
                    case 'SET_ROLE': this.handleSetRole(msg); break;
                    case 'ON_CONNECTED': this.handleOnConnected(peerId); break;
                    case 'ASSIGN_PEER_ID': this.handleAssignPeerId(msg); break;
                    case 'CHAT_MESSAGE':
                        if (msg.chatMessage) {
                            // 이미 기록이 존재하지 않는 경우에만 푸시 (중복 방어)
                            const isDuplicate = this.chatHistory.some(h => h.id === msg.chatMessage.id);
                            if (!isDuplicate) {
                                this.chatHistory.push(msg.chatMessage);
                                if (this.isHost) {
                                    // 다른 참여자들에게만 채팅 중계 (보낸 사람 제외)
                                    Object.keys(this.participantManager.participants).forEach(pId => {
                                        if (pId !== 'host' && pId !== peerId) {
                                            this.sendMessageToPeer(pId, 'CHAT_MESSAGE', { chatMessage: msg.chatMessage });
                                        }
                                    });
                                }
                                
                                // 안 읽은 카운트 누적 (채팅 패널이 열려있지 않을 때만)
                                if (!this.chatPanel) {
                                    this.unreadChatCount++;
                                }
                                
                                this.chatPanel?.updateHistory(this.chatHistory, this.myId, this.participantManager.participants);
                                this.pushUIUpdate(); // 사이드바 버튼 배지 갱신을 위해 UI 강제 업데이트
                            }
                        }
                        break;
                    case 'TYPING_LOCK':
                    case 'TYPING_UNLOCK':
                        // 동시 편집 지원을 위해 타이핑 락을 적용하지 않음 (하위 호환성 유지)
                        break;
                    case 'FOLLOW_UPDATE':
                        // 게스트가 호스트의 화면 위치를 추적하여 동기화
                        if (!this.isHost) {
                            await this.handleFollowUpdate(msg.fileName, msg.startLine, msg.endLine);
                        }
                        break;
                    case 'INIT_SNAPSHOT': 
                        await this.fileStorageManager.handleGuestInitSnapshot(msg); 
                        break;
                    case 'REQUEST_FILE_SYNC':
                        if (this.isHost && peerId) {
                            this.logToUI(`REQUEST_FILE_SYNC received from peer ${peerId}. Resending requested snapshots...`);
                            this.participantManager.sendInitialSnapshotsToPeer(peerId, msg.missingFiles);
                        }
                        break;
                    case 'YJS_UPDATE':
                        await this.documentSyncManager.handleYjsUpdate(msg);
                        if (this.isHost) {
                            // 다른 참여자들에게 변경사항 중계 (보낸 피어 제외)
                            Object.keys(this.participantManager.participants).forEach(pId => {
                                if (pId !== 'host' && pId !== peerId) {
                                    this.sendMessageToPeer(pId, 'YJS_UPDATE', msg);
                                }
                            });
                        }
                        break;
                    case 'GUEST_JOIN': 
                        this.logToUI(`GUEST_JOIN from peer: ${peerId}, Name: ${msg.name}`);
                        if (this.isHost) {
                            const isAutoJoining = this.participantManager.joinRequests.some(r => r.peerId === peerId);
                            if (!isAutoJoining) {
                                this.participantManager.handleGuestJoin(msg, peerId);
                                this.updateStatus('Connected');
                            }
                        }
                        break;
                    case 'GUEST_RENAME':
                        const newName = msg.newName;
                        const renameTargetId = msg.peerId || peerId;
                        if (renameTargetId) {
                            if (this.participantManager.participants[renameTargetId]) {
                                this.participantManager.participants[renameTargetId].name = newName;
                            }
                            // 커서 상태 캐시에 저장된 닉네임도 즉시 갱신
                            const cursorState = this.cursorManager['remoteCursorStates'].get(renameTargetId);
                            if (cursorState) {
                                cursorState.userName = newName;
                            }
                            // 해당 게스트가 남긴 데코레이션의 작성자 이름 변경
                            this.decorationManager.decorations.forEach(d => {
                                if (d.creatorId === renameTargetId) d.creatorName = newName;
                            });
                            // 해당 게스트가 담당자인 파일의 assigneeName 로컬 갱신
                            this.fileStorageManager.sharedFiles.forEach(f => {
                                if (f.assigneeId === renameTargetId) f.assigneeName = newName;
                            });
                        }

                        if (this.isHost && renameTargetId) { 
                            this.participantManager.broadcastUserList(); 
                            this.decorationManager.broadcastDecorations();

                            // 해당 게스트가 담당자로 지정된 파일의 assigneeName 갱신 및 브로드캐스트
                            this.fileStorageManager.sharedFiles.forEach(f => {
                                if (f.assigneeId === renameTargetId) {
                                    f.assigneeName = newName;
                                    this.sendMessage('FILE_ASSIGNEE_UPDATE', {
                                        fileName: f.name,
                                        assigneeId: renameTargetId,
                                        assigneeName: newName
                                    });
                                }
                            });

                            // 다른 게스트들에게도 이름 변경 사실을 즉각 중계하여 전원의 화면에서 커서 이름 갱신
                            Object.keys(this.participantManager.participants).forEach(pId => {
                                if (pId !== 'host' && pId !== renameTargetId) {
                                    this.sendMessageToPeer(pId, 'GUEST_RENAME', { newName, peerId: renameTargetId });
                                }
                            });
                        }
                        this.cursorManager.refreshAllDecorations();
                        this.pushUIUpdate();
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'FILE_ASSIGNEE_UPDATE': await this.handleFileAssigneeUpdate(msg); break;
                    case 'STOP_SHARING': await this.fileStorageManager.handleRemoteStop(msg.fileName); break;
                    case 'CURSOR_UPDATE': 
                        const senderId = msg.userId || peerId; 
                        this.cursorManager.updateRemoteCursor(msg, senderId); 
                        if (this.isHost) this.broadcastCursor(msg, senderId);
                        break;
                    case 'JOIN_REQUEST': this.participantManager.handleJoinRequest(msg, peerId); break;
                    case 'JOIN_REQUEST_ACK': this.participantManager.handleJoinRequestAck(msg); break;
                    case 'JOIN_RESPONSE': this.participantManager.handleJoinResponse(msg); break;
                    case 'ROOM_CLOSED': this.participantManager.handleRoomClosed(msg); break;
                    case 'KICKED': this.participantManager.handleKicked(msg); break;
                    case 'SET_PERMISSION': await this.participantManager.handleSetPermission(msg); break;
                    case 'ADD_DECORATION':
                        if (this.isHost && msg.decoration) {
                            const exists = this.decorationManager.decorations.some(d => d.id === msg.decoration.id);
                            if (!exists) {
                                // 피어 ID 변조 방지 및 실제 접속자 닉네임 정합성 보장
                                if (peerId && peerId !== 'host') {
                                    msg.decoration.creatorId = peerId;
                                    if (this.participantManager.participants[peerId]) {
                                        msg.decoration.creatorName = this.participantManager.participants[peerId].name;
                                    }
                                }
                                this.decorationManager.decorations.push(msg.decoration);
                                this.decorationManager.broadcastDecorations();
                            }
                        }
                        break;
                    case 'DELETE_DECORATION':
                        if (this.isHost) {
                            const deco = this.decorationManager.decorations.find(d => d.id === msg.id);
                            const senderPeerId = peerId;
                            if (deco && (deco.creatorId === senderPeerId || (msg.creatorId && deco.creatorId === msg.creatorId) || senderPeerId === 'host')) {
                                this.decorationManager.decorations = this.decorationManager.decorations.filter(d => d.id !== msg.id);
                                this.decorationManager.broadcastDecorations();
                            }
                        }
                        break;
                    case 'SYNC_DECORATIONS':
                        this.decorationManager.decorations = msg.decorations || [];
                        this.decorationManager.refreshDecorationsInEditors();
                        this.pushUIUpdate();
                        break;
                    case 'GUEST_LEAVE':
                        this.handleGuestLeave(msg, peerId);
                        break;
                    case 'PING':
                        if (!this.isHost) {
                            this.sendMessage('PONG', { peerId: this.myId, name: this.myName, timestamp: msg.timestamp });
                        }
                        break;
                    case 'PONG':
                        if (this.isHost) {
                            if (peerId) {
                                this.participantManager.handlePong(peerId);
                            }
                            if (msg.peerId && msg.peerId !== peerId) {
                                this.participantManager.handlePong(msg.peerId);
                            }
                            if (msg.name) {
                                this.participantManager.handlePong(msg.name);
                            }
                        }
                        break;
                }
            } catch (e) {}
        };
    }

    /**
     * WebRTC 데이터 채널 연결 성공 이벤트를 처리합니다.
     * @param peerId 연결된 피어 식별자
     */
    private handleOnConnected(peerId: string) {
        this.logToUI(`ON_CONNECTED received: ${peerId}`);
        if (this.isHost) {
            if (this.participantManager.pendingInvites.has(peerId)) {
                this.isSetupMode = false;
                this.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
                this.participantManager.pendingInvites.delete(peerId);
            }
        } else {
            // 호스트와 WebRTC 채널이 정상 연결되었으므로 "호스트 연결 시도 시간 초과(20초)" 타이머를 즉시 해제
            this.participantManager.clearJoinTimeout();

            if (!this.participantManager.isAutoJoin) {
                // 수동 연결의 경우 호스트로부터 피어 ID 할당 및 방 정보(USER_LIST_UPDATE)를 수신할 때까지 대기
                this.logToUI("Manual connection established, finalizing handshake...");
                this.updateStatus('Connecting...');
            } else {
                this.logToUI("Connected to host, waiting for join approval...");
                this.updateStatus('Waiting...');
            }
        }
        this.pushUIUpdate();
    }

    /**
     * 호스트로부터 할당받은 피어 식별자를 설정하고 참가 요청 또는 등록 절차를 진행합니다.
     * @param msg 피어 식별자 정보가 담긴 메시지 객체
     */
    private handleAssignPeerId(msg: any) {
        if (!this.isHost) {
            this.logToUI(`ASSIGN_PEER_ID received: ${msg.peerId}`);
            const oldId = this.myId || 'default';
            this.myId = msg.peerId;
            const requestedName = (this.participantManager.pendingJoinRequest && this.participantManager.pendingJoinRequest.userName) 
                ? this.participantManager.pendingJoinRequest.userName 
                : (this.myName || this.myId);
            this.myName = requestedName;
            this.initialName = this.myName; 
            this.fileStorageManager.isStorageInitialized = false; 
            this.fileStorageManager.initializeStorage(); 
            
            // Webview 엔진 내부 피어 맵의 키 갱신
            this.hub.sendToEngine({ type: 'updatePeerId', oldId, newId: this.myId });
            
            if (this.participantManager.isAutoJoin && this.participantManager.pendingJoinRequest) {
                const req = this.participantManager.pendingJoinRequest;
                this.participantManager.pendingJoinRequest = null;
                this.participantManager.startJoinRequestWithAck({
                    name: this.myName,
                    peerId: this.myId,
                    previousPeerId: req.previousPeerId
                });
            } else if (!this.participantManager.isAutoJoin) {
                // 수동 연결 게스트: 호스트에게 참여자 등록 메시지 전송
                this.sendMessage('GUEST_JOIN', { name: this.myName }); 
            }
            
            this.pushUIUpdate();
        }
    }

    /**
     * 특정 파일의 편집 담당자 변경 정보를 반영합니다.
     * @param msg 파일 담당자 정보 메시지 객체
     */
    private async handleFileAssigneeUpdate(msg: any) {
        if (!this.isHost) {
            const file = this.fileStorageManager.sharedFiles.find(f => f.name === msg.fileName);
            if (file) {
                file.assigneeId = msg.assigneeId;
                file.assigneeName = msg.assigneeName;
                await this.fileStorageManager.updateReadonlyState(file);
                this.pushUIUpdate();
                this.cursorManager.refreshAllDecorations();
            }
        }
    }

    /**
     * 호스트로부터 최신 참여자 목록 및 방 정보를 동기화합니다.
     * @param msg 참여자 목록 및 방 이름 메시지 객체
     */
    private async handleUserListUpdate(msg: any) {
        this.participantManager.participants = msg.users;
        this.logToUI(`User list updated. ${Object.keys(this.participantManager.participants).length} users. myId=${this.myId}`);
        
        if (msg.roomName && (this.roomName === '' || this.roomName === 'Untitled Room')) {
            this.roomName = msg.roomName;
            if (!this.isHost) {
                this.fileStorageManager.isStorageInitialized = false;
                this.fileStorageManager.initializeStorage();
            }
        }
        if (!this.isHost && !this.fileStorageManager.isStorageInitialized && this.roomName) {
            this.fileStorageManager.initializeStorage();
        }
        
        if (!this.isHost) {
            const hasMyEntry = (this.myId && this.participantManager.participants[this.myId]) ||
                               (this.myName && Object.values(this.participantManager.participants).some(p => p.name === this.myName));

            if (this.myId) {
                const myData = this.participantManager.participants[this.myId] || this.participantManager.participants['default'];
                if (myData) {
                    this.myName = myData.name;
                }
            }

            // 호스트의 참가자 명단에 본인이 이미 등록되어 있다면, JOIN_RESPONSE 유실 여부와 무관하게 즉시 승인 완료 처리
            if (hasMyEntry && !this.isConnected) {
                this.logToUI("Confirmed presence in host's user list. Finalizing connection...");
                await this.participantManager.handleJoinResponse({ approved: true });
            } else if (!this.participantManager.isAutoJoin && !this.isConnected) {
                // 수동 연결 게스트의 경우
                this.isConnected = true;
                this.isSetupMode = false;
                this.logToUI("Manual connection complete");
                this.updateStatus('Connected');
            }

            // [패킷 유실 Fallback 1: 권한 자가 치유 (Self-Healing)]
            // SET_PERMISSION 패킷이 유실되었더라도 USER_LIST_UPDATE에 담긴 최신 권한으로 자동 동기화
            if (this.myId && this.participantManager.participants[this.myId]) {
                const myPerm = this.participantManager.participants[this.myId];
                this.logToUI(`Syncing permission from user list: GlobalCanEdit=${myPerm.globalCanEdit}`);
            }

            // [패킷 유실 Fallback 2: 공유 파일 누락 시 재요청 자가 치유]
            // 호스트가 공유 중인 파일 목록과 로컬에 저장된 파일 목록을 비교하여 누락된 파일이 있으면 재동기화 요청
            if (this.isConnected && Array.isArray(msg.sharedFileNames) && msg.sharedFileNames.length > 0) {
                const localFileNames = new Set(this.fileStorageManager.sharedFiles.map(f => f.name));
                const missingFiles = msg.sharedFileNames.filter((name: string) => !localFileNames.has(name));
                if (missingFiles.length > 0) {
                    this.logToUI(`Detected ${missingFiles.length} missing shared files (${missingFiles.join(', ')}). Requesting sync...`);
                    this.sendMessage('REQUEST_FILE_SYNC', { missingFiles });
                }
            }
        }
        
        await this.fileStorageManager.updateAllReadonlyStates();
        this.pushUIUpdate();
        this.cursorManager.refreshAllDecorations();
    }

    /** 호스트 커서 중계 패킷 폭증 방지를 위한 피어별 쓰로틀 타이머 맵 */
    private cursorBroadcastThrottleMap = new Map<string, NodeJS.Timeout>();

    private broadcastCursor(msg: any, senderId: string) {
        if (this.cursorBroadcastThrottleMap.has(senderId)) return;

        this.cursorBroadcastThrottleMap.set(senderId, setTimeout(() => {
            this.cursorBroadcastThrottleMap.delete(senderId);
        }, 50));

        // 보낸 피어 및 호스트를 제외한 다른 게스트들에게만 커서 중계 (에코 차단 및 대역폭 절약)
        Object.keys(this.participantManager.participants).forEach(pId => {
            if (pId !== 'host' && pId !== senderId) {
                this.sendMessageToPeer(pId, 'CURSOR_UPDATE', msg);
            }
        });
    }

    /**
     * 텍스트 문서 변경 이벤트 리스너를 설정합니다.
     */
    private setupTextListeners() {
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            this.updateActiveFileSharedContext();
            if (!editor) return;

            // 호스트 활성 탭 전환 시 화면 추적 동기화
            if (this.isHost && this.isFollowMeMode) {
                const file = this.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
                if (file && editor.visibleRanges.length > 0) {
                    const range = editor.visibleRanges[0];
                    this.sendMessage('FOLLOW_UPDATE', {
                        fileName: file.name,
                        startLine: range.start.line,
                        endLine: range.end.line
                    });
                }
            }

            if (this.isHost) {
                this.cursorManager.refreshAllDecorations();
                return;
            }
            const file = this.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
            if (file) {
                const canEdit = this.participantManager.canIEdit(file.name);
                await this.fileStorageManager.applyEditorReadonlyState(editor, !canEdit);
            }
            this.cursorManager.refreshAllDecorations();
        });

        // 호스트 스크롤 변경 시 화면 추적 동기화
        vscode.window.onDidChangeTextEditorVisibleRanges(e => {
            if (this.isHost && this.isFollowMeMode) {
                const file = this.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, e.textEditor.document.uri.fsPath));
                if (file && e.visibleRanges.length > 0) {
                    const range = e.visibleRanges[0];
                    this.sendMessage('FOLLOW_UPDATE', {
                        fileName: file.name,
                        startLine: range.start.line,
                        endLine: range.end.line
                    });
                }
            }
        });

        vscode.workspace.onDidChangeTextDocument(e => {
            const file = this.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, e.document.uri.fsPath));
            if (!file) return;

            // 원격 변경 적용 중이거나 닫히는 중인 문서라면 무시 (에코 폭주 100% 원천 차단)
            if (this.documentSyncManager.isApplyingRemote.get(file.name) || this.fileStorageManager.closingDocuments.has(e.document.uri.fsPath)) {
                return;
            }

            // 권한 체크
            if (!this.participantManager.canIEdit(file.name)) {
                this.logToUI(`Blocked unauthorized edit on ${file.name}`);
                return;
            }

            // 로컬 사용자의 변경 내용만 Yjs 문서에 적용
            this.documentSyncManager.applyLocalChanges(file.name, e.contentChanges);

            // 텍스트 변경 직후 내 커서 위치 즉시 전송 (입력으로 인한 커서 전진 동기화)
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && isPathEqual(activeEditor.document.uri.fsPath, file.path)) {
                this.cursorManager.sendCursorUpdate(activeEditor);
            }

            // 데코레이션 위치 재계산 및 자가 보정 트리거
            this.decorationManager.debouncedRecalculateDecorations(file.name, file.path);
            this.documentSyncManager.triggerSelfCorrection(file.name, file.path);
            this.fileStorageManager.scheduleDebouncedSave(file.path);
        });


        vscode.workspace.onWillSaveTextDocument(e => {
            if (!this.isHost && this.fileStorageManager.sharedFiles.some(f => isPathEqual(f.path, e.document.uri.fsPath))) {
                vscode.window.setStatusBarMessage("P2P: Changes synced to Host.", 3000);
            }
        });

        vscode.workspace.onDidCloseTextDocument(doc => {
            this.fileStorageManager.closingDocuments.add(doc.uri.fsPath);
            setTimeout(() => {
                this.fileStorageManager.closingDocuments.delete(doc.uri.fsPath);
            }, 500);
        });

        vscode.window.onDidChangeVisibleTextEditors(() => {
            this.cursorManager.refreshAllDecorations();
        });

        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('editor.fontSize')) {
                    this.fileStorageManager.sharedFiles.forEach(file => this.cursorManager.renderCursorsForFile(file));
                    this.decorationManager.refreshDecorationsInEditors();
                }
            })
        );
    }

    /**
     * 피어의 역할을 설정하고 초기화합니다.
     */
    public handleSetRole(msg: any) {
        this.isHost = msg.isHost;
        this.myId = this.isHost ? 'host' : '';
        this.roomName = msg.roomName !== undefined ? msg.roomName : (this.isHost ? 'Untitled Room' : '');
        this.myName = this.isHost ? 'Host' : '';
        this.initialName = this.myName;
        this.logToUI(`Role set: ${this.isHost ? 'Host' : 'Guest'} for room "${this.roomName}"`);
        this.updateStatus('Initializing...');

        if (this.isHost) { 
            this.isSetupMode = false;
            this.fileStorageManager.initializeStorage(); 
            this.participantManager.participants['host'] = { name: this.myName, globalCanEdit: true, filePermissions: {} }; 
            if (this.roomName && this.roomName !== 'Untitled Room') {
                this.hub.createHub(true, this.roomName, 'none'); 
                this.participantManager.inviteGuest(true);
            } else {
                this.hub.createHub(true, '', 'none');
            }
            this.participantManager.startPingCheck();
        } else { 
            this.isSetupMode = (this.roomName && this.roomName !== 'Untitled Room') ? false : true; 
            if (this.roomName && this.roomName !== 'Untitled Room') {
                this.hub.createHub(false, this.roomName, 'default'); 
            } else {
                // 수동 연결 모드: 시그널링 허브를 시작하지 않고 수동 SDP 대기 상태로 유지
                this.hub.createHub(false, '', 'default');
            }
            if (this.isSetupMode) this.updateStatus('Waiting...');
        }
        this.pushUIUpdate();
    }

    /**
     * 엔진을 통해 메시지를 전송합니다.
     */
    public sendMessage(type: string, data: any) { 
        if (this.isHost) {
            Object.keys(this.participantManager.participants).forEach(peerId => {
                if (peerId !== 'host') {
                    this.sendMessageToPeer(peerId, type, data);
                }
            });
        } else {
            this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } });
        }
    }

    /**
     * 특정 피어에게 메시지를 전송합니다.
     */
    public sendMessageToPeer(peerId: string, type: string, data: any) { 
        this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }, peerId); 
    }

    /**
     * Yjs 텍스트와 인덱스로부터 안전한 vscode.Position을 계산합니다.
     */
    public getPositionFromIndex(text: string, index: number): vscode.Position {
        let line = 0;
        let character = 0;
        const len = Math.min(index, text.length);
        for (let i = 0; i < len; i++) {
            const ch = text[i];
            if (ch === '\n') {
                line++;
                character = 0;
            } else {
                character++;
            }
        }
        return new vscode.Position(line, character);
    }

    /**
     * Yjs 텍스트와 vscode.Position(line, character)으로부터 정확한 인덱스를 계산합니다.
     */
    public getIndexFromPosition(text: string, position: vscode.Position): number {
        let currentLine = 0;
        let index = 0;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (i === position.line) {
                return index + Math.min(position.character, lines[i].length);
            }
            index += lines[i].length + 1; // +1 for '\n'
        }
        return Math.min(index, text.length);
    }


    /**
     * UI 웹뷰에 로그를 출력합니다.
     */
    public logToUI(message: string) {
        this.updateUI({ 
            type: 'log', 
            message,
            participants: this.participantManager.participants,
            roomName: this.roomName,
            files: this.fileStorageManager.sharedFiles,
            isConnected: this.isConnected
        });
    }

    /**
     * 현재 상태를 바탕으로 UI 업데이트를 실행합니다.
     */
    public pushUIUpdate() { 
        // 닉네임 동적 변경 실시간 갱신을 위해 채팅방 업데이트
        this.chatPanel?.updateHistory(this.chatHistory, this.myId, this.participantManager.participants);

        const visibleDecos = this.decorationManager.decorations.filter(d => {
            if (d.visibility === 'host') {
                return this.isHost || d.creatorId === this.myId;
            }
            return true;
        });

        this.updateUI({ 
            type: 'renderParticipants', 
            myName: this.myName, 
            myId: this.myId, 
            others: this.participantManager.participants, 
            roomName: this.roomName, 
            files: this.fileStorageManager.sharedFiles, 
            isSetupMode: this.isSetupMode, 
            isConnected: this.isConnected,
            isSignalingConnected: this.isSignalingConnected,
            connectionType: this.connectionType,
            pendingInvites: Array.from(this.participantManager.pendingInvites),
            joinRequests: this.participantManager.joinRequests,
            decorations: visibleDecos,
            showDecorations: this.decorationManager.showDecorations,
            cursorFilter: this.cursorManager.cursorFilter,
            unreadChatCount: this.unreadChatCount,
            isFollowMeMode: this.isFollowMeMode,
            isAutoApprove: this.participantManager.isAutoApprove,
            isReconnecting: this.participantManager.isReconnecting
        });
        this.updateActiveFileSharedContext();
    }

    /**
     * 현재 활성화된 에디터의 파일이 공유 중인지 여부를 VS Code context에 업데이트합니다.
     */
    public updateActiveFileSharedContext() {
        const editor = vscode.window.activeTextEditor;
        const isShared = editor ? this.fileStorageManager.sharedFiles.some(f => isPathEqual(f.path, editor.document.uri.fsPath)) : false;
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isActiveFileShared', isShared);
    }

    /**
     * UI 웹뷰에 상태를 업데이트합니다.
     */
    public updateStatus(status: string) {
        let finalStatus = status;
        if (status === 'Connected' && this.connectionType === 'TURN') {
            finalStatus = 'Connected (via TURN)';
        }
        this.logToUI(`Status: ${finalStatus}`);
        this.hub.sendToEngine({ type: 'status', status: finalStatus });
    }

    // 서브 매니저 기능 위임(Proxy) 메서드 모음

    /**
     * 현재 활성화된 에디터의 파일 또는 지정된 URI의 파일을 공유 시작합니다.
     * @param targetUri 공유할 대상 파일 URI (선택 사항).
     * @returns {Promise<void>}
     */
    public async shareActiveFile(targetUri?: vscode.Uri): Promise<void> {
        await this.fileStorageManager.shareActiveFile(targetUri);
    }

    /**
     * 현재 활성화된 에디터 파일의 공유를 중지합니다.
     * @returns {Promise<void>}
     */
    public async stopSharing(): Promise<void> {
        await this.fileStorageManager.stopSharing();
    }

    /**
     * 특정 파일명의 공유를 중지합니다 (호스트 전용).
     * @param fileName 공유를 중지할 파일 이름.
     * @returns {Promise<void>}
     */
    public async stopSharingByName(fileName: string): Promise<void> {
        await this.fileStorageManager.stopSharingByName(fileName);
    }

    /**
     * 새로운 게스트 초대를 위한 피어 세션을 생성합니다 (호스트 전용).
     * @param isSilent UI 전환 없이 조용히 생성할지 여부.
     * @returns {void}
     */
    public inviteGuest(isSilent: boolean = false): void {
        this.participantManager.inviteGuest(isSilent);
    }

    /**
     * 지정한 방 이름으로 호스트에게 방 참여 요청을 전송합니다 (게스트 전용).
     * @param roomName 참여할 방 이름.
     * @param userName 사용자 닉네임.
     * @returns {Promise<void>}
     */
    public async sendJoinRequest(roomName: string, userName: string): Promise<void> {
        await this.participantManager.sendJoinRequest(roomName, userName);
    }

    /**
     * 대기 중인 게스트의 방 참여 요청을 승인합니다 (호스트 전용).
     * @param peerId 승인할 피어 ID.
     * @returns {void}
     */
    public approveRequest(peerId: string): void {
        this.participantManager.approveRequest(peerId);
    }

    /**
     * 대기 중인 모든 게스트의 방 참여 요청을 일괄 승인합니다 (호스트 전용).
     * @returns {void}
     */
    public approveAllRequests(): void {
        this.participantManager.approveAllRequests();
    }

    /**
     * 자동 승인 모드를 활성화 또는 비활성화합니다 (호스트 전용).
     * @param enabled 자동 승인 활성화 여부.
     * @returns {void}
     */
    public setAutoApprove(enabled: boolean): void {
        this.participantManager.setAutoApprove(enabled);
    }

    /**
     * 자동 승인 모드 활성화 여부를 조회합니다.
     */
    public get isAutoApprove(): boolean {
        return this.participantManager.isAutoApprove;
    }

    /**
     * 특정 게스트의 방 참여 요청을 거절합니다 (호스트 전용).
     * @param peerId 거절할 피어 ID.
     * @returns {void}
     */
    public rejectRequest(peerId: string): void {
        this.participantManager.rejectRequest(peerId);
    }

    /**
     * 특정 게스트의 파일 접근 권한을 설정합니다 (호스트 전용).
     * @param peerId 대상 피어 ID.
     * @param permission 설정할 권한 객체.
     * @returns {void}
     */
    public setPeerPermission(peerId: string, permission: PeerPermission): void {
        this.participantManager.setPeerPermission(peerId, permission);
    }

    /**
     * 모든 게스트의 쓰기 권한을 일괄 해제하여 읽기 전용으로 전환합니다 (호스트 전용).
     * @returns {void}
     */
    public revokeAllWritePermissions(): void {
        this.participantManager.revokeAllWritePermissions();
    }

    /**
     * 특정 파일의 전담 편집 담당자를 지정합니다 (호스트 전용).
     * @param fileName 대상 파일 이름.
     * @param assigneeId 담당자 피어 ID.
     * @returns {void}
     */
    public setFileAssignee(fileName: string, assigneeId: string): void {
        this.participantManager.setFileAssignee(fileName, assigneeId);
    }

    /**
     * 로컬 사용자의 닉네임을 변경하고 모든 피어에게 알립니다.
     * @param newName 새로 설정할 닉네임.
     * @returns {void}
     */
    public changeMyName(newName: string): void {
        this.participantManager.changeMyName(newName);
    }

    /**
     * 특정 피어를 방에서 강제 퇴장시킵니다 (호스트 전용).
     * @param peerId 퇴장시킬 피어 ID.
     * @returns {Promise<void>}
     */
    public async kickPeer(peerId: string): Promise<void> {
        await this.participantManager.kickPeer(peerId);
    }

    /**
     * 피어 연결 단절 이벤트를 처리합니다.
     * @param peerId 연결이 끊어진 피어 ID.
     * @returns {void}
     */
    public handlePeerDisconnect(peerId: string): void {
        this.participantManager.handlePeerDisconnect(peerId);
    }

    /**
     * 특정 데코레이션을 삭제합니다.
     * @param id 삭제할 데코레이션 고유 ID.
     * @returns {void}
     */
    public deleteDecoration(id: string): void {
        this.decorationManager.deleteDecoration(id);
    }

    /**
     * 특정 데코레이션의 에디터 라인 및 문자 위치로 이동합니다.
     * @param fileName 파일 이름.
     * @param line 라인 번호.
     * @param char 문자 컬럼 번호.
     * @returns {void}
     */
    public jumpToDecoration(fileName: string, line: number, char: number): void {
        this.decorationManager.jumpToDecoration(fileName, line, char);
    }

    /**
     * 에디터에 표시할 커서 대상을 필터링합니다.
     * @param filter 커서 필터 모드 ('host' | 'editable' | 'all').
     * @returns {void}
     */
    public setCursorFilter(filter: 'host' | 'editable' | 'all'): void {
        this.cursorManager.setCursorFilter(filter);
    }

    /**
     * 에디터 데코레이션 표시 여부를 설정합니다.
     * @param show 데코레이션 표시 여부.
     * @returns {void}
     */
    public setShowDecorations(show: boolean): void {
        this.decorationManager.setShowDecorations(show);
    }

    /**
     * 에디터 선택 영역에 대한 새 데코레이션 추가 플로우를 실행합니다.
     * @returns {Promise<void>}
     */
    public async addDecorationFlow(): Promise<void> {
        await this.decorationManager.addDecorationFlow();
    }

    /**
     * 방 나가기(퇴장) 플로우를 처리합니다.
     * 호스트는 공유 파일 중지 검사 및 방 종료 통지를 수행하고, 게스트는 로컬 임시 파일을 완전히 삭제하고 세션을 정리합니다.
     * @returns {Promise<void>}
     */
    public async leaveRoomFlow(): Promise<void> {
        if (this.isHost) {
            // 1. 호스트인 경우 공유 중인 파일이 있는지 확인
            if (this.fileStorageManager.sharedFiles.length > 0) {
                vscode.window.showErrorMessage("공유 중인 파일을 모두 중지해주세요.");
                return;
            }
            // 2. 파일이 없으면 최종 확인 창 표시
            const answer = await vscode.window.showWarningMessage(
                "퇴장을 하시면 연결된 모든 guest들의 연결이 끊어집니다.",
                { modal: true },
                "Yes"
            );
            if (answer === "Yes") {
                // 게스트들에게 방 종료 메시지를 명시적으로 브로드캐스트하여 재연결 루프에 빠지지 않도록 함
                this.sendMessage('ROOM_CLOSED', { reason: '호스트가 방을 종료했습니다.' });
                await new Promise(r => setTimeout(r, 100)); // 메시지 전송 버퍼 여유 확보

                await this.sessionRecoveryManager.clearSession();
                this.reset();
                this.hub.dispose();
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
            }
        } else {
            // 3. 게스트인 경우 퇴장 확인 창 표시
            const answer = await vscode.window.showWarningMessage(
                "방에서 나가시겠습니까? 공유 중인 로컬 파일이 닫히고 연결이 종료됩니다.",
                { modal: true },
                "Yes"
            );
            if (answer !== "Yes") return;

            // 호스트에게 퇴장 알림 전송
            this.sendMessage('GUEST_LEAVE', { userId: this.myId });

            // 4. 재연결 타이머 및 유예 상태 즉시 종료
            this.participantManager.stopGuestReconnectGracePeriod();

            // 5. 로컬 사본 파일들을 완전히 제거 (에디터 닫기 및 디스크 임시 파일/폴더 전체 삭제)
            await this.fileStorageManager.clearLocalStorage();

            // 6. 연결 초기화 및 세션 영구 삭제
            await this.sessionRecoveryManager.clearSession();
            this.reset();
            this.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    }

    /**
     * 게스트가 방을 퇴장할 때 호스트가 수신하여 해당 게스트의 리소스(커서, 데코레이션, 참가자 목록)를 정리합니다.
     * @param msg 게스트 퇴장 메시지.
     * @param peerId 퇴장한 피어 ID.
     * @returns {void}
     */
    private handleGuestLeave(msg: any, peerId: string): void {
        if (this.isHost) {
            const actualPeerId = msg.userId || peerId;
            this.logToUI(`GUEST_LEAVE received from: ${actualPeerId}`);

            // 1. 이 게스트가 생성한 데코레이션 완전히 삭제 및 전송
            this.decorationManager.decorations = this.decorationManager.decorations.filter(d => d.creatorId !== actualPeerId);
            this.decorationManager.refreshDecorationsInEditors();
            this.decorationManager.broadcastDecorations();

            // 2. 해당 피어 즉시 영구 연결 정리 (커서 정리, 참가자 리스트 제거, 파일 잠금 해제, 유저 리스트 브로드캐스트)
            this.participantManager.removePeerPermanently(actualPeerId);
        }
    }

    /**
     * 실시간 P2P 채팅 메시지를 생성하고 피어들에게 브로드캐스트합니다.
     * @param text 전송할 채팅 텍스트.
     * @returns {void}
     */
    public sendChatMessage(text: string): void {
        const cleanText = text.trim();
        if (!cleanText) return;

        const chatMessage: ChatMessage = {
            id: this.myId + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
            senderId: this.myId,
            senderName: this.myName || this.myId,
            text: cleanText,
            timestamp: Date.now()
        };

        this.chatHistory.push(chatMessage);
        
        // 상대방에게 브로드캐스트
        this.sendMessage('CHAT_MESSAGE', { chatMessage });
        
        // 내 로컬 채팅창 갱신
        this.chatPanel?.updateHistory(this.chatHistory, this.myId, this.participantManager.participants);
        this.pushUIUpdate();
    }

    /**
     * 호스트가 화면 동기화(팔로우 모드)를 켜거나 끄고 현재 뷰포트 위치를 즉시 동기화합니다.
     * @param enabled 활성화 여부.
     * @returns {void}
     */
    public setFollowMeMode(enabled: boolean): void {
        this.isFollowMeMode = enabled;
        this.logToUI(`Follow Me Mode: ${enabled ? 'Enabled' : 'Disabled'}`);
        
        // 켜지는 시점에 현재 에디터 위치 즉시 브로드캐스트
        if (enabled && this.isHost) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const file = this.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
                if (file && editor.visibleRanges.length > 0) {
                    const range = editor.visibleRanges[0];
                    this.sendMessage('FOLLOW_UPDATE', {
                        fileName: file.name,
                        startLine: range.start.line,
                        endLine: range.end.line
                    });
                }
            }
        }
        this.pushUIUpdate();
    }

    /**
     * 게스트가 호스트의 화면 위치 정보를 수신하여 해당 파일을 열고 동일한 스크롤 라인 위치로 이동합니다.
     * @param fileName 대상 파일 이름.
     * @param startLine 호스트 화면의 시작 라인 번호.
     * @param endLine 호스트 화면의 끝 라인 번호.
     * @returns {Promise<void>}
     */
    public async handleFollowUpdate(fileName: string, startLine: number, endLine: number): Promise<void> {
        try {
            const file = this.fileStorageManager.sharedFiles.find(f => f.name === fileName);
            if (!file) return;

            // 1. 문서 열기
            const doc = await vscode.workspace.openTextDocument(file.path);
            
            // 2. 현재 보이는 에디터 중에서 해당 문서를 보여주는 에디터 탐색
            let targetEditor = vscode.window.visibleTextEditors.find(e => isPathEqual(e.document.uri.fsPath, file.path));
            
            if (!targetEditor) {
                // 열려있지 않다면 에디터 활성화 (preview: false로 새 탭 고정)
                targetEditor = await vscode.window.showTextDocument(doc, { 
                    preview: false, 
                    viewColumn: vscode.ViewColumn.One 
                });
            }

            // 3. 스크롤 동기화
            if (targetEditor) {
                const startPos = new vscode.Position(startLine, 0);
                const endPos = new vscode.Position(endLine, 0);
                const range = new vscode.Range(startPos, endPos);
                // 화면 상단 기준 스크롤 정렬
                targetEditor.revealRange(range, vscode.TextEditorRevealType.AtTop);
            }
        } catch (e) {
            console.error("Failed to apply follow update:", e);
        }
    }

    /**
     * VS Code 세션 단위 기능을 활용하여 에디터를 읽기 전용 또는 쓰기 가능으로 전환합니다.
     * @param fileName 대상 파일 이름.
     * @param readonly 읽기 전용 모드 적용 여부.
     * @param targetPath 파일 절대 경로 (선택 사항).
     * @returns {Promise<void>}
     */
    public async setEditorReadonly(fileName: string, readonly: boolean, targetPath?: string): Promise<void> {
        const file = this.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        const filePath = targetPath || file?.path;
        if (!filePath) return;

        const editor = vscode.window.visibleTextEditors.find(e =>
            isPathEqual(e.document.uri.fsPath, filePath)
        );
        if (!editor) return;

        try {
            // 대상 에디터를 일시적으로 활성화해야 명령이 적용됨
            await vscode.window.showTextDocument(editor.document, {
                viewColumn: editor.viewColumn,
                preserveFocus: true,  // 포커스는 현재 위치 유지
                preview: false,
            });

            if (readonly) {
                await vscode.commands.executeCommand(
                    'workbench.action.files.setActiveEditorReadonlyInSession'
                );
                vscode.window.setStatusBarMessage(`🔒 다른 사용자가 ${fileName}을(를) 편집 중...`, 60000);
            } else {
                await vscode.commands.executeCommand(
                    'workbench.action.files.resetActiveEditorReadonlyInSession'
                );
                vscode.window.setStatusBarMessage(`✏️ ${fileName} 편집 가능`, 2000);
            }
        } catch (e) {
            // 명령이 지원되지 않는 VS Code 환경 예외 무시
        }
    }

    /**
     * SyncEngine의 모든 서브 매니저와 타이머, 연결 상태 변수를 초기화합니다.
     * @param skipUIUpdate UI 갱신 생략 여부 (기본값: false).
     * @returns {void}
     */
    public reset(skipUIUpdate = false): void {
        this.fileStorageManager.reset();
        this.participantManager.reset();
        this.cursorManager.reset();
        this.decorationManager.reset();
        this.documentSyncManager.reset();

        // 타이핑 락 상태 초기화 - 모든 에디터의 readonly 무조건 해제
        this.localTypingUnlockTimers.forEach(t => clearTimeout(t));
        this.localTypingUnlockTimers.clear();
        this.remoteTypingLocked.forEach((locked, fileName) => {
            this.setEditorReadonly(fileName, false);
        });
        this.remoteTypingLocked.clear();

        // 열려있는 모든 visible 에디터의 readonly 상태 리셋
        vscode.window.visibleTextEditors.forEach(async editor => {
            try {
                await vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
            } catch (e) {}
        });
        this.remoteTypingLocked.clear();

        // 채팅 기록 리셋 및 팝업창 닫기
        this.chatHistory = [];
        if (this.chatPanel) {
            this.chatPanel.dispose();
            this.chatPanel = undefined;
        }

        this.isHost = false; 
        this.isConnected = false; 
        this.isSignalingConnected = false;
        this.connectionType = 'Direct';
        this.roomName = ''; 
        this.myName = ''; 
        this.myId = ''; 
        this.initialName = ''; 
        this.isSetupMode = false; 
        this.isFollowMeMode = false; 

        if (!skipUIUpdate) {
            this.pushUIUpdate();
        }
    }
}
