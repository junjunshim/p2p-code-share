/** 참여자 목록 관리, 승인/거절, 권한 부여, 이름 변경, 강퇴 등의 로직을 처리합니다. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import * as Y from 'yjs';
import { PeerPermission } from '../../types';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual, normalizeEOL } from '../../utils/helpers';
import { Logger } from '../../utils/Logger';

/**
 * ParticipantManager 클래스.
 * 방 참가자(게스트)의 목록 관리, 권한 제어(읽기/쓰기, 파일 담당자 지정),
 * 방 참여 승인/거절(수동 및 자동 승인), 초대 생성, 사용자 이름 변경, 강제 퇴장(Kick),
 * 실시간 Ping-Pong 연결 모니터링 및 네트워크 단절 시 30초 재연결 유예(Grace Period) 처리를 전담합니다.
 */
export class ParticipantManager {
    /** 게스트 초기 핸드셰이크(제어 채널 + 데이터 채널 수립) 제한 시간(ms) */
    private static readonly JOIN_HANDSHAKE_TIMEOUT_MS = 30000;

    /** 초기 핸드셰이크 자동 재시도 시의 제한 시간(ms) */
    private static readonly JOIN_HANDSHAKE_RETRY_TIMEOUT_MS = 20000;

    /** 초기 핸드셰이크 자동 재시도 최대 횟수(사용자 개입 없이 1회 복구 시도) */
    private static readonly MAX_JOIN_HANDSHAKE_RETRIES = 1;

    /** 호스트가 게스트 단절을 감지한 뒤 참가자/재접속 토큰을 보존하는 재연결 유예 시간(ms) */
    private static readonly HOST_RECONNECT_GRACE_MS = 45000;

    /** 피어 ID별 권한 및 상태 정보 맵 */
    public participants: { [key: string]: PeerPermission } = {};

    /** 호스트가 수신하여 대기 중인 게스트 방 참여 요청 목록 */
    public joinRequests: any[] = [];

    /** 초대 링크 생성 시 발급된 대기 중인 초대 피어 ID 세트 */
    public pendingInvites = new Set<string>();

    /** 같은 밀리초에 여러 초대 슬롯을 만들 때 피어 ID 가 충돌하지 않도록 하는 단조 증가 시퀀스 */
    private inviteSeq = 0;

    /** 호스트가 단절된 게스트를 유예 시간(45초) 후 제거하기 위해 피어별로 예약한 타이머 맵 */
    private hostGraceTimers = new Map<string, NodeJS.Timeout>();

    /** 게스트가 방 참여를 시도 중인지 여부 플래그 */
    public isAutoJoin = false;

    /** 게스트가 방에 성공적으로 참여 및 승인되었는지 여부 플래그 (최초 승인 전에는 재연결 모드로 빠지지 않음) */
    public hasJoinedSuccessfully = false;

    /** 게스트가 재접속 시 본인임을 증명하기 위한 비밀 토큰 */
    public myReconnectToken = '';

    /** 호스트가 참가자별 재접속 토큰을 비공개로 보관하는 맵 */
    public peerReconnectTokens = new Map<string, string>();

    /** 새 참가자 참여 시 즉시 승인할지 여부 플래그 (호스트 전용) */
    public isAutoApprove = false;

    /** 게스트 연결 준비 완료 시 자동 발송할 대기 중인 참여 요청 정보 */
    public pendingJoinRequest: { roomName: string, userName: string, previousPeerId?: string } | null = null;

    /** 게스트 재연결 유예 모드 진입 시 본래 피어 ID 보존 (프로브 실패로 임시 ID가 바뀌어도 영속 유지) */
    public reconnectOriginalPeerId?: string;

    /** 게스트 방 입장 시도 전체 제한시간 타이머 */
    private joinTimeout?: NodeJS.Timeout;

    /** 초기 핸드셰이크 자동 재시도 횟수 */
    private joinHandshakeRetries = 0;

    /** 게스트 네트워크 일시 단절 시 30초 재연결 유예 모드 활성화 여부 플래그 */
    public isReconnecting = false;

    /** 현재 재연결 시도(프로브)가 진행 중인지 여부 플래그 */
    private isProbeInFlight = false;

    /** 프로브 무응답 교착 상태(Deadlock) 방지를 위한 안전 타임아웃 타이머 */
    private probeInFlightTimeout?: NodeJS.Timeout;

    /** 게스트 재연결 재시도 주기 타이머 */
    private reconnectRetryTimer?: NodeJS.Timeout;

    /** 게스트 재연결 시도 함수 참조 (프로브 실패 시 즉시 루프 재시동용) */
    private tryReconnectFn?: () => void;

    /** 게스트 재연결 최종 데드라인(30초) 타이머 */
    private reconnectDeadlineTimer?: NodeJS.Timeout;

    /** 게스트 방 입장 승인 요청(JOIN_REQUEST) 주기적 재전송 타이머 */
    private joinRequestRetryTimer?: NodeJS.Timeout;

    /** 호스트로부터 JOIN_REQUEST_ACK를 수신했는지 여부 플래그 */
    private isJoinRequestAckReceived = false;

    /** 피어들의 생존 여부를 주기적으로 확인하는 PING 타이머 */
    private pingTimer?: NodeJS.Timeout;

    /** 유저 리스트 브로드캐스트 패킷 폭증 방지를 위한 디바운스 타이머 */
    private broadcastUserListDebounceTimer?: NodeJS.Timeout;

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
     * 초대 피어에 연결할 비밀 재접속 토큰을 발급하거나 기존 토큰을 반환합니다.
     * @param peerId 토큰을 연결할 피어 ID.
     * @returns 256비트 난수 기반 토큰.
     */
    public getOrCreatePeerReconnectToken(peerId: string): string {
        let token = this.peerReconnectTokens.get(peerId);
        if (!token) {
            token = randomBytes(32).toString('hex');
            this.peerReconnectTokens.set(peerId, token);
        }
        return token;
    }

    /**
     * 호스트가 발급한 재접속 토큰을 게스트 로컬 상태에 보관합니다.
     * 기존 토큰이 있으면 재접속 시 사용할 수 있도록 유지합니다.
     * @param token 호스트가 연결 ID 할당과 함께 전달한 토큰.
     */
    public rememberMyReconnectToken(token: unknown): void {
        if (!this.myReconnectToken && typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token)) {
            this.myReconnectToken = token;
        }
    }

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
        
        // 게스트 재연결 유예 기간 중에는 오프라인 타이핑 유실 및 충돌 방지를 위해 편집 불가
        if (this.isReconnecting) return false;
        
        // 내 ID로 데이터 검색
        const myData = this.engine.myId ? this.participants[this.engine.myId] : undefined;
        
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
     */
    public async sendJoinRequest(roomName: string, userName: string, previousPeerId?: string): Promise<void> {
        this.engine.roomName = roomName;
        this.engine.myName = userName || '';
        if (previousPeerId) {
            this.engine.myId = previousPeerId;
        }
        this.engine.isSetupMode = false;
        this.isAutoJoin = true; // 자동 참여 모드 설정
        // 재연결 프로브 중에는 최초 승인 플래그를 유지하여, 프로브가 잠시 끊겨도 유예 모드가 깨지지 않게 합니다.
        if (!this.isReconnecting) {
            this.hasJoinedSuccessfully = false;
        }
        this.pendingJoinRequest = { roomName, userName, previousPeerId }; // 요청 큐에 저장

        Logger.get().step('GuestJoin', 1, 5, `Starting join request for room "${roomName}" as "${this.engine.myName}"`);

        // 게스트가 새로운 방에 입장할 때 기존에 남아있던 타 방 임시 디렉터리들을 선제적으로 정리
        this.engine.fileStorageManager.cleanOldRoomStorages(roomName);
        this.engine.pushUIUpdate();

        // 초기 WebRTC 물리 채널이 제한 시간 안에 열리지 않으면 같은 방으로 한 번 더 자동 재시도하고,
        // 재시도까지 실패해야 에러/리셋 처리합니다. (간헐적 첫 시도 실패를 사용자 개입 없이 복구)
        if (!this.isReconnecting) {
            const attemptTimeout = this.joinHandshakeRetries > 0
                ? ParticipantManager.JOIN_HANDSHAKE_RETRY_TIMEOUT_MS
                : ParticipantManager.JOIN_HANDSHAKE_TIMEOUT_MS;
            this.armJoinHandshakeTimeout(roomName, userName, attemptTimeout, previousPeerId);
        }

        // 허브 생성 (게스트 모드)
        this.engine.hub.createHub(false, roomName);
    }

    /**
     * 게스트 방 입장 대기 제한시간 타이머를 정리합니다.
     */
    public clearJoinTimeout(): void {
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
            this.joinTimeout = undefined;
        }
        // 핸드셰이크가 진전(ACK 수신/연결 성공)했으므로 재시도 카운터를 초기화합니다.
        this.joinHandshakeRetries = 0;
    }

    /**
     * 게스트 초기 핸드셰이크(제어 채널 + 데이터 채널 수립) 감시 타이머를 설정합니다.
     * 제한 시간 안에 연결되지 않으면 같은 방으로 한 번 더 자동 재시도하고, 재시도까지 실패하면 세션을 리셋합니다.
     * @param roomName 참여할 방 이름.
     * @param userName 사용자 닉네임.
     * @param timeoutMs 이번 시도의 제한 시간(ms).
     * @param previousPeerId 세션 복원 시 사용할 이전 피어 ID.
     */
    private armJoinHandshakeTimeout(roomName: string, userName: string, timeoutMs: number, previousPeerId?: string): void {
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
        }
        this.joinTimeout = setTimeout(() => {
            this.joinTimeout = undefined;
            if (this.engine.isConnected || !this.isAutoJoin || this.isReconnecting) return;
            if (this.joinHandshakeRetries < ParticipantManager.MAX_JOIN_HANDSHAKE_RETRIES) {
                this.retryJoinHandshake(roomName, userName, previousPeerId, `timeout ${timeoutMs}ms`);
                return;
            }
            this.failJoinHandshake(roomName);
        }, timeoutMs);
    }

    /**
     * 최초 입장 중 데이터 채널 ICE 가 실패(또는 원격 signal 미수신)했을 때 호출됩니다.
     * 30초 타임아웃을 기다리지 않고 즉시 핸드셰이크 재시도를 트리거합니다.
     */
    public onGuestIceFailedEarly(): void {
        if (this.engine.isHost || this.engine.isConnected || !this.isAutoJoin || this.isReconnecting) return;
        if (this.joinHandshakeRetries >= ParticipantManager.MAX_JOIN_HANDSHAKE_RETRIES) return;
        const roomName = this.pendingJoinRequest?.roomName || this.engine.roomName;
        const userName = this.pendingJoinRequest?.userName || this.engine.myName || '';
        if (!roomName || roomName === 'Untitled Room') return;
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
            this.joinTimeout = undefined;
        }
        this.retryJoinHandshake(roomName, userName, this.pendingJoinRequest?.previousPeerId, 'ICE failure');
    }

    /**
     * 같은 방으로 초기 핸드셰이크를 한 번 더 시도합니다. 재시도 타이머는 sendJoinRequest 가 다시 설정합니다.
     * @param roomName 참여할 방 이름.
     * @param userName 사용자 닉네임.
     * @param previousPeerId 세션 복원 시 사용할 이전 피어 ID.
     * @param reason 재시도 사유(로그용).
     */
    private retryJoinHandshake(roomName: string, userName: string, previousPeerId: string | undefined, reason: string): void {
        this.joinHandshakeRetries++;
        const attemptNo = this.joinHandshakeRetries + 1;
        Logger.get().warn('GuestJoin', `Initial handshake retry (reason: ${reason}). Auto-retrying connection (attempt ${attemptNo}).`);
        this.engine.logToUI(`초기 연결이 지연되어 자동으로 재시도합니다. (사유: ${reason}, 시도 ${attemptNo}회)`);
        this.engine.setJoinStage('join-retry', `연결이 지연되어 자동으로 재시도합니다. (시도 ${attemptNo}회)`);
        // 이전 시도의 소켓/피어를 정리하고 같은 방으로 새로 연결합니다.
        this.engine.hub.dispose();
        void this.sendJoinRequest(roomName, userName, previousPeerId);
    }

    /**
     * 초기 핸드셰이크가 자동 재시도까지 실패했을 때 세션을 정리하고 사용자에게 알립니다.
     * @param roomName 참여하려던 방 이름.
     */
    private failJoinHandshake(roomName: string): void {
        const totalSec = Math.round((ParticipantManager.JOIN_HANDSHAKE_TIMEOUT_MS + ParticipantManager.JOIN_HANDSHAKE_RETRY_TIMEOUT_MS) / 1000);
        Logger.get().error('GuestJoin', `Initial connection handshake timeout (${totalSec}s) reached for room "${roomName}" after auto-retry. P2P ICE hole punching failed.`);
        this.engine.logToUI(`Initial connection handshake timeout (${totalSec}s): STUN/TURN 연결 시도가 제한 시간을 초과했습니다.`);
        this.engine.setJoinStage('failed', `연결 시간이 초과되었습니다. (${totalSec}초)`);
        vscode.window.showErrorMessage(`호스트 연결 시간이 초과되었습니다. 호스트 상태와 네트워크 연결을 확인해 주세요. (STUN/TURN 연결 ${totalSec}초 초과)`);
        this.engine.reset();
        this.engine.hub.dispose();
    }

    /**
     * ACK 확인 기반으로 호스트에게 방 참여 요청(JOIN_REQUEST)을 발송하고,
     * ACK가 올 때까지 주기적으로 재전송합니다 (게스트 전용).
     * @param reqData 요청 데이터 (사용자 이름, 피어 ID, 이전 피어 ID, 재접속 토큰).
     */
    public startJoinRequestWithAck(reqData: { name: string, peerId: string, previousPeerId?: string, reconnectToken: string }): void {
        this.stopJoinRequestRetry();
        this.isJoinRequestAckReceived = false;

        let attempts = 0;
        const maxAttempts = 5;

        Logger.get().step('GuestJoin', 3, 5, `Sending JOIN_REQUEST packet to host (peerId=${reqData.peerId}, name="${reqData.name}")`);

        const sendAndSchedule = () => {
            if (this.isJoinRequestAckReceived || this.engine.isConnected || !this.isAutoJoin) {
                this.stopJoinRequestRetry();
                return;
            }

            attempts++;
            Logger.get().info('GuestJoin', `JOIN_REQUEST transmit attempt ${attempts}/${maxAttempts}`);
            this.engine.logToUI(`Sending JOIN_REQUEST to host (attempt ${attempts}/${maxAttempts})...`);
            vscode.window.setStatusBarMessage(`호스트에게 참여 요청 전달 중... (${attempts}/${maxAttempts})`, 2500);

            this.engine.sendMessage('JOIN_REQUEST', reqData);

            if (attempts < maxAttempts) {
                this.joinRequestRetryTimer = setTimeout(sendAndSchedule, 1800);
            } else {
                Logger.get().warn('GuestJoin', `Max JOIN_REQUEST attempts (${maxAttempts}) reached. Awaiting host response...`);
                this.engine.logToUI(`Max JOIN_REQUEST attempts reached (${maxAttempts}). Waiting for host response...`);
            }
        };

        sendAndSchedule();
    }

    /** 호스트로부터 참여 요청 접수 확인(ACK)을 수신했을 때 호출됩니다 (게스트 전용). */
    public handleJoinRequestAck(): void {
        if (this.engine.isHost) return;
        this.isJoinRequestAckReceived = true;
        this.stopJoinRequestRetry();
        this.clearJoinTimeout();

        Logger.get().step('GuestJoin', 4, 5, `Host ACK received. Awaiting host approval...`);
        this.engine.logToUI(`JOIN_REQUEST_ACK received: Host successfully received join request.`);
        this.engine.setJoinStage('approval-ack', '호스트가 요청을 확인했습니다. 승인을 기다리는 중입니다.');
        vscode.window.setStatusBarMessage(`호스트가 요청을 확인했습니다. 승인을 기다리는 중...`, 5000);
        this.engine.updateStatus('Waiting...');
        this.engine.pushUIUpdate();

        // 승인 패킷(JOIN_RESPONSE) 유실 방어를 위해 연결 완료 시까지 4초 주기로 확인(재확인) 핑 반복 유지
        if (!this.engine.isConnected) {
            const sendKeepAlivePing = () => {
                if (!this.engine.isConnected && this.isAutoJoin) {
                    this.engine.logToUI(`Sending keep-alive ping for join status to host...`);
                    this.engine.sendMessage('PING', { 
                        timestamp: Date.now(),
                        peerId: this.engine.myId,
                        name: this.engine.myName
                    });
                    this.joinRequestRetryTimer = setTimeout(sendKeepAlivePing, 4000);
                }
            };
            this.joinRequestRetryTimer = setTimeout(sendKeepAlivePing, 4000);
        }
    }

    /**
     * 참여 요청 재전송 타이머를 중지합니다.
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
     */
    public approveRequest(peerId: string): void {
        if (!this.engine.isHost) return;
        
        // 승인 시 게스트를 참가자로 추가
        const request = this.joinRequests.find(req => req.peerId === peerId);
        if (!request || !this.handleGuestJoin({
            name: request.name,
            previousPeerId: request.previousPeerId,
            reconnectToken: request.reconnectToken
        }, peerId)) {
            this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
            this.engine.pushUIUpdate();
            return;
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
     */
    public approveAllRequests(): void {
        if (!this.engine.isHost || this.joinRequests.length === 0) return;

        const requestsToApprove = [...this.joinRequests];
        this.joinRequests = [];

        requestsToApprove.forEach((req, index) => {
            // 30명 동시 승인 시 호스트 CPU 및 DataChannel 버퍼 과부하 방지를 위해 30ms 간격으로 스케줄링
            setTimeout(() => {
                const approved = this.handleGuestJoin({
                    name: req.name,
                    previousPeerId: req.previousPeerId,
                    reconnectToken: req.reconnectToken
                }, req.peerId);
                if (!approved) return;
                
                // 승인 응답 다중 전송 (네트워크 버퍼링 및 패킷 유실 원천 방지)
                this.engine.sendMessageToPeer(req.peerId, 'JOIN_RESPONSE', { approved: true });
                setTimeout(() => {
                    if (this.engine.isHost && this.participants[req.peerId]) {
                        this.engine.sendMessageToPeer(req.peerId, 'JOIN_RESPONSE', { approved: true });
                    }
                }, 200);
                setTimeout(() => {
                    if (this.engine.isHost && this.participants[req.peerId]) {
                        this.engine.sendMessageToPeer(req.peerId, 'JOIN_RESPONSE', { approved: true });
                    }
                }, 450);
            }, index * 30);
        });

        this.engine.pushUIUpdate();
    }

    /**
     * 자동 승인 모드를 설정합니다 (호스트 전용).
     * 활성화 시 현재 대기 중인 모든 요청을 즉시 일괄 승인합니다.
     * @param enabled 자동 승인 활성화 여부.
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
     */
    public rejectRequest(peerId: string): void {
        if (!this.engine.isHost) return;
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        this.peerReconnectTokens.delete(peerId);
        
        // 거절 메시지 전송
        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: false, reason: '호스트가 요청을 거절했습니다.' });
        
        // WebRTC 피어 연결 해제
        this.engine.hub.disconnectPeer(peerId);
        
        this.engine.pushUIUpdate();
    }

    /**
     * 참가자 명단 및 요청 대기열과 중복되지 않도록 필요 시 "(2)", "(3)" 등의 자동 넘버링을 부여합니다.
     * @param requestedName 사용자가 요청한 기본 닉네임.
     * @param targetPeerId 변경 대상 피어 ID (자기 자신의 기존 닉네임은 중복 검사에서 제외).
     * @returns 중복이 해결된 고유 닉네임.
     */
    public getUniqueParticipantName(requestedName: string, targetPeerId?: string): string {
        const baseName = requestedName.trim() || 'Guest';
        const otherNames = new Set<string>();

        Object.entries(this.participants).forEach(([id, p]) => {
            if (id !== targetPeerId && p && p.name) {
                otherNames.add(p.name);
            }
        });

        this.joinRequests.forEach(req => {
            if (req.peerId !== targetPeerId && req.name) {
                otherNames.add(req.name);
            }
        });

        if (!otherNames.has(baseName)) {
            return baseName;
        }

        let counter = 2;
        while (otherNames.has(`${baseName} (${counter})`)) {
            counter++;
        }
        return `${baseName} (${counter})`;
    }

    /**
     * 재접속 토큰과 일치하는 기존 참가자 ID를 찾습니다. 이전 피어 ID가 유실되거나
     * 호스트/게스트 저장 시점이 어긋나(고스트 ID·승계 지연) ID가 맞지 않아도
     * 비밀 토큰만으로 동일 게스트임을 증명할 수 있습니다.
     * @param token 게스트가 보관하던 256비트 재접속 토큰.
     * @param excludePeerId 제외할 신규 피어 ID.
     * @returns 일치하는 기존 참가자 ID 또는 undefined.
     */
    private findPeerIdByReconnectToken(token: string, excludePeerId?: string): string | undefined {
        if (!token) return undefined;
        for (const [id, stored] of this.peerReconnectTokens) {
            if (id === excludePeerId) continue;
            if (stored === token && this.participants[id]) return id;
        }
        return undefined;
    }

    /**
     * 이전 피어 ID를 우선 사용하고, 맞지 않으면 토큰 역추적으로 재접속 대상을 해석합니다.
     * @param previousPeerId 게스트가 신고한 이전 피어 ID.
     * @param token 재접속 토큰.
     * @param newPeerId 이번에 할당된 신규 피어 ID.
     * @returns 승계 대상 기존 참가자 ID 또는 undefined.
     */
    private resolveReconnectPeerId(previousPeerId: string | undefined, token: string, newPeerId: string): string | undefined {
        if (previousPeerId && previousPeerId !== newPeerId && this.participants[previousPeerId] &&
            this.peerReconnectTokens.get(previousPeerId) === token) {
            return previousPeerId;
        }
        return this.findPeerIdByReconnectToken(token, newPeerId);
    }

    /**
     * 호스트가 방에 참여한 게스트를 참가자 명단에 등록하고 최신 공유 파일 스냅샷과 데코레이션을 전송합니다.
     * 창 새로고침 등으로 재연결된 게스트인 경우 비밀 토큰을 확인한 뒤 이전 권한과 파일 담당자 상태를 승계합니다.
     * @param msg 게스트 참여 메시지 (사용자 이름, 이전 피어 ID, 재접속 토큰 등).
     * @param peerId 신규 접속한 게스트의 피어 ID.
     * @returns 참가자 등록 성공 여부.
     */
    public handleGuestJoin(msg: any, peerId: string): boolean {
        if (this.engine.isHost) { 
            const rawGuestName = msg.name || peerId;
            const previousPeerId = typeof msg.previousPeerId === 'string' ? msg.previousPeerId : undefined;
            const requestToken = typeof msg.reconnectToken === 'string' ? msg.reconnectToken : '';
            const assignedToken = this.peerReconnectTokens.get(peerId);

            // 1. 재접속 토큰이 일치하는 이전 참가자만 권한을 승계합니다.
            //    (이전 피어 ID가 유실·불일치하면 토큰 역추적으로 보정합니다.)
            const oldPeerId = this.resolveReconnectPeerId(previousPeerId, requestToken, peerId);
            const isCurrentPeer = !!this.participants[peerId] && assignedToken === requestToken;
            if (assignedToken !== requestToken && !oldPeerId) {
                this.engine.logToUI(`Rejected guest join from ${peerId}: invalid reconnect token.`);
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', {
                    approved: false,
                    reason: '재접속 인증 정보가 유효하지 않습니다.'
                });
                return false;
            }

            const reconnectToken = oldPeerId ? this.peerReconnectTokens.get(oldPeerId) : assignedToken;
            if (!reconnectToken) {
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', {
                    approved: false,
                    reason: '재접속 인증 정보가 유효하지 않습니다.'
                });
                return false;
            }

            // 2. 세션 복원 시 기존 권한 승계 또는 신규 생성 (동일 이름 중복 방지를 위해 자동 넘버링 적용)
            const existingPermission = (isCurrentPeer ? this.participants[peerId] : undefined) ||
                (oldPeerId ? this.participants[oldPeerId] : undefined);
            const guestName = existingPermission ? (existingPermission.name || rawGuestName) : this.getUniqueParticipantName(rawGuestName, peerId);
            this.participants[peerId] = existingPermission 
                ? { ...existingPermission, name: guestName, connectionStatus: 'connected' }
                : { name: guestName, globalCanEdit: false, filePermissions: {}, connectionStatus: 'connected' };
            this.peerReconnectTokens.set(peerId, reconnectToken);
            this.lastPongTimes.set(peerId, Date.now());
            this.reconnectStartTimes.delete(peerId);
            this.clearHostGraceTimer(peerId);

            Logger.get().step('HostApprove', 1, 4, `Registered participant: ${guestName} (${peerId})${oldPeerId ? ` [reconnected from ${oldPeerId}]` : ''}`);

            // 3. 중복 생성 방지를 위해 이전 피어 ID 정보 정리
            if (oldPeerId && oldPeerId !== peerId) {
                this.clearHostGraceTimer(oldPeerId);
                delete this.participants[oldPeerId];
                this.peerReconnectTokens.delete(oldPeerId);
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

            Logger.get().step('HostApprove', 2, 4, `Broadcasting updated user list to all peers`);
            this.broadcastUserList(); 
            
            // 승계된 쓰기 권한이 있는 경우 해당 피어에게 SET_PERMISSION을 즉시 발송하여 권한 복구 보장
            if (existingPermission && (existingPermission.globalCanEdit || Object.keys(existingPermission.filePermissions || {}).length > 0)) {
                this.engine.sendMessageToPeer(peerId, 'SET_PERMISSION', { permission: existingPermission });
            }

            // 4. 승인 응답(JOIN_RESPONSE)을 파일 스냅샷 전송 전에 선제 발송하여 게스트의 대기 상태를 즉시 해제
            Logger.get().step('HostApprove', 3, 4, `Sending JOIN_RESPONSE (approved=true) to ${peerId}`);
            this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });

            // 5. 새로 들어온 게스트에게 현재 공유 중인 모든 파일 스냅샷 및 Yjs 상태 전송
            Logger.get().step('HostApprove', 4, 4, `Sending initial snapshots and decorations to ${peerId}`);
            this.sendInitialSnapshotsToPeer(peerId);

            // 6. 현재 데코레이션 목록 전송 (비공개 처리 적용)
            const peerDecos = this.engine.decorationManager.decorations.filter(d => d.visibility !== 'host' || d.creatorId === peerId);
            this.engine.sendMessageToPeer(peerId, 'SYNC_DECORATIONS', { decorations: peerDecos });
            return true;
        }
        return false;
    }

    /**
     * 특정 피어에게 현재 공유 중인 모든 파일(또는 누락된 특정 파일)의 최신 스냅샷과 Yjs 상태를 안전하게 전송합니다 (호스트 전용).
     * @param peerId 대상 게스트 피어 ID
     * @param targetFiles 특정 파일만 선별 전송할 경우의 파일명 배열 (생략 시 전체 파일)
     */
    public sendInitialSnapshotsToPeer(peerId: string, targetFiles?: string[]): void {
        if (!this.engine.isHost) return;

        const filesToSend = targetFiles && targetFiles.length > 0
            ? this.engine.fileStorageManager.sharedFiles.filter(f => targetFiles.includes(f.name))
            : this.engine.fileStorageManager.sharedFiles;

        filesToSend.forEach((f, idx) => {
            // 파일이 여러 개일 경우 채널 과부하 방지를 위해 순차 발송 (idx * 40ms)
            setTimeout(() => {
                if (!this.engine.isHost || !this.participants[peerId]) return;
                try {
                    // 스냅샷 내용은 예약 시점이 아니라 실제 전송 시점에 읽습니다.
                    // (예약 후 전송 전에 발생한 편집이 스냅샷에서 누락되어 유실되는 것을 방지)
                    const ydoc = this.engine.documentSyncManager.yDocs.get(f.name);
                    const ytext = this.engine.documentSyncManager.yTexts.get(f.name);
                    const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, f.path));
                    const rawContent = ytext ? ytext.toString() : (doc ? doc.getText() : fs.readFileSync(f.path, 'utf8'));
                    const content = normalizeEOL(rawContent);
                    const yjsState = ydoc ? Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64') : undefined;

                    this.engine.sendMessageToPeer(peerId, 'INIT_SNAPSHOT', {
                        fileName: f.name,
                        content,
                        yjsState,
                        assigneeId: f.assigneeId,
                        assigneeName: f.assigneeName
                    });
                } catch (e) {
                    this.engine.logToUI(`Failed to send INIT_SNAPSHOT for ${f.name}: ${e}`);
                }
            }, idx * 40);
        });
    }

    /**
     * 호스트가 특정 피어의 권한을 설정하고 해당 피어 및 전체 참가자에게 알립니다.
     * @param peerId 대상 피어 ID.
     * @param permission 설정할 권한 객체.
     */
    public setPeerPermission(peerId: string, permission: PeerPermission): void {
        if (!this.engine.isHost) return;

        // participants 목록 업데이트
        this.participants[peerId] = permission;
        
        // 해당 피어에게 SET_PERMISSION 메시지 전송 (패킷 유실 방지를 위해 다중 발송 보강)
        this.engine.sendMessageToPeer(peerId, 'SET_PERMISSION', { permission });
        setTimeout(() => {
            if (this.engine.isHost && this.participants[peerId]) {
                this.engine.sendMessageToPeer(peerId, 'SET_PERMISSION', { permission });
            }
        }, 150);
        
        // 전체 사용자 목록 갱신 브로드캐스트 (USER_LIST_UPDATE를 통한 2차 자가 치유)
        this.broadcastUserList();
        this.engine.logToUI(`Permission set for ${peerId}: Global=${permission.globalCanEdit}`);
        this.engine.cursorManager.refreshAllDecorations();
    }

    /**
     * 호스트가 모든 게스트의 쓰기 권한을 일괄 해제(읽기 전용 전환)하고 파일 담당자 지정을 초기화합니다.
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
     */
    public inviteGuest(isSilent: boolean = false): void {
        if (!this.engine.isHost) return;
        // 새로운 피어 ID 생성
        const newPeerId = `guest_${Date.now()}_${++this.inviteSeq}`;
        this.getOrCreatePeerReconnectToken(newPeerId);
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
     */
    public changeMyName(newName: string): void {
        const trimmedNewName = newName.trim();
        if (!trimmedNewName) return;

        const myEffectiveId = this.engine.isHost ? 'host' : this.engine.myId;
        const isDuplicate = Object.entries(this.participants).some(([id, data]) => {
            const isSelf = (myEffectiveId && id === myEffectiveId) || (this.engine.myId && id === this.engine.myId);
            return !isSelf && data && data.name === trimmedNewName;
        });
        
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

            // 호스트가 담당자로 지정된 파일의 assigneeName 갱신 및 브로드캐스트
            this.engine.fileStorageManager.sharedFiles.forEach(f => {
                if (f.assigneeId === 'host') {
                    f.assigneeName = trimmedNewName;
                    this.engine.sendMessage('FILE_ASSIGNEE_UPDATE', {
                        fileName: f.name,
                        assigneeId: 'host',
                        assigneeName: trimmedNewName
                    });
                }
            });
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
     * 참가자 명단과 최신 방 이름, 공유 중인 파일 목록을 모든 피어에게 브로드캐스트합니다 (호스트 전용).
     * 30명 동시 접속 시 네트워크 대역폭 보호를 위해 80ms 디바운스를 적용합니다.
     * @param immediate true인 경우 디바운스 없이 즉시 전송합니다.
     */
    public broadcastUserList(immediate: boolean = false): void {
        if (!this.engine.isHost) {
            this.engine.pushUIUpdate();
            return;
        }

        if (immediate) {
            if (this.broadcastUserListDebounceTimer) {
                clearTimeout(this.broadcastUserListDebounceTimer);
                this.broadcastUserListDebounceTimer = undefined;
            }
            this.executeBroadcastUserList();
            return;
        }

        if (this.broadcastUserListDebounceTimer) {
            return;
        }

        this.broadcastUserListDebounceTimer = setTimeout(() => {
            this.broadcastUserListDebounceTimer = undefined;
            this.executeBroadcastUserList();
        }, 80);
    }

    /** 참가자 목록(USER_LIST_UPDATE)을 실제로 전송하고 UI를 갱신합니다(디바운스 우회 경로에서도 호출). */
    private executeBroadcastUserList(): void {
        if (this.engine.isHost) {
            // 'default' ID를 제외한 참가자 목록 생성
            const filteredParticipants = { ...this.participants };
            delete filteredParticipants['default'];
            const sharedFileNames = this.engine.fileStorageManager.sharedFiles.map(f => f.name);
            // 사용자 목록 및 방 이름, 공유 파일 목록 업데이트 메시지 전송
            this.engine.sendMessage('USER_LIST_UPDATE', { 
                users: filteredParticipants, 
                roomName: this.engine.roomName,
                sharedFileNames
            });
        }
        this.engine.pushUIUpdate();
    }

    /**
     * 특정 피어를 강제로 방에서 퇴장시키고 WebRTC 연결을 종료합니다 (호스트 전용).
     * @param peerId 퇴장시킬 피어 ID.
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

        // 로컬에서 즉시 영구 제거 및 리소스 정리
        this.removePeerPermanently(peerId);
        vscode.window.showInformationMessage(`"${targetName}" 사용자를 방에서 퇴장시켰습니다.`);
    }

    /**
     * 피어 연결 해제 이벤트를 처리합니다.
     * 게스트의 경우 호스트 단절 시 45초 유예 모드로 진입하며,
     * 호스트의 경우 즉시 삭제하지 않고 45초간 'reconnecting' 유예 상태로 유지하여 게스트의 복귀를 대기합니다.
     * @param peerId 연결이 해제된 피어 ID.
     */
    public handlePeerDisconnect(peerId: string): void {
        if (!this.engine.isHost) {
            // 게스트일 경우: 이미 성공적으로 승인받아 접속 중이었던 경우에만(호스트의 창 갱신/복구 등) 45초 재연결 유예 모드로 진입
            // (최초 승인 대기 중이거나 핸드셰이크 단계에서의 일시 단절 시 재연결 화면으로 튀지 않도록 방어)
            if (this.hasJoinedSuccessfully && !this.isReconnecting && this.engine.roomName && this.engine.roomName !== 'Untitled Room') {
                this.startGuestReconnectGracePeriod();
            } else if (this.isReconnecting) {
                // 이미 재연결 유예 모드 진행 중인데 물리 채널이 끊어졌다면 즉시 다음 프로브 스케줄링
                this.onGuestReconnectProbeFailed();
            } else if (!this.hasJoinedSuccessfully) {
                // 승인 대기 중이거나 방 입장 시도 중인 경우: 방 폭파/재연결 화면 진입 없이 호스트 응답 또는 재전송 대기
                Logger.get().info('GuestJoin', `Peer disconnected before approval. Waiting for host or next connection attempt.`);
            } else {
                this.engine.reset(); 
            }
        } else {
            // 호스트일 경우: 물리 채널이 끊겨도 곧바로 삭제하지 않고 45초 유예 상태('reconnecting')로 유지합니다.
            // 이 유예 동안 재접속 토큰을 보존해야 창이 복구된 게스트가 자동으로 승계될 수 있습니다.
            const isParticipant = !!this.participants[peerId];
            const isJoinRequest = this.joinRequests.some(req => req.peerId === peerId);

            if (isJoinRequest) {
                this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
                this.engine.pushUIUpdate();
            }

            if (isParticipant) {
                Logger.get().info('Host', `Guest ${peerId} disconnected. Holding participant for 45s reconnect grace.`);
                this.markPeerReconnecting(peerId);
            } else {
                this.peerReconnectTokens.delete(peerId);
                this.pendingInvites.delete(peerId);
            }
        }
    }

    /**
     * 호스트가 게스트의 물리 채널 단절을 감지했을 때 참가자와 재접속 토큰을 보존한 채
     * 'reconnecting' 상태로 전환하고, 유예 시간(45초)이 지나면 제거를 예약합니다 (호스트 전용).
     * 유예 중 게스트가 재접속하면 토큰 승계로 즉시 자동 승인됩니다.
     * @param peerId 단절된 피어 ID.
     */
    public markPeerReconnecting(peerId: string): void {
        if (!this.engine.isHost) return;
        const perm = this.participants[peerId];
        if (!perm) return;

        const now = Date.now();
        if (!this.reconnectStartTimes.has(peerId)) {
            this.reconnectStartTimes.set(peerId, now);
        }

        if (perm.connectionStatus !== 'reconnecting') {
            perm.connectionStatus = 'reconnecting';
            this.broadcastUserList();
        }

        // 유예 시작 시점 기준으로 남은 시간만큼만 제거를 예약합니다(이미 예약되어 있으면 재조정).
        this.clearHostGraceTimer(peerId);
        const elapsed = now - (this.reconnectStartTimes.get(peerId) || now);
        const remaining = Math.max(0, ParticipantManager.HOST_RECONNECT_GRACE_MS - elapsed);
        this.hostGraceTimers.set(peerId, setTimeout(() => {
            this.hostGraceTimers.delete(peerId);
            const current = this.participants[peerId];
            if (current && current.connectionStatus === 'reconnecting') {
                this.engine.logToUI(`재연결 유예(45초)가 만료되어 ${current.name || peerId}님을 명단에서 제거합니다.`);
                this.removePeerPermanently(peerId);
            }
        }, remaining));

        this.engine.pushUIUpdate();
    }

    /**
     * 특정 피어의 재연결 유예 만료 타이머를 취소합니다.
     * @param peerId 타이머를 취소할 피어 ID.
     */
    private clearHostGraceTimer(peerId: string): void {
        const timer = this.hostGraceTimers.get(peerId);
        if (timer) {
            clearTimeout(timer);
            this.hostGraceTimers.delete(peerId);
        }
    }

    /**
     * 재연결 유예 시간(45초)을 초과한 피어를 참가자 명단에서 완전히 삭제하고 정리합니다 (호스트 전용).
     * @param peerId 삭제할 피어 ID.
     */
    public removePeerPermanently(peerId: string): void {
        if (!this.engine.isHost) return;
        this.clearHostGraceTimer(peerId);

        const isParticipant = !!this.participants[peerId];
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
            this.peerReconnectTokens.delete(peerId);
            this.lastPongTimes.delete(peerId);
            this.reconnectStartTimes.delete(peerId);
            
            // 퇴장한 피어가 독점 담당자로 지정되어 있던 파일들의 잠금 해제 및 브로드캐스트
            this.engine.fileStorageManager.sharedFiles.forEach(f => {
                if (f.assigneeId === peerId) {
                    f.assigneeId = undefined;
                    f.assigneeName = undefined;
                    this.engine.sendMessage('FILE_ASSIGNEE_UPDATE', {
                        fileName: f.name,
                        assigneeId: undefined,
                        assigneeName: undefined
                    });
                }
            });

            // 해당 피어의 데코레이션 및 색상 정리
            this.engine.decorationManager.decorations = this.engine.decorationManager.decorations.filter(d => d.creatorId !== peerId);
            this.engine.decorationManager.refreshDecorationsInEditors();
            this.engine.decorationManager.broadcastDecorations();
            this.engine.cursorManager.clearPeerCursor(peerId);
            this.broadcastUserList();
            this.engine.pushUIUpdate();
        }
    }

    /**
     * 게스트로부터 방 참여 요청을 수신했을 때 ACK를 전송하고 자동 승인 또는 요청 대기열에 추가합니다 (호스트 전용).
     * @param msg 수신된 참여 요청 메시지 (이름, 이전 피어 ID, 재접속 토큰 등).
     * @param peerId 요청한 게스트 피어 ID.
     */
    public handleJoinRequest(msg: any, peerId: string): void {
        if (this.engine.isHost) {
            const rawGuestName = msg.name || peerId;
            const previousPeerId = typeof msg.previousPeerId === 'string' ? msg.previousPeerId : undefined;
            const reconnectToken = typeof msg.reconnectToken === 'string' ? msg.reconnectToken : '';
            const assignedToken = this.peerReconnectTokens.get(peerId);
            // 이전 피어 ID와 토큰이 모두 맞으면 그대로, ID가 어긋나면 토큰 역추적으로 승계 대상을 보정합니다.
            const matchedPreviousPeerId = this.resolveReconnectPeerId(previousPeerId, reconnectToken, peerId);
            const effectivePreviousPeerId = matchedPreviousPeerId || previousPeerId;
            const tokenMatchesPreviousPeer = !!matchedPreviousPeerId;

            if (assignedToken !== reconnectToken && !tokenMatchesPreviousPeer) {
                this.engine.logToUI(`Rejected JOIN_REQUEST from ${peerId}: invalid reconnect token.`);
                this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', {
                    approved: false,
                    reason: '재접속 인증 정보가 유효하지 않습니다.'
                });
                return;
            }

            // 0. 게스트에게 요청이 정상 도착했음을 알리는 ACK 즉시 회신 (게스트 재전송 중지 유도)
            this.engine.sendMessageToPeer(peerId, 'JOIN_REQUEST_ACK', { received: true });

            // 같은 피어 ID이거나 이전 피어의 비밀 토큰이 확인된 경우에만 기존 참가자로 판정합니다.
            const existingParticipant = (assignedToken === reconnectToken ? this.participants[peerId] : undefined) ||
                (matchedPreviousPeerId ? this.participants[matchedPreviousPeerId] : undefined);

            // 호스트 창 전환 후 재접속한 기존 게스트이거나 자동 승인 모드인 경우 즉시 승인
            if (existingParticipant || this.isAutoApprove) {
                // 이전 대기열에 동일 피어 ID나 이전 피어 ID의 요청이 남아있다면 정리
                this.joinRequests = this.joinRequests.filter(req =>
                    req.peerId !== peerId && (!effectivePreviousPeerId || req.peerId !== effectivePreviousPeerId)
                );

                const finalName = existingParticipant 
                    ? (existingParticipant.name || rawGuestName) 
                    : this.getUniqueParticipantName(rawGuestName, peerId);

                const approved = this.handleGuestJoin({ name: finalName, previousPeerId: effectivePreviousPeerId, reconnectToken }, peerId);
                if (!approved) return;
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
                    vscode.window.showInformationMessage(`재연결 승인: ${finalName} (${peerId})`);
                } else {
                    vscode.window.showInformationMessage(`방 참여 자동 승인: ${finalName} (${peerId})`);
                }
                this.engine.pushUIUpdate();
            } else {
                // 수동 승인 모드인 경우 요청 대기열에서도 중복 없는 고유 이름 할당
                const finalName = this.getUniqueParticipantName(rawGuestName, peerId);

                // 이미 대기 중인 요청이 있다면 정보만 갱신(중복 알림 및 중복 리스트 방지)
                const existingIndex = this.joinRequests.findIndex(req => req.peerId === peerId);
                if (existingIndex >= 0) {
                    this.joinRequests[existingIndex] = {
                        peerId,
                        name: finalName,
                        previousPeerId,
                        reconnectToken,
                        timestamp: Date.now()
                    };
                } else {
                    this.joinRequests.push({
                        peerId,
                        name: finalName,
                        previousPeerId,
                        reconnectToken,
                        timestamp: Date.now()
                    });
                    vscode.window.showInformationMessage(`방 참여 요청: ${finalName} (${peerId})`);
                }
                this.engine.pushUIUpdate();
            }
        }
    }

    /**
     * 호스트로부터 방 참여 승인/거절 응답을 수신하여 세션을 연결하거나 리셋합니다 (게스트 전용).
     * @param msg 수신된 승인/거절 메시지 객체.
     */
    public async handleJoinResponse(msg: any): Promise<void> {
        if (!this.engine.isHost) {
            this.stopJoinRequestRetry();
            if (msg.approved) {
                Logger.get().step('GuestJoin', 5, 5, `Join approved! Establishing session for room "${this.engine.roomName}".`);
                this.stopGuestReconnectGracePeriod();
                this.hasJoinedSuccessfully = true;
                this.engine.isConnected = true;
                // 수동 SDP 교환 화면(isSetupMode)에 머무르지 않고 승인 즉시 방 화면으로 전환합니다.
                this.engine.isSetupMode = false;
                this.isAutoJoin = false;
                this.engine.updateStatus('Connected');
                this.engine.pushUIUpdate();
                vscode.window.showInformationMessage("방 참여가 승인되었습니다!");
                // 에디터 락 해제 및 최신 권한 적용
                await this.engine.fileStorageManager.updateAllReadonlyStates();
            } else if (this.isReconnecting) {
                // 재연결 유예 중의 거절은 호스트/게스트 저장 시점 차이(고스트 ID·토큰 승계 지연)로
                // 일시적으로 발생할 수 있으므로, 즉시 퇴장시키지 않고 남은 유예 시간 동안 다음 프로브를 시도합니다.
                Logger.get().warn('GuestJoin', `Join rejected during reconnect grace: ${msg.reason || 'No reason provided'}. Scheduling next probe.`);
                this.engine.logToUI(`재연결 승인이 아직 확인되지 않았습니다(${msg.reason || '사유 없음'}). 잠시 후 다시 시도합니다...`);
                this.onGuestReconnectProbeFailed();
                return;
            } else {
                Logger.get().warn('GuestJoin', `Join rejected by host: ${msg.reason || 'No reason provided'}`);
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
     * 호스트 일시 단절 감지 시 45초 동안 에디터를 잠그고 조용히 재접속을 시도하는 유예 기간(Grace Period)을 시작합니다 (게스트 전용).
     */
    public async startGuestReconnectGracePeriod(): Promise<void> {
        this.isReconnecting = true;
        this.engine.isConnected = false;
        this.engine.updateStatus('Reconnecting...');
        Logger.get().step('Reconnect', 1, 3, `Host connection lost. Entering 45s grace period and locking editor.`);
        this.engine.logToUI(`Host connection lost temporarily. Entering 45s grace period and locking editor...`);

        // 1. 게스트 에디터 일시 잠금 (오프라인 타이핑 유실 및 충돌 100% 방지)
        for (const file of this.engine.fileStorageManager.sharedFiles) {
            const editor = vscode.window.visibleTextEditors.find(e => isPathEqual(e.document.uri.fsPath, file.path));
            if (editor) {
                await this.engine.fileStorageManager.applyEditorReadonlyState(editor, true);
            }
        }
        vscode.window.setStatusBarMessage(`🔒 호스트 작업 공간 전환 중... 재연결 대기 (최대 45초)`, 45000);

        // 2. 45초 전체 타임아웃 타이머 설정 (창 복구, 시그널링 서버 등록 지연 감안)
        if (this.reconnectDeadlineTimer) clearTimeout(this.reconnectDeadlineTimer);
        this.reconnectDeadlineTimer = setTimeout(async () => {
            Logger.get().error('Reconnect', `Grace period timeout (45s) exceeded. Disposing session.`);
            this.engine.logToUI(`Host reconnection timeout exceeded (45s).`);
            vscode.window.showErrorMessage("호스트가 세션을 종료했거나 재연결 제한 시간(45초)을 초과했습니다.");
            this.stopGuestReconnectGracePeriod();

            // 로컬 임시 파일/폴더 삭제 및 세션 영구 정리
            await this.engine.fileStorageManager.clearLocalStorage();
            await this.engine.sessionRecoveryManager.clearSession();

            this.engine.reset();
            this.engine.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }, 45000);

        // 3. 간격을 두고 호스트에게 재연결(노크) 시도 및 상태 메시지 갱신
        const savedRoomName = this.engine.roomName;
        const savedName = this.engine.myName;
        if (!this.reconnectOriginalPeerId && this.engine.myId && this.engine.myId !== 'default') {
            this.reconnectOriginalPeerId = this.engine.myId;
        }
        const originalId = this.reconnectOriginalPeerId || this.engine.myId;
        const startTime = Date.now();
        this.isProbeInFlight = false;

        const tryReconnect = () => {
            if (!this.isReconnecting) return;
            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const remainingSec = Math.max(0, 45 - elapsedSec);
            vscode.window.setStatusBarMessage(`🔒 호스트 작업 공간 전환 중... 재연결 대기 (${remainingSec}초 남음)`, 3000);

            // 이미 연결 핸드셰이크가 진행 중이면 소켓을 파괴하지 않고 진행 완료를 기다림
            if (this.isProbeInFlight) {
                this.engine.logToUI(`Reconnection probe already in progress (${elapsedSec}s elapsed), waiting...`);
                this.reconnectRetryTimer = setTimeout(tryReconnect, 2000);
                return;
            }

            this.engine.logToUI(`Attempting to reconnect to host room "${savedRoomName}" with originalId "${originalId}" (${elapsedSec}s elapsed)...`);
            this.isProbeInFlight = true;
            if (this.probeInFlightTimeout) clearTimeout(this.probeInFlightTimeout);
            this.probeInFlightTimeout = setTimeout(() => {
                if (this.isReconnecting && this.isProbeInFlight) {
                    this.engine.logToUI(`Reconnection probe safety timeout (6s) reached. Resetting probe lock for next attempt...`);
                    this.isProbeInFlight = false;
                }
            }, 6000);

            this.engine.hub.dispose();
            this.sendJoinRequest(savedRoomName, savedName, originalId);

            // 다수의 게스트가 동시에 몰려 발생하는 충돌(Phase-lock)을 방지하기 위해 랜덤 지터(Jitter) 적용
            const jitter = Math.floor(Math.random() * 1500);
            const nextInterval = (elapsedSec < 12 ? 3000 : 4000) + jitter;
            this.reconnectRetryTimer = setTimeout(tryReconnect, nextInterval);
        };

        this.tryReconnectFn = tryReconnect;

        // 호스트 소켓 정리 및 새 방 등록 완료를 대기한 뒤 첫 재시도 (2000ms + 무작위 지터)
        const initialJitter = Math.floor(Math.random() * 1000);
        this.reconnectRetryTimer = setTimeout(tryReconnect, 1800 + initialJitter);
    }

    /**
     * WebRTC 데이터 채널이 성공적으로 열렸을 때 호출되어 재연결 프로브 타이머를 일시 정지하고 호스트 승인을 기다립니다.
     */
    public pauseGuestReconnectProbe(): void {
        if (!this.isReconnecting) return;
        Logger.get().step('Reconnect', 2, 3, `WebRTC channel reconnected! Pausing retry probe, awaiting host approval.`);
        this.engine.logToUI(`WebRTC data channel connected during grace period. Pausing reconnect retry timer and waiting for host approval...`);
        this.isProbeInFlight = true;
        if (this.reconnectRetryTimer) {
            clearTimeout(this.reconnectRetryTimer);
            this.reconnectRetryTimer = undefined;
        }
        if (this.probeInFlightTimeout) {
            clearTimeout(this.probeInFlightTimeout);
            this.probeInFlightTimeout = undefined;
        }
    }

    /**
     * 게스트 재연결 프로브가 실패(호스트 미준비/오프라인)했음을 통보받았을 때 즉시 호출되어 1.5~2.5초 후 다음 시도를 트리거합니다.
     */
    public onGuestReconnectProbeFailed(): void {
        if (!this.isReconnecting) return;
        Logger.get().warn('Reconnect', `Probe attempt failed (host not ready). Scheduling next retry probe.`);
        this.isProbeInFlight = false;
        if (this.probeInFlightTimeout) {
            clearTimeout(this.probeInFlightTimeout);
            this.probeInFlightTimeout = undefined;
        }
        if (this.reconnectRetryTimer) {
            clearTimeout(this.reconnectRetryTimer);
        }
        // 실패 시 즉시 허브를 정리하고 1.2초~2.0초 지터 대기 후 다음 재시도 프로브 트리거
        this.engine.hub.dispose();
        const retryDelay = 1200 + Math.floor(Math.random() * 800);
        this.reconnectRetryTimer = setTimeout(() => {
            if (this.isReconnecting && this.tryReconnectFn) {
                this.tryReconnectFn();
            }
        }, retryDelay);
    }

    /**
     * 재연결 성공 또는 최종 타임아웃 시 유예 타이머 및 관련 상태를 정리하고 에디터 읽기 전용 락을 해제합니다.
     */
    public async stopGuestReconnectGracePeriod(): Promise<void> {
        this.isReconnecting = false;
        this.isProbeInFlight = false;
        this.tryReconnectFn = undefined;
        if (this.probeInFlightTimeout) {
            clearTimeout(this.probeInFlightTimeout);
            this.probeInFlightTimeout = undefined;
        }
        this.reconnectOriginalPeerId = undefined;
        this.stopJoinRequestRetry();
        if (this.reconnectRetryTimer) {
            clearTimeout(this.reconnectRetryTimer);
            this.reconnectRetryTimer = undefined;
        }
        if (this.reconnectDeadlineTimer) {
            clearTimeout(this.reconnectDeadlineTimer);
            this.reconnectDeadlineTimer = undefined;
        }
        vscode.window.setStatusBarMessage('✅ 호스트에 다시 연결되었습니다.', 3000);

        // 재연결 성공 시 유예 기간 동안 걸어두었던 에디터 읽기 전용 잠금(ReadOnly)을 사용자 권한에 맞게 자동 해제
        if (!this.engine.isHost) {
            await this.engine.fileStorageManager.updateAllReadonlyStates();
            this.engine.cursorManager.refreshAllDecorations();
            this.engine.pushUIUpdate();
        }
    }

    /**
     * 호스트가 게스트들의 실시간 연결 상태를 주기적으로 확인하기 위해 Ping 타이머를 시작합니다.
     * 4초마다 검사하며, 10초 이상 응답이 없으면 'reconnecting'으로 표시하고
     * 호스트 재연결 유예(45초)가 만료된 피어만 실제로 제거합니다.
     */
    public startPingCheck(): void {
        this.stopPingCheck();
        if (!this.engine.isHost) return;

        // 4초마다 모든 게스트에게 PING 전송 및 PONG 타임아웃(10초) 검사
        this.pingTimer = setInterval(() => {
            if (!this.engine.isHost) return;

            const now = Date.now();
            let hasStatusChanged = false;

            Object.entries(this.participants).forEach(([peerId, perm], index) => {
                if (peerId === 'host' || peerId === 'default') {
                    if (perm.connectionStatus !== 'connected') {
                        perm.connectionStatus = 'connected';
                        hasStatusChanged = true;
                    }
                    return;
                }

                // 최근 3초 이내에 정상 데이터를 수신한 활성 피어는 이미 생존이 확인되었으므로 PING 패킷 전송을 생략
                const lastPong = this.lastPongTimes.get(peerId);
                const isRecentlyActive = lastPong !== undefined && (now - lastPong <= 3000);

                if (!isRecentlyActive) {
                    // 30명 동시 전송 시 트래픽 폭증 방지를 위해 20ms 지터(Jitter) 분산 발송
                    setTimeout(() => {
                        if (this.engine.isHost && this.participants[peerId]) {
                            this.engine.sendMessageToPeer(peerId, 'PING', { timestamp: Date.now() });
                        }
                    }, index * 20);
                }

                // PONG 응답 시간 검사 (마지막 활동/응답으로부터 10초 초과 시 단절로 간주)
                const isAlive = lastPong !== undefined && (now - lastPong <= 10000);
                if (!isAlive) {
                    const graceStartedAt = this.reconnectStartTimes.get(peerId);
                    // 유예 시간이 이미 만료된 재연결 대기 피어만 실제로 제거합니다.
                    if (perm.connectionStatus === 'reconnecting' && graceStartedAt !== undefined
                        && now - graceStartedAt >= ParticipantManager.HOST_RECONNECT_GRACE_MS) {
                        this.engine.logToUI(`Guest reconnect grace (45s) expired for: ${perm.name} (${peerId}). Removing.`);
                        this.removePeerPermanently(peerId);
                        return;
                    }
                    // 최초 단절이면 즉시 지우지 않고 45초 유예 상태로 전환합니다(복구된 호스트 창도 동일).
                    if (perm.connectionStatus !== 'reconnecting') {
                        this.engine.logToUI(`Guest ping timeout for: ${perm.name} (${peerId}). Holding for 45s reconnect grace.`);
                        this.markPeerReconnecting(peerId);
                    }
                }
            });

            if (hasStatusChanged) {
                this.broadcastUserList();
            }
        }, 4000);
    }

    /**
     * 실행 중인 Ping 타이머를 중지합니다.
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
     */
    public handlePong(peerId: string): void {
        if (!this.engine.isHost) return;
        this.clearHostGraceTimer(peerId);
        this.lastPongTimes.set(peerId, Date.now());
        this.reconnectStartTimes.delete(peerId);

        const perm = this.participants[peerId];

        if (perm && perm.connectionStatus !== 'connected') {
            perm.connectionStatus = 'connected';
            this.broadcastUserList();
        }
    }

    /**
     * ParticipantManager의 모든 타이머, 참가자 명단, 요청 대기열 및 연결 상태를 초기화합니다.
     */
    public reset(): void {
        this.stopPingCheck();
        if (this.broadcastUserListDebounceTimer) {
            clearTimeout(this.broadcastUserListDebounceTimer);
            this.broadcastUserListDebounceTimer = undefined;
        }
        this.hostGraceTimers.forEach(timer => clearTimeout(timer));
        this.hostGraceTimers.clear();
        this.lastPongTimes.clear();
        this.reconnectStartTimes.clear();
        this.stopGuestReconnectGracePeriod();
        this.stopJoinRequestRetry();
        this.clearJoinTimeout();
        this.isJoinRequestAckReceived = false;
        this.participants = {};
        this.joinRequests = [];
        this.pendingInvites.clear();
        this.peerReconnectTokens.clear();
        this.myReconnectToken = '';
        this.isAutoJoin = false;
        this.isAutoApprove = false;
        this.pendingJoinRequest = null;
    }
}
