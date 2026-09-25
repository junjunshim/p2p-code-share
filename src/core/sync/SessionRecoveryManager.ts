/**
 * @file SessionRecoveryManager.ts
 * @description VS Code 창 새로고침(Reload Window) 및 작업 공간 전환(Open Folder) 시
 * P2P 세션 정보(방, 파일, Yjs 상태, 권한, 채팅, 데코레이션)의 영속화 및 자동 복구를 관리합니다.
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as fs from 'fs';
import { SyncEngine } from '../SyncEngine';
import { SharedFile, PeerPermission, FileDecoration, ChatMessage } from '../../types';
import { normalizeEOL } from '../../utils/helpers';

/**
 * @interface PersistentFileSnapshot
 * @description 창 새로고침 또는 폴더 전환 시 세션 복구를 위해 영속화되는 파일 스냅샷 구조체입니다.
 */
export interface PersistentFileSnapshot {
    /** 파일 이름 (확장자 포함) */
    name: string;
    /** 로컬 파일 시스템 상의 절대 경로 */
    path: string;
    /** 원본 백업본 파일 경로 (호스트 전용, Diff 비교용) */
    source?: string;
    /** 단독 편집 권한이 할당된 사용자 ID */
    assigneeId?: string;
    /** 단독 편집 권한이 할당된 사용자 이름 */
    assigneeName?: string;
    /** 직렬화 시점의 최신 텍스트 내용 */
    content: string;
    /** Yjs CRDT 상태 벡터 업데이트 바이너리를 Base64로 인코딩한 문자열 */
    yjsStateBase64?: string;
}

/**
 * @interface PersistentSessionData
 * @description globalState에 저장되는 전체 P2P 협업 세션 데이터 구조체입니다.
 */
export interface PersistentSessionData {
    /** 참여 중인 P2P 방 이름 */
    roomName: string;
    /** 현재 사용자가 호스트인지 여부 */
    isHost: boolean;
    /** 현재 사용자의 표시 닉네임 */
    myName: string;
    /** 현재 사용자의 고유 피어 ID */
    myId: string;
    /** 게스트가 재접속 시 본인 확인에 사용하는 비밀 토큰 */
    reconnectToken?: string;
    /** 호스트가 참가자별 재접속 토큰을 비공개로 저장하는 맵 */
    participantReconnectTokens?: { [peerId: string]: string };
    /** 자동 승인 활성화 여부 */
    isAutoApprove: boolean;
    /** 팔로우 모드(호스트 화면 추종) 활성화 여부 */
    isFollowMeMode: boolean;
    /** 커서 필터링 모드 ('host' | 'editable' | 'all') */
    cursorFilter: 'host' | 'editable' | 'all';
    /** 데코레이션(리뷰 배지) 표시 여부 */
    showDecorations?: boolean;
    /** 참가자 권한 및 연결 상태 맵 */
    participants: { [key: string]: PeerPermission };
    /** 공유 중인 파일들의 영속화 스냅샷 목록 */
    sharedFiles: PersistentFileSnapshot[];
    /** 등록된 데코레이션(인라인 피드백) 목록 */
    decorations: FileDecoration[];
    /** 채팅 메시지 이력 */
    chatHistory: ChatMessage[];
    /** 현재 세션을 점유하고 있는 VS Code 창의 고유 식별자 */
    activeWindowId: string;
    /** 창 종료(새로고침 또는 창 닫기)에 의해 명시적으로 저장되었는지 여부 */
    isShuttingDown?: boolean;
    /** 마지막으로 하트비트가 갱신된 에포크 밀리초 타임스탬프 */
    lastHeartbeat: number;
}

/** globalState에 세션 정보를 저장할 때 사용하는 스토리지 키 */
const GLOBAL_SESSION_KEY = 'p2p_code_share_active_session';
/** 세션 생존 보고(하트비트) 주기 (밀리초) */
const HEARTBEAT_INTERVAL_MS = 2000;
/** 다른 창의 활성 상태를 판별하는 하트비트 만료 시간 (밀리초) */
const HEARTBEAT_TIMEOUT_MS = 4000;
/** 세션 유효 최대 수명 (1분 이상 경과 시 세션 폐기) */
const SESSION_MAX_AGE_MS = 60000;

/**
 * SessionRecoveryManager 클래스.
 * VS Code 창 새로고침(Reload Window) 및 작업 공간 전환(Open Folder) 시
 * P2P 세션 정보(방, 파일, Yjs 상태, 권한, 채팅, 데코레이션)의 영속화 및 자동 복구를 관리합니다.
 */
export class SessionRecoveryManager {
    /** 현재 VS Code 창의 고유 인스턴스 ID */
    public currentWindowId: string;

    /** 현재 세션 복구 프로세스가 진행 중인지 여부 플래그 */
    public isRestoringSession = false;

    /** 게스트 자동 복구 재시도 횟수 카운터 */
    public restoreRetryCount = 0;

    /** 주기적 세션 저장을 위한 하트비트 타이머 */
    private heartbeatTimer?: NodeJS.Timeout;

    /**
     * SessionRecoveryManager 인스턴스를 생성하고 창 고유 ID를 초기화합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     * @param context VS Code 확장 컨텍스트 (globalState 접근용).
     */
    constructor(private engine: SyncEngine, private context: vscode.ExtensionContext) {
        // 현재 창의 고유 ID 생성 (타임스탬프 + 난수)
        this.currentWindowId = `win_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    /**
     * 활성 세션 상태를 주기적으로 globalState에 저장하는 하트비트 타이머를 시작합니다.
     * @returns {void}
     */
    public startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.engine.isConnected && this.engine.roomName) {
                this.saveSession();
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    /**
     * 실행 중인 하트비트 타이머를 중단합니다.
     * @returns {void}
     */
    public stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    /**
     * 현재 활성 세션의 모든 상태(방 설정, 참가자, 파일 스냅샷, Yjs 상태, 데코레이션, 채팅)를 globalState에 저장합니다.
     * @returns {Promise<void>}
     */
    public async saveSession(isShuttingDown = false): Promise<void> {
        if (!this.engine.isConnected && !this.engine.isHost) return;
        if (!this.engine.roomName || this.engine.roomName === 'Untitled Room') return;

        // 공유 파일 스냅샷 번들링 (최신 텍스트 및 Yjs CRDT 상태)
        const fileSnapshots: PersistentFileSnapshot[] = [];
        for (const file of this.engine.fileStorageManager.sharedFiles) {
            const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
            const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
            
            let content = '';
            if (ytext) {
                content = ytext.toString();
            } else {
                try {
                    if (fs.existsSync(file.path)) {
                        content = fs.readFileSync(file.path, 'utf8');
                    }
                } catch (e) {}
            }
            content = normalizeEOL(content);

            const yjsStateBase64 = ydoc ? Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64') : undefined;

            fileSnapshots.push({
                name: file.name,
                path: file.path,
                source: file.source,
                assigneeId: file.assigneeId,
                assigneeName: file.assigneeName,
                content,
                yjsStateBase64
            });
        }

        const sessionData: PersistentSessionData = {
            roomName: this.engine.roomName,
            isHost: this.engine.isHost,
            myName: this.engine.myName,
            myId: this.engine.myId,
            reconnectToken: this.engine.isHost ? undefined : this.engine.participantManager.myReconnectToken,
            participantReconnectTokens: this.engine.isHost
                ? Object.fromEntries(this.engine.participantManager.peerReconnectTokens)
                : undefined,
            isAutoApprove: this.engine.isAutoApprove,
            isFollowMeMode: this.engine.isFollowMeMode,
            cursorFilter: this.engine.cursorManager.cursorFilter,
            showDecorations: this.engine.decorationManager.showDecorations,
            participants: this.engine.participantManager.participants,
            sharedFiles: fileSnapshots,
            decorations: this.engine.decorationManager.decorations,
            chatHistory: this.engine.chatHistory,
            activeWindowId: this.currentWindowId,
            isShuttingDown,
            lastHeartbeat: Date.now()
        };

        await this.context.globalState.update(GLOBAL_SESSION_KEY, sessionData);
    }

    /**
     * 사용자가 명시적으로 방을 종료하거나 나갔을 때 영속화된 세션을 완전히 삭제합니다.
     * @returns {Promise<void>}
     */
    public async clearSession(): Promise<void> {
        this.stopHeartbeat();
        await this.context.globalState.update(GLOBAL_SESSION_KEY, undefined);
    }

    /**
     * 창이 새로 열렸을 때 복구 가능한 이전 세션이 존재하는지 확인합니다.
     * 다른 창이 현재 활성 연결을 유지하고 있거나 타임아웃된 경우 null을 반환합니다.
     * @returns 복구 가능한 세션 데이터 객체 또는 null.
     */
    public getRecoverableSession(): PersistentSessionData | null {
        const session = this.context.globalState.get<PersistentSessionData>(GLOBAL_SESSION_KEY);
        if (!session) return null;

        const now = Date.now();
        const age = now - session.lastHeartbeat;

        // 세션이 너무 오래되었으면(1분 초과) 이미 종료된 것으로 간주하고 폐기
        if (age > SESSION_MAX_AGE_MS) {
            this.clearSession();
            return null;
        }

        // 창 새로고침/종료 시점에 명시적으로 저장된 세션(isShuttingDown === true)인 경우
        // 이전 창이 종료되었음이 확실하므로 4초 하트비트 검사를 생략하고 즉시 복구 허용
        if (session.isShuttingDown) {
            return session;
        }

        // 다른 창이 아직 활발하게 하트비트를 보내고 있다면(4초 이내) 간섭하지 않음
        if (session.activeWindowId !== this.currentWindowId && age < HEARTBEAT_TIMEOUT_MS) {
            return null;
        }

        return session;
    }

    /**
     * 이전 세션 데이터를 현재 활성 엔진 인스턴스에 복원하고 P2P 허브 또는 재연결 플로우를 재개합니다.
     * @param session 복원할 세션 데이터 객체.
     * @returns {Promise<void>}
     */
    public async restoreSession(session: PersistentSessionData): Promise<void> {
        this.isRestoringSession = true;
        this.restoreRetryCount = 0;
        this.engine.logToUI(`Restoring session for room "${session.roomName}" (${session.isHost ? 'Host' : 'Guest'})...`);

        // 세션 점유권 획득
        session.activeWindowId = this.currentWindowId;
        session.isShuttingDown = false;
        session.lastHeartbeat = Date.now();
        await this.context.globalState.update(GLOBAL_SESSION_KEY, session);

        // 기본 엔진 속성 복원
        this.engine.roomName = session.roomName;
        this.engine.isHost = session.isHost;
        this.engine.myName = session.myName;
        this.engine.myId = session.myId;
        if (session.isHost) {
            this.engine.participantManager.myReconnectToken = '';
            this.engine.participantManager.peerReconnectTokens = new Map(
                Object.entries(session.participantReconnectTokens || {})
            );
        } else {
            this.engine.participantManager.peerReconnectTokens.clear();
            this.engine.participantManager.myReconnectToken = session.reconnectToken || '';
        }
        this.engine.isFollowMeMode = session.isFollowMeMode;
        this.engine.cursorManager.cursorFilter = session.cursorFilter;
        if (session.showDecorations !== undefined) {
            this.engine.decorationManager.showDecorations = session.showDecorations;
        }
        this.engine.chatHistory = session.chatHistory || [];
        const restoredParticipants = session.participants || {};
        
        // 호스트 복원 시 호스트 본인은 'connected', 게스트들은 재연결 대기 상태('reconnecting')로 초기화
        const recoveryTime = Date.now();
        if (session.isHost) {
            Object.keys(restoredParticipants).forEach(id => {
                if (id === 'host') {
                    restoredParticipants[id].connectionStatus = 'connected';
                } else {
                    restoredParticipants[id].connectionStatus = 'reconnecting';
                    this.engine.participantManager.reconnectStartTimes.set(id, recoveryTime);
                }
            });
        }
        this.engine.participantManager.participants = restoredParticipants;
        this.engine.participantManager.isAutoApprove = session.isAutoApprove ?? true;

        if (session.isHost) {
            // 호스트 스토리지 디렉터리 초기화
            this.engine.fileStorageManager.initializeStorage();

            // 공유 파일 및 Yjs 상태 복원
            this.engine.fileStorageManager.sharedFiles = [];
            for (const snap of session.sharedFiles) {
                const sharedFile: SharedFile = {
                    name: snap.name,
                    path: snap.path,
                    source: snap.source,
                    assigneeId: snap.assigneeId,
                    assigneeName: snap.assigneeName
                };
                this.engine.fileStorageManager.sharedFiles.push(sharedFile);

                // Yjs 문서 복원
                if (snap.yjsStateBase64) {
                    this.engine.documentSyncManager.createDocForGuest(snap.name, snap.yjsStateBase64, snap.content);
                } else {
                    this.engine.documentSyncManager.createDocForHost(snap.name, snap.content);
                }

                // 백그라운드에서 문서를 열어 VS Code 에디터 버퍼와 Yjs 동기화 리스너가 바로 연동되도록 보장
                try {
                    if (fs.existsSync(snap.path)) {
                        vscode.workspace.openTextDocument(snap.path).then(doc => {
                            vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
                        });
                    }
                } catch (e) {}
            }

            // 데코레이션 복원
            this.engine.decorationManager.decorations = session.decorations || [];

            // WebRTC P2P 허브 재개설
            this.engine.isSetupMode = false;
            this.engine.isConnected = true;
            this.engine.isSignalingConnected = false; // 시그널링 서버 연결 완료(roomNameSuccess) 전까지 대기 상태
            this.engine.hub.createHub(true, this.engine.roomName, 'none');

            this.startHeartbeat();
            this.engine.participantManager.startPingCheck();
            this.engine.pushUIUpdate();
            vscode.window.showInformationMessage(`"${session.roomName}" P2P 방 세션이 새 창으로 복원되었습니다.`);
        } else {
            // 게스트인 경우 호스트에게 재연결 요청 시도
            this.engine.isSetupMode = false;
            this.engine.participantManager.isAutoJoin = true;
            this.engine.participantManager.sendJoinRequest(session.roomName, session.myName, session.myId);
        }
    }
}
