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

/**
 * ParticipantManager 클래스.
 * 방 참가자(게스트)의 목록 관리, 권한 제어(읽기/쓰기, 파일 담당자 지정),
 * 방 참여 승인/거절(수동 및 자동 승인), 초대 생성, 사용자 이름 변경, 강제 퇴장(Kick),
 * 실시간 Ping-Pong 연결 모니터링 및 네트워크 단절 시 30초 재연결 유예(Grace Period) 처리를 전담합니다.
 */
export class ParticipantManager {
    /** 피어 ID별 권한 및 상태 정보 맵 */
    public participants: { [key: string]: PeerPermission } = {};

    /** 호스트가 수신하여 대기 중인 게스트 방 참여 요청 목록 */
    public joinRequests: any[] = [];

    /** 초대 링크 생성 시 발급된 대기 중인 초대 피어 ID 세트 */
    public pendingInvites = new Set<string>();

    /** 게스트가 방 참여를 시도 중인지 여부 플래그 */
    public isAutoJoin = false;

    /** 새 참가자 참여 시 즉시 승인할지 여부 플래그 (호스트 전용) */
    public isAutoApprove = false;

    /** 게스트 연결 준비 완료 시 자동 발송할 대기 중인 참여 요청 정보 */
    public pendingJoinRequest: { roomName: string, userName: string, previousPeerId?: string } | null = null;

    /** 게스트 방 입장 시도 전체 제한시간(20초) 타이머 */
    private joinTimeout?: NodeJS.Timeout;

    /** 게스트 네트워크 일시 단절 시 30초 재연결 유예 모드 활성화 여부 플래그 */
    public isReconnecting = false;

    /** 현재 재연결 시도(프로브)가 진행 중인지 여부 플래그 */
    private isProbeInFlight = false;

    /** 게스트 재연결 재시도 주기 타이머 */
    private reconnectRetryTimer?: NodeJS.Timeout;

    /** 게스트 재연결 최종 데드라인(30초) 타이머 */
    private reconnectDeadlineTimer?: NodeJS.Timeout;

    /** 게스트 방 입장 승인 요청(JOIN_REQUEST) 주기적 재전송 타이머 */
    private joinRequestRetryTimer?: NodeJS.Timeout;

    /** 호스트로부터 JOIN_REQUEST_ACK를 수신했는지 여부 플래그 */
    private isJoinRequestAckReceived = false;

    /** 피어들의 생존 여부를 주기적으로 확인하는 PING 타이머 */
    private pingTimer?: NodeJS.Timeout;

    /** 피어 ID별 가장 최근 PONG 수신 에포크 밀리초 타임스탬프 맵 */
    public lastPongTimes = new Map<string, number>();

    /** 피어 ID별 재연결 대기 상태가 시작된 시점의 타임스탬프 맵 */
    public reconnectStartTimes = new Map<string, number>();

    /**
     * ParticipantManager 인스턴스를 생성합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     */
    constructor(private engine: SyncEngine) {}

    /**
     * 특정 피어가 특정 파일에 대한 쓰기/편집 권한이 있는지 확인합니다.
     * 파일에 단독 담당자(Assignee)가 지정되어 있는 경우 담당자만 편집 가능합니다.
     * @param peerId 확인할 피어 ID.
     * @param fileName 대상 파일 이름.
     * @returns 편집 가능하면 true, 그렇지 않으면 false.
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
     * 현재 로컬 사용자가 특정 파일에 대한 쓰기/편집 권한이 있는지 확인합니다.
     * @param fileName 확인할 파일 이름.
     * @returns 편집 가능하면 true, 그렇지 않으면 false.
     */
    public canIEdit(fileName: string): boolean {
        // 호스트는 항상 모든 파일에 대한 완전한 권한을 가짐
        if (this.engine.isHost) return true;
        
        // 내 ID 또는 기본 ID로 데이터 검색
        const myData = this.participants[this.engine.myId] || this.participants['default'];
        
        if (!myData) return false; // 기본 권한 없음
        
        // 파일에 담당자가 지정되어 있는 경우 본인 일치 여부 검사
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (file && file.assigneeId) {
            return file.assigneeId === this.engine.myId;
        }
        
        // 1. 전체 편집 권한이 부여되어 있는 경우 통과
        if (myData.globalCanEdit) return true;
        
        // 2. 파일별 개별 권한 확인
        return myData.filePermissions[fileName] === true;
    }

    /**
     * 지정한 방 이름으로 호스트에게 방 참여 요청을 전송하고 WebRTC 연결을 초기화합니다 (게스트용).
     * @param roomName 참여할 방 이름.
     * @param userName 사용자 닉네임.
     * @param previousPeerId 세션 복원 시 사용될 이전 피어 ID (선택 사항).
     * @returns {Promise<void>}
     */
    public async sendJoinRequest(roomName: string, userName: string, previousPeerId?: string): Promise<void> {
        this.engine.roomName = roomName;
        this.engine.myName = userName || '';
        if (previousPeerId) {
            this.engine.myId = previousPeerId;
        }
        this.engine.isSetupMode = false;
        this.isAutoJoin = true; // 자동 참여 모드 설정
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
     * 게스트 방 입장 대기 제한시간 타이머를 정리합니다.
     * @returns {void}
     */
    public clearJoinTimeout(): void {
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
            this.joinTimeout = undefined;
        }
    }

    /**
     * ACK 확인 기반으로 호스트에게 방 참여 요청(JOIN_REQUEST)을 발송하고,
     * ACK가 올 때까지 주기적으로 재전송합니다 (게스트 전용).
     * @param reqData 요청 데이터 (사용자 이름, 피어 ID, 이전 피어 ID).
     * @returns {void}
     */
    public startJoinRequestWithAck(reqData: { name: string, peerId: string, previousPeerId?: string }): void {
        this.stopJoinRequestRetry();
        this.isJoinRequestAckReceived = false;

        let attempts = 0;
        const maxAttempts = 5;

        const sendAndSchedule = () => {
            if (this.isJoinRequestAckReceived || this.engine.isConnected || !this.isAutoJoin) {
                this.stopJoinRequestRetry();
                return;
            }

            attempts++;
            this.engine.logToUI(`Sending JOIN_REQUEST to host (attempt ${attempts}/${maxAttempts})...`);
            vscode.window.setStatusBarMessage(`호스트에게 참여 요청 전달 중... (${attempts}/${maxAttempts})`, 2500);

            this.engine.sendMessage('JOIN_REQUEST', reqData);

            if (attempts < maxAttempts) {
                this.joinRequestRetryTimer = setTimeout(sendAndSchedule, 1800);
            } else {
                this.engine.logToUI(`Max JOIN_REQUEST attempts reached (${maxAttempts}). Waiting for host response...`);
            }
        };

        sendAndSchedule();
    }

    /**
     * 호스트로부터 참여 요청 접수 확인(ACK)을 수신했을 때 호출됩니다 (게스트 전용).
     * @param msg 수신된 ACK 메시지 객체.
     * @returns {void}
     */
    public handleJoinRequestAck(msg: any): void {
        if (this.engine.isHost) return;
        this.isJoinRequestAckReceived = true;
        this.stopJoinRequestRetry();
        this.clearJoinTimeout();

        this.engine.logToUI(`JOIN_REQUEST_ACK received: Host successfully received join request.`);
        vscode.window.setStatusBarMessage(`호스트가 요청을 확인했습니다. 승인을 기다리는 중...`, 5000);
        this.engine.updateStatus('Waiting...');
        this.engine.pushUIUpdate();
    }

    /**
     * 참여 요청 재전송 타이머를 중지합니다.
     * @returns {void}
     */
    public stopJoinRequestRetry(): void {
        if (this.joinRequestRetryTimer) {
            clearTimeout(this.joinRequestRetryTimer);
            this.joinRequestRetryTimer = undefined;
        }
    }

    /**
     * 대기 중인 게스트의 방 참여 요청을 승인합니다 (호스트 전용).
     * @param peerId 승인할 피어 ID.
     * @returns {void}
     */
    public approveRequest(peerId: string): void {
        if (!this.engine.isHost) return;
        
        // 승인 시 게스트를 참가자로 추가
        const request = this.joinRequests.find(req => req.peerId === peerId);
        if (request) {
            this.handleGuestJoin({ name: request.name, previousPeerId: request.previousPeerId }, peerId);
        }
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        
        // 승인 메시지 전송 (네트워크 버퍼링 및 패킷 유실 방지를 위해 다중 발송)
        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
        setTimeout(() => {
            if (this.engine.isHost && this.participants[peerId]) {
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
            }
        }, 200);
        setTimeout(() => {
            if (this.engine.isHost && this.participants[peerId]) {
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
            }
        }, 450);
        
        this.engine.pushUIUpdate();
    }

    /**
     * 대기 중인 모든 게스트의 방 참여 요청을 일괄 승인합니다 (호스트 전용).
     * @returns {void}
     */
    public approveAllRequests(): void {
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
     * 자동 승인 모드를 설정합니다 (호스트 전용).
     * 활성화 시 현재 대기 중인 모든 요청을 즉시 일괄 승인합니다.
     * @param enabled 자동 승인 활성화 여부.
     * @returns {void}
     */
    public setAutoApprove(enabled: boolean): void {
        if (!this.engine.isHost) return;
        this.isAutoApprove = enabled;
        if (enabled) {
            this.approveAllRequests();
        } else {
            this.engine.pushUIUpdate();
        }
    }

    /**
     * 특정 게스트의 방 참여 요청을 거절하고 연결을 종료합니다 (호스트 전용).
     * @param peerId 거절할 피어 ID.
     * @returns {void}
     */
    public rejectRequest(peerId: string): void {
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
     * 호스트가 방에 참여한 게스트를 참가자 명단에 등록하고 최신 공유 파일 스냅샷과 데코레이션을 전송합니다.
     * 창 새로고침 등으로 재연결된 게스트인 경우 이전 피어 ID의 권한과 파일 담당자 상태를 승계합니다.
     * @param msg 게스트 참여 메시지 (사용자 이름, 이전 피어 ID 등).
     * @param peerId 신규 접속한 게스트의 피어 ID.
     * @returns {void}
     */
    public handleGuestJoin(msg: any, peerId: string): void {
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
            
            // 새로 들어온 게스트에게 현재 공유 중인 모든 파일 스냅샷 및 Yjs 상태 전송
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
     * 호스트가 특정 피어의 권한을 설정하고 해당 피어 및 전체 참가자에게 알립니다.
     * @param peerId 대상 피어 ID.
     * @param permission 설정할 권한 객체.
     * @returns {void}
     */
    public setPeerPermission(peerId: string, permission: PeerPermission): void {
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
     * 호스트가 모든 게스트의 쓰기 권한을 일괄 해제(읽기 전용 전환)하고 파일 담당자 지정을 초기화합니다.
     * @returns {void}
     */
    public revokeAllWritePermissions(): void {
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
     * 특정 파일의 단독 편집 담당자를 지정하거나 해제하고 모든 피어에게 브로드캐스트합니다.
     * @param fileName 대상 파일 이름.
     * @param assigneeId 담당자로 지정할 피어 ID (빈 문자열일 경우 해제).
     * @returns {void}
     */
    public setFileAssignee(fileName: string, assigneeId: string): void {
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
     * 새로운 게스트를 위한 임시 초대 세션을 생성하고 허브 연결을 초기화합니다.
     * @param isSilent true일 경우 UI를 초대 화면으로 전환하지 않고 배경에서 생성합니다 (기본값: false).
     * @returns {void}
     */
    public inviteGuest(isSilent: boolean = false): void {
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
     * 현재 로컬 사용자의 표시 이름을 변경하고 중복 검사 및 피어 브로드캐스트를 수행합니다.
     * @param newName 새로 설정할 닉네임.
     * @returns {void}
     */
    public changeMyName(newName: string): void {
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
     * 참가자 명단과 최신 방 이름을 모든 피어에게 브로드캐스트합니다 (호스트 전용).
     * @returns {void}
     */
    public broadcastUserList(): void {
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
     * 특정 피어를 강제로 방에서 퇴장시키고 WebRTC 연결을 종료합니다 (호스트 전용).
     * @param peerId 퇴장시킬 피어 ID.
     * @returns {Promise<void>}
     */
    public async kickPeer(peerId: string): Promise<void> {
        if (!this.engine.isHost) return;

        const targetUser = this.participants[peerId];
        const targetName = targetUser?.name || peerId;

        const answer = await vscode.window.showWarningMessage(
            `"${targetName}" 사용자를 정말 강제 퇴장시키겠습니까?`,
            { modal: true },
            "강제 퇴장"
        );
        if (answer !== "강제 퇴장") return;

        // 퇴장 메시지 전송
        this.engine.sendMessageToPeer(peerId, 'KICKED', { reason: '호스트에 의해 방에서 퇴장되었습니다.' });

        // 엔진 레벨에서 WebRTC 피어 연결 해제
        this.engine.hub.disconnectPeer(peerId);

        // 로컬에서 즉시 연결 해제 처리
        this.handlePeerDisconnect(peerId);
        vscode.window.showInformationMessage(`"${targetName}" 사용자를 방에서 퇴장시켰습니다.`);
    }

    /**
     * 피어 연결 해제 이벤트를 처리합니다.
     * 게스트의 경우 호스트 단절 시 30초 유예 모드로 진입하며, 호스트의 경우 해당 피어를 명단에서 제거합니다.
     * @param peerId 연결이 해제된 피어 ID.
     * @returns {void}
     */
    public handlePeerDisconnect(peerId: string): void {
        if (!this.engine.isHost) {
            // 게스트일 경우: 호스트와의 일시적 단절(호스트 창 전환 등)을 감지하고 30초 재연결 유예 모드로 진입
            // peerId가 'default', 'all', 또는 할당받았던 내 ID/호스트 ID 어디서 오든 동일하게 보호
            if (this.engine.isConnected && !this.isReconnecting) {
                this.startGuestReconnectGracePeriod();
            } else if (!this.isReconnecting) {
                this.engine.reset(); 
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
     * 게스트로부터 방 참여 요청을 수신했을 때 ACK를 전송하고 자동 승인 또는 요청 대기열에 추가합니다 (호스트 전용).
     * @param msg 수신된 참여 요청 메시지 (이름, 이전 피어 ID 등).
     * @param peerId 요청한 게스트 피어 ID.
     * @returns {void}
     */
    public handleJoinRequest(msg: any, peerId: string): void {
        if (this.engine.isHost) {
            const guestName = msg.name || peerId;
            const previousPeerId = msg.previousPeerId;

            // 0. 게스트에게 요청이 정상 도착했음을 알리는 ACK 즉시 회신 (게스트 재전송 중지 유도)
            this.engine.sendMessageToPeer(peerId, 'JOIN_REQUEST_ACK', { received: true });

            const existingParticipant = this.participants[peerId] || 
                (previousPeerId && this.participants[previousPeerId]) || 
                Object.values(this.participants).find(p => p.name === guestName);

            // 호스트 창 전환 후 재접속한 기존 게스트이거나 자동 승인 모드인 경우 즉시 승인
            if (existingParticipant || this.isAutoApprove) {
                this.handleGuestJoin({ name: guestName, previousPeerId }, peerId);
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
                setTimeout(() => {
                    if (this.engine.isHost && this.participants[peerId]) {
                        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
                    }
                }, 200);
                setTimeout(() => {
                    if (this.engine.isHost && this.participants[peerId]) {
                        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
                    }
                }, 450);

                if (existingParticipant) {
                    vscode.window.showInformationMessage(`재연결 승인: ${guestName} (${peerId})`);
                } else {
                    vscode.window.showInformationMessage(`방 참여 자동 승인: ${guestName} (${peerId})`);
                }
                this.engine.pushUIUpdate();
            } else {
                // 이미 대기 중인 요청이 있다면 정보만 갱신(중복 알림 및 중복 리스트 방지)
                const existingIndex = this.joinRequests.findIndex(req => req.peerId === peerId);
                if (existingIndex >= 0) {
                    this.joinRequests[existingIndex] = {
                        peerId,
                        name: guestName,
                        previousPeerId,
                        timestamp: Date.now()
                    };
                } else {
                    this.joinRequests.push({
                        peerId,
                        name: guestName,
                        previousPeerId,
                        timestamp: Date.now()
                    });
                    vscode.window.showInformationMessage(`방 참여 요청: ${guestName} (${peerId})`);
                }
                this.engine.pushUIUpdate();
            }
        }
    }

    /**
     * 호스트로부터 방 참여 승인/거절 응답을 수신하여 세션을 연결하거나 리셋합니다 (게스트 전용).
     * @param msg 수신된 승인/거절 메시지 객체.
     * @returns {Promise<void>}
     */
    public async handleJoinResponse(msg: any): Promise<void> {
        if (!this.engine.isHost) {
            this.stopJoinRequestRetry();
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
     * 호스트로부터 강제 퇴장(KICKED) 메시지를 수신했을 때 임시 파일을 삭제하고 세션을 정리합니다 (게스트 전용).
     * @param msg 수신된 강제 퇴장 메시지 객체.
     * @returns {Promise<void>}
     */
    public async handleKicked(msg: any): Promise<void> {
        if (!this.engine.isHost) {
            this.stopGuestReconnectGracePeriod();
            vscode.window.showErrorMessage(`퇴장되었습니다: ${msg.reason}`);

            // 로컬 사본 파일들을 완전히 제거 (에디터 닫기 및 디스크 임시 파일/폴더 전체 삭제)
            await this.engine.fileStorageManager.clearLocalStorage();

            await this.engine.sessionRecoveryManager.clearSession();
            this.engine.reset();
            this.engine.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    }

    /**
     * 호스트의 방 종료(ROOM_CLOSED) 메시지를 수신했을 때 임시 파일을 정리하고 세션을 종료합니다 (게스트 전용).
     * @param msg 수신된 방 종료 메시지 객체.
     * @returns {Promise<void>}
     */
    public async handleRoomClosed(msg: any): Promise<void> {
        if (!this.engine.isHost) {
            this.stopGuestReconnectGracePeriod();
            vscode.window.showInformationMessage(msg.reason || "호스트가 방을 종료했습니다.");

            // 로컬 사본 파일들을 완전히 제거 (에디터 닫기 및 디스크 임시 파일/폴더 전체 삭제)
            await this.engine.fileStorageManager.clearLocalStorage();

            await this.engine.sessionRecoveryManager.clearSession();
            this.engine.reset();
            this.engine.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    }

    /**
     * 호스트로부터 권한 변경(SET_PERMISSION) 메시지를 수신하여 에디터 읽기 전용 모드를 재설정합니다 (게스트 전용).
     * @param msg 수신된 권한 객체를 담은 메시지.
     * @returns {Promise<void>}
     */
    public async handleSetPermission(msg: any): Promise<void> {
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
     * 호스트 일시 단절 감지 시 30초 동안 에디터를 잠그고 조용히 재접속을 시도하는 유예 기간(Grace Period)을 시작합니다 (게스트 전용).
     * @returns {Promise<void>}
     */
    public async startGuestReconnectGracePeriod(): Promise<void> {
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
        this.reconnectDeadlineTimer = setTimeout(async () => {
            this.engine.logToUI(`Host reconnection timeout exceeded (30s).`);
            vscode.window.showErrorMessage("호스트가 세션을 종료했거나 재연결 제한 시간(30초)을 초과했습니다.");
            this.stopGuestReconnectGracePeriod();

            // 로컬 임시 파일/폴더 삭제 및 세션 영구 정리
            await this.engine.fileStorageManager.clearLocalStorage();
            await this.engine.sessionRecoveryManager.clearSession();

            this.engine.reset();
            this.engine.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }, 30000);

        // 3. 간격을 두고 호스트에게 재연결(노크) 시도 및 상태 메시지 갱신
        const savedRoomName = this.engine.roomName;
        const savedName = this.engine.myName;
        const savedId = this.engine.myId;
        const startTime = Date.now();
        this.isProbeInFlight = false;

        const tryReconnect = () => {
            if (!this.isReconnecting) return;
            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const remainingSec = Math.max(0, 30 - elapsedSec);
            vscode.window.setStatusBarMessage(`🔒 호스트 작업 공간 전환 중... 재연결 대기 (${remainingSec}초 남음)`, 3000);

            // 이미 연결 핸드셰이크가 진행 중이면 소켓을 파괴하지 않고 진행 완료를 기다림
            if (this.isProbeInFlight) {
                this.engine.logToUI(`Reconnection probe already in progress (${elapsedSec}s elapsed), waiting...`);
                this.reconnectRetryTimer = setTimeout(tryReconnect, 2500);
                return;
            }

            this.engine.logToUI(`Attempting to reconnect to host room "${savedRoomName}" (${elapsedSec}s elapsed)...`);
            this.isProbeInFlight = true;
            this.engine.hub.dispose();
            this.sendJoinRequest(savedRoomName, savedName, savedId);

            // 서로 다른 물리 PC 환경의 ICE 수집 및 시그널링 교환 시간을 고려하여 최소 4.5초 확보
            const nextInterval = elapsedSec < 10 ? 4500 : 5000;
            this.reconnectRetryTimer = setTimeout(tryReconnect, nextInterval);
        };

        // 호스트 소켓 정리 및 새 방 등록 완료를 대기한 뒤 첫 재시도 (2500ms)
        this.reconnectRetryTimer = setTimeout(tryReconnect, 2500);
    }

    /**
     * 게스트 재연결 프로브가 실패(호스트 미준비/오프라인)했음을 통보받았을 때 즉시 호출되어 2초 후 다음 시도를 트리거합니다.
     * @returns {void}
     */
    public onGuestReconnectProbeFailed(): void {
        if (!this.isReconnecting) return;
        this.isProbeInFlight = false;
        if (this.reconnectRetryTimer) {
            clearTimeout(this.reconnectRetryTimer);
        }
        // 실패 시 2초 후 다음 재시도 트리거 (호스트 고스트 ID 해제 대기 보장)
        this.reconnectRetryTimer = setTimeout(() => {
            if (this.isReconnecting) {
                const savedRoomName = this.engine.roomName;
                const savedName = this.engine.myName;
                const savedId = this.engine.myId;
                this.engine.hub.dispose();
                this.sendJoinRequest(savedRoomName, savedName, savedId);
            }
        }, 2000);
    }

    /**
     * 재연결 성공 또는 최종 타임아웃 시 유예 타이머 및 관련 상태를 정리합니다.
     * @returns {void}
     */
    public stopGuestReconnectGracePeriod(): void {
        this.isReconnecting = false;
        this.isProbeInFlight = false;
        if (this.reconnectRetryTimer) {
            clearTimeout(this.reconnectRetryTimer);
            this.reconnectRetryTimer = undefined;
        }
        if (this.reconnectDeadlineTimer) {
            clearTimeout(this.reconnectDeadlineTimer);
            this.reconnectDeadlineTimer = undefined;
        }
        vscode.window.setStatusBarMessage('✅ 호스트에 다시 연결되었습니다.', 3000);
    }

    /**
     * 호스트가 게스트들의 실시간 연결 상태를 주기적으로 확인하기 위해 Ping 타이머를 시작합니다.
     * 8초 이상 응답이 없으면 'reconnecting'으로 표시하고, 30초 초과 시 연결을 종료합니다.
     * @returns {void}
     */
    public startPingCheck(): void {
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
     * 실행 중인 Ping 타이머를 중지합니다.
     * @returns {void}
     */
    public stopPingCheck(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = undefined;
        }
    }

    /**
     * 게스트로부터 PONG 응답을 수신했을 때 호출되어 연결 상태를 'connected'로 갱신합니다 (호스트 전용).
     * @param peerId 응답을 보낸 게스트 피어 ID.
     * @returns {void}
     */
    public handlePong(peerId: string): void {
        if (!this.engine.isHost) return;
        this.lastPongTimes.set(peerId, Date.now());
        this.reconnectStartTimes.delete(peerId);

        let perm = this.participants[peerId];
        // peerId로 직접 매칭되지 않는 경우, 동일한 ID 또는 이름을 가진 참가자 항목을 검색
        if (!perm) {
            const foundEntry = Object.entries(this.participants).find(([id, p]) => id === peerId || p.name === peerId);
            if (foundEntry) {
                this.lastPongTimes.set(foundEntry[0], Date.now());
                this.reconnectStartTimes.delete(foundEntry[0]);
                perm = foundEntry[1];
            }
        }

        if (perm && perm.connectionStatus !== 'connected') {
            perm.connectionStatus = 'connected';
            this.broadcastUserList();
        }
    }

    /**
     * ParticipantManager의 모든 타이머, 참가자 명단, 요청 대기열 및 연결 상태를 초기화합니다.
     * @returns {void}
     */
    public reset(): void {
        this.stopPingCheck();
        this.lastPongTimes.clear();
        this.reconnectStartTimes.clear();
        this.stopGuestReconnectGracePeriod();
        this.stopJoinRequestRetry();
        this.clearJoinTimeout();
        this.isJoinRequestAckReceived = false;
        this.participants = {};
        this.joinRequests = [];
        this.pendingInvites.clear();
        this.isAutoJoin = false;
        this.isAutoApprove = false;
        this.pendingJoinRequest = null;
    }
}
