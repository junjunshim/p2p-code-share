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

export interface PersistentFileSnapshot {
    name: string;
    path: string;
    source?: string;
    assigneeId?: string;
    assigneeName?: string;
    content: string;
    yjsStateBase64?: string;
}

export interface PersistentSessionData {
    roomName: string;
    isHost: boolean;
    myName: string;
    myId: string;
    isAutoApprove: boolean;
    isFollowMeMode: boolean;
    cursorFilter: 'host' | 'editable' | 'all';
    participants: { [key: string]: PeerPermission };
    sharedFiles: PersistentFileSnapshot[];
    decorations: FileDecoration[];
    chatHistory: ChatMessage[];
    activeWindowId: string;
    lastHeartbeat: number;
}

const GLOBAL_SESSION_KEY = 'p2p_code_share_active_session';
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_TIMEOUT_MS = 4000;
const SESSION_MAX_AGE_MS = 60000; // 1분 이상 지난 세션은 완전 종료로 간주

export class SessionRecoveryManager {
    public currentWindowId: string;
    public isRestoringSession = false;
    public restoreRetryCount = 0;
    private heartbeatTimer?: NodeJS.Timeout;

    constructor(private engine: SyncEngine, private context: vscode.ExtensionContext) {
        // 현재 창의 고유 ID 생성 (타임스탬프 + 난수)
        this.currentWindowId = `win_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    /**
     * 주기적인 생존 보고(하트비트)를 시작합니다.
     */
    public startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.engine.isConnected && this.engine.roomName) {
                this.saveSession();
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    /**
     * 하트비트를 중단합니다.
     */
    public stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    /**
     * 현재 활성 세션의 모든 상태를 globalState에 저장합니다.
     */
    public async saveSession() {
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
            isAutoApprove: this.engine.isAutoApprove,
            isFollowMeMode: this.engine.isFollowMeMode,
            cursorFilter: this.engine.cursorManager.cursorFilter,
            participants: this.engine.participantManager.participants,
            sharedFiles: fileSnapshots,
            decorations: this.engine.decorationManager.decorations,
            chatHistory: this.engine.chatHistory,
            activeWindowId: this.currentWindowId,
            lastHeartbeat: Date.now()
        };

        await this.context.globalState.update(GLOBAL_SESSION_KEY, sessionData);
    }

    /**
     * 사용자가 명시적으로 방을 나갔을 때 세션을 완전히 삭제합니다.
     */
    public async clearSession() {
        this.stopHeartbeat();
        await this.context.globalState.update(GLOBAL_SESSION_KEY, undefined);
    }

    /**
     * 창이 새로 열렸을 때, 복구 가능한 이전 세션이 있는지 검사합니다.
     * 다른 창이 현재 활성 연결을 유지하고 있다면 복구하지 않습니다 (멀티 윈도우 격리).
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

        // 다른 창이 아직 활발하게 하트비트를 보내고 있다면(4초 이내) 간섭하지 않음
        if (session.activeWindowId !== this.currentWindowId && age < HEARTBEAT_TIMEOUT_MS) {
            return null;
        }

        return session;
    }

    /**
     * 이전 세션 데이터를 현재 엔진에 복원합니다.
     */
    public async restoreSession(session: PersistentSessionData) {
        this.isRestoringSession = true;
        this.restoreRetryCount = 0;
        this.engine.logToUI(`Restoring session for room "${session.roomName}" (${session.isHost ? 'Host' : 'Guest'})...`);

        // 소유권 획득
        session.activeWindowId = this.currentWindowId;
        session.lastHeartbeat = Date.now();
        await this.context.globalState.update(GLOBAL_SESSION_KEY, session);

        // 기본 속성 복원
        this.engine.roomName = session.roomName;
        this.engine.isHost = session.isHost;
        this.engine.myName = session.myName;
        this.engine.myId = session.myId;
        this.engine.isFollowMeMode = session.isFollowMeMode;
        this.engine.cursorManager.cursorFilter = session.cursorFilter;
        this.engine.chatHistory = session.chatHistory || [];
        this.engine.participantManager.participants = session.participants || {};
        this.engine.participantManager.isAutoApprove = session.isAutoApprove ?? true;

        if (session.isHost) {
            // 호스트 스토리지 초기화
            this.engine.fileStorageManager.initializeStorage();

            // 공유 파일 복원
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

            // PeerJS 방 재개설 (재연결 플래그 설정)
            this.engine.isSetupMode = false;
            this.engine.isConnected = true;
            this.engine.hub.createHub(true, this.engine.roomName, 'none');

            this.startHeartbeat();
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
