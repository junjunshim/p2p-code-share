/**
 * @file ParticipantManager.ts
 * @description 참여자 목록 관리, 승인/거절, 권한 부여, 이름 변경, 강퇴 등의 로직을 처리합니다.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as Y from 'yjs';
import { PeerPermission } from '../../types';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual, normalizeEOL } from '../../utils/helpers';

export class ParticipantManager {
    public participants: { [key: string]: PeerPermission } = {};
    public joinRequests: any[] = [];
    public pendingInvites = new Set<string>();
    public isAutoJoin = false;
    public isAutoApprove = false;
    public pendingJoinRequest: { roomName: string, userName: string, previousPeerId?: string } | null = null;
    private joinTimeout?: NodeJS.Timeout;

    // 게스트 재연결 유예 기간(Grace Period) 관련 속성
    public isReconnecting = false;
    private reconnectRetryTimer?: NodeJS.Timeout;
    private reconnectDeadlineTimer?: NodeJS.Timeout;

    // 실시간 연결 상태 모니터링 (Ping-Pong) 및 재연결 대기 관리
    private pingTimer?: NodeJS.Timeout;
    public lastPongTimes = new Map<string, number>();
    public reconnectStartTimes = new Map<string, number>();

    constructor(private engine: SyncEngine) {}

    /**
     * 특정 피어가 특정 파일에 대한 편집 권한이 있는지 확인합니다.
     */
    public canPeerEdit(peerId: string, fileName: string): boolean {
        if (peerId === 'host') return true;
        const peerData = this.participants[peerId];
        if (!peerData) return false;

        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (file && file.assigneeId) {
            return file.assigneeId === peerId;
        }

        if (peerData.globalCanEdit) return true;
        return peerData.filePermissions[fileName] === true;
    }

    /**
     * 현재 사용자가 특정 파일에 대한 편집 권한이 있는지 확인합니다.
     * @param fileName 확인 대상 파일 이름.
     */
    public canIEdit(fileName: string): boolean {
        // 호스트는 항상 가능
        if (this.engine.isHost) return true;
        
        // 내 ID 또는 기본 ID로 데이터 찾기
        const myData = this.participants[this.engine.myId] || this.participants['default'];
        
        if (!myData) return false; // 기본 권한 없음
        
        // 파일 담당자 지정 체크
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (file && file.assigneeId) {
            // 담당자가 지정되어 있으면, 내 ID가 담당자 ID여야만 편집 가능
            return file.assigneeId === this.engine.myId;
        }
        
        // 1. 전체 권한이 있으면 통과
        if (myData.globalCanEdit) return true;
        
        // 2. 파일별 권한 확인
        return myData.filePermissions[fileName] === true;
    }

    /**
     * 방 참여 요청을 보냅니다. (게스트용)
     * @param roomName 방 이름.
     * @param userName 사용자 이름.
     * @param previousPeerId 재연결 시 기존 피어 ID (세션 복원용).
     */
    public async sendJoinRequest(roomName: string, userName: string, previousPeerId?: string) {
        this.engine.roomName = roomName;
        this.engine.myName = userName || '';
        if (previousPeerId) {
            this.engine.myId = previousPeerId;
        }
        this.engine.isSetupMode = false;
        this.isAutoJoin = true; // [추가] 자동 참여 모드 설정
        this.pendingJoinRequest = { roomName, userName, previousPeerId }; // 요청 큐에 저장
        // 게스트가 새로운 방에 입장할 때 기존에 남아있던 타 방 임시 디렉터리들을 선제적으로 정리
        this.engine.fileStorageManager.cleanOldRoomStorages(roomName);
        this.engine.pushUIUpdate();

        // 20초 내에 연결 단계가 완료되지 않으면 에러 및 리셋 처리 (재연결 유예 중인 경우는 30초 유예 타이머가 별도 관리하므로 제외)
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
        }
        if (!this.isReconnecting) {
            this.joinTimeout = setTimeout(() => {
                if (!this.engine.isConnected && this.isAutoJoin && !this.isReconnecting) {
                    vscode.window.showErrorMessage("호스트와의 연결 시도 시간이 초과되었습니다. 방 이름이 올바른지 혹은 호스트가 온라인인지 확인해주세요.");
                    this.engine.reset();
                    this.engine.hub.dispose();
                }
            }, 20000);
        }

        // 허브 생성 (게스트 모드)
        this.engine.hub.createHub(false, roomName, 'default');
    }

    /**
     * 연결 요청 제한시간을 정리합니다.
     */
    public clearJoinTimeout() {
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
            this.joinTimeout = undefined;
        }
    }

    /**
     * 방 참여 요청을 승인합니다. (호스트용)
     * @param peerId 승인할 피어 ID.
     */
    public approveRequest(peerId: string) {
        if (!this.engine.isHost) return;
        
        // [수정] 승인 시 게스트를 참가자로 추가
        const request = this.joinRequests.find(req => req.peerId === peerId);
        if (request) {
            this.handleGuestJoin({ name: request.name, previousPeerId: request.previousPeerId }, peerId);
        }
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        
        // 승인 메시지 전송
        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
        
        this.engine.pushUIUpdate();
    }

    /**
     * 모든 대기 중인 방 참여 요청을 일괄 승인합니다. (호스트용)
     */
    public approveAllRequests() {
        if (!this.engine.isHost || this.joinRequests.length === 0) return;

        const requestsToApprove = [...this.joinRequests];
        this.joinRequests = [];

        for (const req of requestsToApprove) {
            this.handleGuestJoin({ name: req.name, previousPeerId: req.previousPeerId }, req.peerId);
            this.engine.sendMessageToPeer(req.peerId, 'JOIN_RESPONSE', { approved: true });
        }

        this.engine.pushUIUpdate();
    }

    /**
     * 자동 승인 모드를 설정합니다. (호스트용)
     * 활성화 시 대기 중인 모든 요청을 즉시 일괄 승인합니다.
     */
    public setAutoApprove(enabled: boolean) {
        if (!this.engine.isHost) return;
        this.isAutoApprove = enabled;
        if (enabled) {
            this.approveAllRequests();
        } else {
            this.engine.pushUIUpdate();
        }
    }

    /**
     * 방 참여 요청을 거절합니다. (호스트용)
     * @param peerId 거절할 피어 ID.
     */
    public rejectRequest(peerId: string) {
        if (!this.engine.isHost) return;
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        
        // 거절 메시지 전송
        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: false, reason: '호스트가 요청을 거절했습니다.' });
        
        // WebRTC 피어 연결 해제
        this.engine.hub.disconnectPeer(peerId);
        
        this.engine.pushUIUpdate();
    }

    /**
     * 호스트가 게스트의 참여를 처리합니다.
     */
    public handleGuestJoin(msg: any, peerId: string) {
        if (this.engine.isHost) { 
            const guestName = msg.name || peerId;
            const previousPeerId = msg.previousPeerId;

            // 1. 이전 피어 ID 탐색 (전송받은 previousPeerId 우선, 없으면 동일한 이름을 가진 이전 참가자 검색)
            let oldPeerId = (previousPeerId && previousPeerId !== peerId && this.participants[previousPeerId]) ? previousPeerId : undefined;
            if (!oldPeerId) {
                oldPeerId = Object.keys(this.participants).find(id => id !== 'host' && id !== peerId && this.participants[id].name === guestName);
            }

            // 2. 세션 복원 시 기존에 부여되어 있던 참가자 권한 또는 이전 피어 ID의 권한 승계
            const existingPermission = this.participants[peerId] || (oldPeerId ? this.participants[oldPeerId] : undefined);
            this.participants[peerId] = existingPermission 
                ? { ...existingPermission, name: guestName, connectionStatus: 'connected' }
                : { name: guestName, globalCanEdit: false, filePermissions: {}, connectionStatus: 'connected' };
            this.lastPongTimes.set(peerId, Date.now());
            this.reconnectStartTimes.delete(peerId);

            // 3. 중복 생성 방지를 위해 이전 피어 ID 정보 정리
            if (oldPeerId && oldPeerId !== peerId) {
                delete this.participants[oldPeerId];
                this.lastPongTimes.delete(oldPeerId);
                this.reconnectStartTimes.delete(oldPeerId);
                this.engine.cursorManager.clearPeerCursor(oldPeerId);

                // 공유 파일의 담당자 ID를 새 피어 ID로 갱신
                this.engine.fileStorageManager.sharedFiles.forEach(f => {
                    if (f.assigneeId === oldPeerId) {
                        f.assigneeId = peerId;
                        f.assigneeName = guestName;
                        this.engine.sendMessage('FILE_ASSIGNEE_UPDATE', {
                            fileName: f.name,
                            assigneeId: peerId,
                            assigneeName: guestName
                        });
                    }
                });

                // 데코레이션의 작성자 ID 갱신
                this.engine.decorationManager.decorations.forEach(d => {
                    if (d.creatorId === oldPeerId) {
                        d.creatorId = peerId;
                    }
                });
            }

            this.broadcastUserList(); 
            
            // [추가] 새로 들어온 게스트에게 현재 공유 중인 모든 파일 스냅샷 및 Yjs 상태 전송
            this.engine.fileStorageManager.sharedFiles.forEach(f => {
                const ydoc = this.engine.documentSyncManager.yDocs.get(f.name);
                const ytext = this.engine.documentSyncManager.yTexts.get(f.name);
                const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, f.path));
                const rawContent = ytext ? ytext.toString() : (doc ? doc.getText() : fs.readFileSync(f.path, 'utf8'));
                const content = normalizeEOL(rawContent);
                const yjsState = ydoc ? Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64') : undefined;

                // 해당 피어에게만 초기 스냅샷 전송 (파일 목록 생성 및 에디터 열기 유도)
                this.engine.sendMessageToPeer(peerId, 'INIT_SNAPSHOT', { 
                    fileName: f.name, 
                    content,
                    yjsState,
                    assigneeId: f.assigneeId,
                    assigneeName: f.assigneeName
                });
            });

            // 현재 데코레이션 목록 전송 (비공개 처리 적용)
            const peerDecos = this.engine.decorationManager.decorations.filter(d => d.visibility !== 'host' || d.creatorId === peerId);
            this.engine.sendMessageToPeer(peerId, 'SYNC_DECORATIONS', { decorations: peerDecos });
        }
    }

    /**
     * 호스트가 특정 피어의 권한을 설정합니다.
     * @param peerId 대상 피어 ID.
     * @param permission 설정할 권한 객체.
     */
    public setPeerPermission(peerId: string, permission: PeerPermission) {
        if (!this.engine.isHost) return;

        // participants 목록 업데이트
        this.participants[peerId] = permission;
        
        // 해당 피어에게 SET_PERMISSION 메시지 전송
        this.engine.sendMessageToPeer(peerId, 'SET_PERMISSION', { permission });
        
        // 전체 사용자 목록 갱신 브로드캐스트
        this.broadcastUserList();
        this.engine.logToUI(`Permission set for ${peerId}: Global=${permission.globalCanEdit}`);
        this.engine.cursorManager.refreshAllDecorations();
    }

    /**
     * 호스트가 모든 게스트의 쓰기 권한을 일괄 해제(읽기 전용 전환)합니다.
     */
    public revokeAllWritePermissions() {
        if (!this.engine.isHost) return;

        let hasGuests = false;

        // 1. 모든 게스트의 권한을 읽기 전용으로 초기화
        Object.keys(this.participants).forEach(peerId => {
            if (peerId !== 'host') {
                hasGuests = true;
                this.participants[peerId] = {
                    ...this.participants[peerId],
                    globalCanEdit: false,
                    filePermissions: {}
                };
                this.engine.sendMessageToPeer(peerId, 'SET_PERMISSION', {
                    permission: this.participants[peerId]
                });
            }
        });

        // 2. 게스트에게 할당된 파일 담당자도 초기화
        this.engine.fileStorageManager.sharedFiles.forEach(file => {
            if (file.assigneeId && file.assigneeId !== 'host') {
                file.assigneeId = undefined;
                file.assigneeName = undefined;
                this.engine.sendMessage('FILE_ASSIGNEE_UPDATE', {
                    fileName: file.name,
                    assigneeId: undefined,
                    assigneeName: undefined
                });
            }
        });

        if (hasGuests) {
            this.broadcastUserList();
            this.engine.pushUIUpdate();
            this.engine.cursorManager.refreshAllDecorations();
            vscode.window.showInformationMessage("모든 학생의 쓰기 권한이 해제(읽기 전용 전환)되었습니다.");
        }
    }

    /**
     * 특정 파일의 담당자를 지정하고 브로드캐스트합니다.
     * @param fileName 대상 파일 이름.
     * @param assigneeId 담당자 피어 ID.
     */
    public setFileAssignee(fileName: string, assigneeId: string) {
        if (!this.engine.isHost) return;

        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (!file) return;

        file.assigneeId = assigneeId || undefined;
        if (assigneeId === 'host') {
            file.assigneeName = this.engine.myName;
        } else if (assigneeId && this.participants[assigneeId]) {
            file.assigneeName = this.participants[assigneeId].name;
        } else {
            file.assigneeName = undefined;
        }

        // 전체 게스트들에게 파일 담당자 변경 브로드캐스트
        this.engine.sendMessage('FILE_ASSIGNEE_UPDATE', { 
            fileName, 
            assigneeId: file.assigneeId, 
            assigneeName: file.assigneeName 
        });

        this.engine.logToUI(`File owner for ${fileName} updated: ${file.assigneeName || 'Unassigned'}`);
        
        // 내 에디터 및 UI 업데이트
        this.engine.pushUIUpdate();
        this.engine.cursorManager.refreshAllDecorations();
    }

    /**
     * 게스트를 초대합니다.
     * @param isSilent true일 경우 UI를 초대 화면으로 전환하지 않고 배경에서 생성합니다.
     */
    public inviteGuest(isSilent: boolean = false) {
        if (!this.engine.isHost) return;
        // 새로운 피어 ID 생성
        const newPeerId = 'guest_' + Date.now();
        this.pendingInvites.add(newPeerId);
        
        // 수동 연결(+ 버튼 클릭) 시에만 설정 모드로 전환
        if (!isSilent) this.engine.isSetupMode = true; 
        
        // 허브에 새로운 피어 추가 (방 이름과 새 피어 ID 전달)
        this.engine.hub.createHub(true, this.engine.roomName, newPeerId); 
        this.engine.pushUIUpdate();
    }

    /**
     * 사용자 이름을 변경합니다.
     * @param newName 새로운 사용자 이름.
     */
    public changeMyName(newName: string) {
        const trimmedNewName = newName.trim();
        if (!trimmedNewName) return;

        const isDuplicate = Object.entries(this.participants).some(([id, data]) => id !== this.engine.myId && data.name === trimmedNewName);
        
        if (isDuplicate) {
            vscode.window.showWarningMessage(`"${trimmedNewName}" 이름은 이미 사용 중입니다. 다른 이름을 선택해주세요.`);
            this.engine.pushUIUpdate(); // UI 입력을 원래 이름으로 복구하기 위해 강제 업데이트
            return;
        }

        if (this.engine.isHost) { 
            // 호스트 이름 변경 및 명단 브로드캐스트
            this.engine.myName = trimmedNewName; 
            this.participants['host'] = { ...this.participants['host'], name: trimmedNewName }; 
            this.broadcastUserList(); 

            // 호스트가 남긴 데코레이션의 작성자 이름 변경 및 전송
            this.engine.decorationManager.decorations.forEach(d => {
                if (d.creatorId === 'host') d.creatorName = trimmedNewName;
            });
            this.engine.decorationManager.broadcastDecorations();
        } else { 
            // 게스트 이름 변경 및 서버에 알림
            this.engine.myName = trimmedNewName;
            this.engine.sendMessage('GUEST_RENAME', { newName: trimmedNewName }); 

            // 로컬 데코레이션에 즉시 반영
            this.engine.decorationManager.decorations.forEach(d => {
                if (d.creatorId === this.engine.myId) d.creatorName = trimmedNewName;
            });
            this.engine.decorationManager.refreshDecorationsInEditors();
            this.engine.pushUIUpdate();
        }

        // 이름 변경 즉시 커서 정보도 최신 이름으로 브로드캐스트
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.engine.cursorManager.sendCursorUpdate(editor);
        }
        this.engine.pushUIUpdate();
    }

    /**
     * 참가자 명단을 모든 피어에게 브로드캐스트합니다.
     */
    public broadcastUserList() {
        if (this.engine.isHost) {
            // 'default' ID를 제외한 참가자 목록 생성
            const filteredParticipants = { ...this.participants };
            delete filteredParticipants['default'];
            // 사용자 목록 및 방 이름 업데이트 메시지 전송
            this.engine.sendMessage('USER_LIST_UPDATE', { users: filteredParticipants, roomName: this.engine.roomName });
        }
        this.engine.pushUIUpdate();
    }

    /**
     * 특정 피어를 강제로 퇴장시킵니다. (호스트 전용)
     * @param peerId 퇴장시킬 피어 ID.
     */
    public kickPeer(peerId: string) {
        if (!this.engine.isHost) return;

        // 퇴장 메시지 전송
        this.engine.sendMessageToPeer(peerId, 'KICKED', { reason: '호스트에 의해 방에서 퇴장되었습니다.' });

        // 엔진 레벨에서 WebRTC 피어 연결 해제
        this.engine.hub.disconnectPeer(peerId);

        // 로컬에서 즉시 연결 해제 처리
        this.handlePeerDisconnect(peerId);
    }

    /**
     * 피어 연결 해제 이벤트를 처리합니다.
     * @param peerId 연결이 해제된 피어 ID.
     */
    public handlePeerDisconnect(peerId: string) {
        if (!this.engine.isHost) {
            // 게스트일 경우: 호스트와의 일시적 단절(호스트 창 전환 등)을 감지하고 30초 재연결 유예 모드로 진입
            if (peerId === 'default' || peerId === 'all') { 
                if (this.engine.isConnected && !this.isReconnecting) {
                    this.startGuestReconnectGracePeriod();
                } else if (!this.isReconnecting) {
                    this.engine.reset(); 
                }
            }
        } else {
            // 호스트일 경우 참가자 제거 및 UI 알림
            const isParticipant = !!this.participants[peerId];
            const isJoinRequest = this.joinRequests.some(req => req.peerId === peerId);

            if (isParticipant) {
                const disconnectedName = this.participants[peerId]?.name || '누군가';
                vscode.window.setStatusBarMessage(`P2P: ${disconnectedName}님이 방을 나갔습니다.`, 3000);
                
                // 퇴장 시스템 메시지 기록
                const systemMsg = {
                    id: 'sys-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                    senderId: 'system',
                    senderName: 'System',
                    text: `${disconnectedName}(퇴장)`,
                    timestamp: Date.now(),
                    isSystem: true
                };
                this.engine.chatHistory.push(systemMsg);
                this.engine.sendMessage('CHAT_MESSAGE', { chatMessage: systemMsg });
                this.engine.chatPanel?.updateHistory(this.engine.chatHistory, this.engine.myId, this.participants);

                delete this.participants[peerId];
                this.lastPongTimes.delete(peerId);
                this.reconnectStartTimes.delete(peerId);
                
                // 해당 피어의 데코레이션 및 색상 정리
                this.engine.cursorManager.clearPeerCursor(peerId);
                this.broadcastUserList();
            }

            if (isJoinRequest) {
                this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
                this.engine.pushUIUpdate();
            }
        }
    }

    /**
     * [추가] 방 참여 요청 처리 (호스트 전용)
     */
    public handleJoinRequest(msg: any, peerId: string) {
        if (this.engine.isHost) {
            const guestName = msg.name || peerId;
            const previousPeerId = msg.previousPeerId;
            const existingParticipant = this.participants[peerId] || 
                (previousPeerId && this.participants[previousPeerId]) || 
                Object.values(this.participants).find(p => p.name === guestName);

            // 호스트 창 전환 후 재접속한 기존 게스트이거나 자동 승인 모드인 경우 즉시 승인
            if (existingParticipant || this.isAutoApprove) {
                this.handleGuestJoin({ name: guestName, previousPeerId }, peerId);
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
                if (existingParticipant) {
                    vscode.window.showInformationMessage(`재연결 승인: ${guestName} (${peerId})`);
                } else {
                    vscode.window.showInformationMessage(`방 참여 자동 승인: ${guestName} (${peerId})`);
                }
                this.engine.pushUIUpdate();
            } else {
                this.joinRequests.push({
                    peerId,
                    name: guestName,
                    previousPeerId,
                    timestamp: Date.now()
                });
                vscode.window.showInformationMessage(`방 참여 요청: ${guestName} (${peerId})`);
                this.engine.pushUIUpdate();
            }
        }
    }

    /**
     * [추가] 방 참여 응답 처리 (게스트 전용)
     */
    public async handleJoinResponse(msg: any) {
        if (!this.engine.isHost) {
            if (msg.approved) {
                this.stopGuestReconnectGracePeriod();
                this.engine.isConnected = true;
                this.isAutoJoin = false;
                this.engine.updateStatus('Connected');
                this.engine.pushUIUpdate();
                vscode.window.showInformationMessage("방 참여가 승인되었습니다!");
                // 에디터 락 해제 및 최신 권한 적용
                await this.engine.fileStorageManager.updateAllReadonlyStates();
            } else {
                this.stopGuestReconnectGracePeriod();
                vscode.window.showErrorMessage(`방 참여가 거절되었습니다: ${msg.reason || '사유 없음'}`);
                this.engine.reset();
                this.engine.hub.dispose();
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
            }
        }
    }

    /**
     * [추가] 강제 퇴장 처리 (게스트 전용)
     */
    public async handleKicked(msg: any) {
        if (!this.engine.isHost) {
            this.stopGuestReconnectGracePeriod();
            vscode.window.showErrorMessage(`퇴장되었습니다: ${msg.reason}`);

            // 로컬 사본 파일들을 완전히 제거 (에디터 닫기 및 디스크 파일 삭제)
            const filesToClean = [...this.engine.fileStorageManager.sharedFiles];
            for (const file of filesToClean) {
                await this.engine.fileStorageManager.handleRemoteStop(file.name);
            }

            await this.engine.sessionRecoveryManager.clearSession();
            this.engine.reset();
            this.engine.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    }

    /**
     * [추가] 호스트의 방 종료(Leave) 처리 (게스트 전용)
     */
    public async handleRoomClosed(msg: any) {
        if (!this.engine.isHost) {
            this.stopGuestReconnectGracePeriod();
            vscode.window.showInformationMessage(msg.reason || "호스트가 방을 종료했습니다.");

            // 로컬 사본 파일들을 완전히 제거 (에디터 닫기 및 디스크 파일 삭제)
            const filesToClean = [...this.engine.fileStorageManager.sharedFiles];
            for (const file of filesToClean) {
                await this.engine.fileStorageManager.handleRemoteStop(file.name);
            }

            await this.engine.sessionRecoveryManager.clearSession();
            this.engine.reset();
            this.engine.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    }

    /**
     * [추가] 호스트로부터 권한 변경 메시지 수신 (게스트 전용)
     */
    public async handleSetPermission(msg: any) {
        if (!this.engine.isHost) {
            const p = msg.permission as PeerPermission;
            this.participants[this.engine.myId] = {
                name: this.engine.myName,
                globalCanEdit: p.globalCanEdit,
                filePermissions: p.filePermissions
            };
            this.engine.logToUI(`Permission updated: Global=${p.globalCanEdit}`);
            await this.engine.fileStorageManager.updateAllReadonlyStates();
            this.engine.pushUIUpdate();
            this.engine.cursorManager.refreshAllDecorations();
        }
    }

    /**
     * 호스트 연결 단절 시 30초 동안 에디터를 잠그고 조용히 재접속을 시도하는 유예 기간을 시작합니다.
     */
    public async startGuestReconnectGracePeriod() {
        this.isReconnecting = true;
        this.engine.isConnected = false;
        this.engine.updateStatus('Reconnecting...');
        this.engine.logToUI(`Host connection lost temporarily. Entering 30s grace period and locking editor...`);

        // 1. 게스트 에디터 일시 잠금 (오프라인 타이핑 유실 및 충돌 100% 방지)
        for (const file of this.engine.fileStorageManager.sharedFiles) {
            const editor = vscode.window.visibleTextEditors.find(e => isPathEqual(e.document.uri.fsPath, file.path));
            if (editor) {
                await this.engine.fileStorageManager.applyEditorReadonlyState(editor, true);
            }
        }
        vscode.window.setStatusBarMessage(`🔒 호스트 작업 공간 전환 중... 재연결 대기 (최대 30초)`, 30000);

        // 2. 30초 전체 타임아웃 타이머 설정
        if (this.reconnectDeadlineTimer) clearTimeout(this.reconnectDeadlineTimer);
        this.reconnectDeadlineTimer = setTimeout(() => {
            this.engine.logToUI(`Host reconnection timeout exceeded (30s).`);
            vscode.window.showErrorMessage("호스트가 세션을 종료했거나 재연결 제한 시간(30초)을 초과했습니다.");
            this.stopGuestReconnectGracePeriod();
            this.engine.reset();
        }, 30000);

        // 3. 2초 간격으로 PeerJS 호스트에게 재연결(노크) 시도
        const savedRoomName = this.engine.roomName;
        const savedName = this.engine.myName;
        const savedId = this.engine.myId;

        const tryReconnect = () => {
            if (!this.isReconnecting) return;
            this.engine.logToUI(`Attempting to reconnect to host room "${savedRoomName}"...`);
            this.engine.hub.dispose();
            this.sendJoinRequest(savedRoomName, savedName, savedId);

            this.reconnectRetryTimer = setTimeout(tryReconnect, 3000);
        };

        // 1초 뒤 첫 재시도
        this.reconnectRetryTimer = setTimeout(tryReconnect, 1000);
    }

    /**
     * 재연결 성공 또는 실패 시 유예 타이머 및 상태를 정리합니다.
     */
    public stopGuestReconnectGracePeriod() {
        this.isReconnecting = false;
        if (this.reconnectRetryTimer) {
            clearTimeout(this.reconnectRetryTimer);
            this.reconnectRetryTimer = undefined;
        }
        if (this.reconnectDeadlineTimer) {
            clearTimeout(this.reconnectDeadlineTimer);
            this.reconnectDeadlineTimer = undefined;
        }
    }

    /**
     * 호스트가 게스트들의 실시간 연결 상태를 주기적으로 확인하기 위해 Ping 타이머를 시작합니다.
     */
    public startPingCheck() {
        this.stopPingCheck();
        if (!this.engine.isHost) return;

        // 4초마다 모든 게스트에게 PING 전송 및 PONG 타임아웃(8초) 검사
        this.pingTimer = setInterval(() => {
            if (!this.engine.isHost) return;

            const now = Date.now();
            let hasStatusChanged = false;

            Object.entries(this.participants).forEach(([peerId, perm]) => {
                if (peerId === 'host' || peerId === 'default') {
                    if (perm.connectionStatus !== 'connected') {
                        perm.connectionStatus = 'connected';
                        hasStatusChanged = true;
                    }
                    return;
                }

                // 게스트에게 PING 전송
                this.engine.sendMessageToPeer(peerId, 'PING', { timestamp: now });

                // PONG 응답 시간 검사 (마지막 응답으로부터 8초 초과 시 reconnecting/노란색으로 표시)
                const lastPong = this.lastPongTimes.get(peerId);
                const isAlive = lastPong !== undefined && (now - lastPong <= 8000);
                const currentStatus = isAlive ? 'connected' : 'reconnecting';

                if (currentStatus === 'reconnecting') {
                    // 재연결 대기 시작 시점 기록
                    if (!this.reconnectStartTimes.has(peerId)) {
                        this.reconnectStartTimes.set(peerId, now);
                    }
                    const reconnectStarted = this.reconnectStartTimes.get(peerId) || now;
                    // 게스트 재연결 유예 시간(30초) 초과 시 참가자 명단에서 완전히 정리
                    if (now - reconnectStarted >= 30000) {
                        this.engine.logToUI(`Guest reconnect timeout exceeded (30s) for: ${perm.name} (${peerId})`);
                        this.handlePeerDisconnect(peerId);
                        return;
                    }
                } else {
                    this.reconnectStartTimes.delete(peerId);
                }

                if (perm.connectionStatus !== currentStatus) {
                    perm.connectionStatus = currentStatus;
                    hasStatusChanged = true;
                }
            });

            if (hasStatusChanged) {
                this.broadcastUserList();
            }
        }, 4000);
    }

    /**
     * Ping 타이머를 중지합니다.
     */
    public stopPingCheck() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
    }

    /**
     * 게스트로부터 PONG 응답을 수신했을 때 호출됩니다. (호스트 전용)
     */
    public handlePong(peerId: string) {
        if (!this.engine.isHost) return;
        this.lastPongTimes.set(peerId, Date.now());
        this.reconnectStartTimes.delete(peerId);

        const perm = this.participants[peerId];
        if (perm && perm.connectionStatus !== 'connected') {
            perm.connectionStatus = 'connected';
            this.broadcastUserList();
        }
    }

    public reset() {
        this.stopPingCheck();
        this.lastPongTimes.clear();
        this.reconnectStartTimes.clear();
        this.stopGuestReconnectGracePeriod();
        this.clearJoinTimeout();
        this.participants = {};
        this.joinRequests = [];
        this.pendingInvites.clear();
        this.isAutoJoin = false;
        this.isAutoApprove = false;
        this.pendingJoinRequest = null;
    }
}
