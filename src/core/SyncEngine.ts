/**
 * @file SyncEngine.ts
 * @description 피어 간 파일 내용, 커서 및 상태를 동기화하기 위한 핵심 엔진입니다.
 * P2P 메시지 처리, 파일 I/O 및 UI 업데이트를 처리합니다.
 */

// VS Code API
import * as vscode from 'vscode';
// Node.js 파일 시스템 및 경로 유틸리티
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
// P2P 네트워킹을 위한 허브 매니저
import { HubManager } from './HubManager';
// 프로젝트 고유 타입
import { SharedFile, P2PMessage, PeerPermission, FileDecoration } from '../types';
// 경로 정리 및 디렉토리 생성을 위한 유틸리티
import { sanitizePath, ensureDirectory } from '../utils/helpers';
// Yjs CRDT 라이브러리
import * as Y from 'yjs';

/**
 * SyncEngine 클래스.
 * 파일 공유, 커서 및 피어 상태에 대한 동기화 로직을 처리합니다.
 */
export class SyncEngine {
    private remoteChangeLockCount = 0;
    private get isApplyingRemoteChange(): boolean {
        return this.remoteChangeLockCount > 0;
    }
    private yDocs = new Map<string, Y.Doc>();
    private yTexts = new Map<string, Y.Text>();
    private selfCorrectionTimers = new Map<string, NodeJS.Timeout>();
    public isHost = false; 
    private storagePath = '';
    private sharedFiles: SharedFile[] = [];
    private myName = '';
    private myId = ''; 
    private initialName = '';
    private participants: { [key: string]: PeerPermission } = {};
    private lastRemoteContentMap = new Map<string, string>();
    private pollingTimer?: NodeJS.Timeout;
    private syncDebounceTimer?: NodeJS.Timeout;
    // [추가] 타이핑 속도 적응형 디바운싱을 위한 상태
    private lastKeystrokeTime = 0;
    public roomName = ''; 
    private isStorageInitialized = false;
    public isSetupMode = false; 
    public isConnected = false; 
    public connectionType = 'Direct';
    private isAutoJoin = false; // [추가] 자동 참여 여부 추적
    private pendingInvites = new Set<string>();
    private joinRequests: any[] = []; // [추가] 방 참여 요청 목록

    private remoteCursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteSelectionDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteCursorStates = new Map<string, any>();
    private userColorMap = new Map<string, string>();
    private colorPalette = ['#4ec9b0', '#ffeb3b', '#2196f3', '#9c27b0', '#ff9800', '#00bcd4', '#8bc34a'];

    private decorations: FileDecoration[] = [];
    private typoDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 0, 0, 0.12)',
        textDecoration: 'underline wavy rgba(255, 0, 0, 0.7)'
    });
    private grammarDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(240, 173, 78, 0.12)',
        textDecoration: 'underline wavy rgba(240, 173, 78, 0.7)'
    });
    private logicalDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(217, 83, 79, 0.12)',
        textDecoration: 'underline wavy rgba(217, 83, 79, 0.7)'
    });
    private otherDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(91, 192, 222, 0.12)',
        textDecoration: 'underline solid rgba(91, 192, 222, 0.5)'
    });
    private highlightDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(92, 184, 92, 0.22)'
    });

    /**
     * SyncEngine을 초기화합니다.
     * @param hub 네트워크 통신을 위한 HubManager 인스턴스.
     * @param context 확장 프로그램 컨텍스트.
     * @param updateUI UI 상태 업데이트를 위한 콜백 함수.
     */
    constructor(private hub: HubManager, private context: vscode.ExtensionContext, private updateUI: (state: any) => void) {
        // 초기 이벤트 핸들러 및 리스너 설정
        this.setupHandlers();
        this.setupTextListeners();
        this.setupSelectionListeners();
    }

    /**
     * P2P 데이터 메시지를 위한 이벤트 핸들러를 설정합니다.
     */
    public setupHandlers() {
        this.hub.onDidReceiveData = async (text, peerId) => {
            this.logToUI(`Data received from peer: ${peerId}`);
            try {
                // 수신된 P2P 메시지 파싱
                const msg = JSON.parse(text) as P2PMessage;
                switch (msg.type) {
                    case 'SET_ROLE': this.handleSetRole(msg); break;
                    case 'ON_CONNECTED': this.handleOnConnected(peerId); break;
                    case 'ASSIGN_PEER_ID': this.handleAssignPeerId(msg); break;
                    case 'INIT_SNAPSHOT': 
                        // 로컬 저장소 및 게스트 스냅샷 초기화
                        if (!this.isStorageInitialized) this.initializeStorage();
                        await this.handleGuestInit(msg); 
                        break;
                    case 'SYNC_FULL': await this.forceUpdateEditor(msg.fileName, msg.content); break;
                    case 'YJS_SYNC_STEP_1': this.handleYjsSyncStep1(msg); break;
                    case 'YJS_SYNC_STEP_2': await this.handleYjsSyncStep2(msg); break;
                    case 'YJS_UPDATE': await this.handleYjsUpdate(msg); break;
                    case 'GUEST_JOIN': 
                        // 게스트 연결 처리
                        this.logToUI(`GUEST_JOIN from peer: ${peerId}, Name: ${msg.name}`);
                        
                        // [수정] 호스트일 경우, 자동 참여가 아닐 때만 즉시 추가 (자동 참여는 승인 후 처리)
                        if (this.isHost) {
                            const isAutoJoining = this.joinRequests.some(r => r.peerId === peerId);
                            if (!isAutoJoining) {
                                this.handleGuestJoin(msg, peerId);
                                this.updateStatus('Connected');
                            }
                        }
                        break;
                    case 'GUEST_RENAME':
                        // 참가자 이름 변경
                        if (this.isHost) { 
                            this.participants[peerId] = { 
                                ...(this.participants[peerId] || { globalCanEdit: false, filePermissions: {} }), 
                                name: msg.newName 
                            }; 
                            this.broadcastUserList(); 

                            // 해당 게스트가 남긴 데코레이션의 작성자 이름 변경 및 브로드캐스트
                            this.decorations.forEach(d => {
                                if (d.creatorId === peerId) d.creatorName = msg.newName;
                            });
                            this.broadcastDecorations();
                        }
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'GUEST_EDIT': if (this.isHost) { await this.handleGuestEdit(msg); } break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastAll(); break;
                    case 'FILE_HASH': this.handleFileHash(msg); break;
                    case 'FILE_ASSIGNEE_UPDATE': await this.handleFileAssigneeUpdate(msg); break;
                    case 'STOP_SHARING': await this.handleRemoteStop(msg.fileName); break;
                    case 'CURSOR_UPDATE': 
                        // 커서 및 선택 영역 업데이트 처리
                        const senderId = msg.userId || peerId; 
                        this.updateRemoteCursor(msg, senderId); 
                        if (this.isHost) this.broadcastCursor(msg, senderId);
                        break;
                    case 'JOIN_REQUEST': this.handleJoinRequest(msg, peerId); break;
                    case 'JOIN_RESPONSE': this.handleJoinResponse(msg); break;
                    case 'KICKED': this.handleKicked(msg); break;
                    case 'SET_PERMISSION': await this.handleSetPermission(msg); break;
                    case 'ADD_DECORATION':
                        if (this.isHost) {
                            this.decorations.push(msg.decoration);
                            this.broadcastDecorations();
                        }
                        break;
                    case 'DELETE_DECORATION':
                        if (this.isHost) {
                            const deco = this.decorations.find(d => d.id === msg.id);
                            if (deco && (deco.creatorId === peerId || peerId === 'host')) {
                                this.decorations = this.decorations.filter(d => d.id !== msg.id);
                                this.broadcastDecorations();
                            }
                        }
                        break;
                    case 'SYNC_DECORATIONS':
                        this.decorations = msg.decorations || [];
                        this.refreshDecorationsInEditors();
                        this.pushUIUpdate();
                        break;
                }
            } catch (e) {}
        };
    }

    private handleOnConnected(peerId: string) {
        // 피어 연결 초기화 처리
        this.logToUI(`ON_CONNECTED received: ${peerId}`);
        if (this.isHost) {
            if (this.pendingInvites.has(peerId)) {
                this.isSetupMode = false;
                this.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
                this.pendingInvites.delete(peerId);
            }
        } else {
            // [수정] 수동 연결 모드라면 즉시 연결 완료로 처리
            if (!this.isAutoJoin) {
                this.isConnected = true;
                this.isSetupMode = false;
                this.logToUI("Manual connection complete");
                this.updateStatus('Connected');
            } else {
                // 자동 참여 모드라면 연결만 된 상태, Waiting... 유지
                this.logToUI("Connected to host, waiting for join approval...");
                this.updateStatus('Waiting...');
            }
        }
        this.pushUIUpdate();
    }

    private handleAssignPeerId(msg: any) {
        // 게스트 노드에 대한 피어 ID 할당
        if (!this.isHost) {
            this.logToUI(`ASSIGN_PEER_ID received: ${msg.peerId}`);
            const oldId = this.myId || 'default';
            this.myId = msg.peerId;
            this.myName = msg.peerId; 
            this.initialName = this.myId; 
            this.isStorageInitialized = false; 
            this.initializeStorage(); 
            
            // UI에 피어 ID 변경 알림
            this.sendMessage('updatePeerId', { oldId, newId: this.myId });
            
            // [추가] ASSIGN_PEER_ID를 받은 후 JOIN_REQUEST 전송
            if (this.isAutoJoin && this.pendingJoinRequest) {
                this.sendMessage('JOIN_REQUEST', { 
                    name: this.myId, 
                    description: this.pendingJoinRequest.description 
                });
                this.pendingJoinRequest = null;
            }
            
            this.sendMessage('GUEST_JOIN', { name: this.myName }); 
            this.pushUIUpdate();
        }
    }

    private handleFileHash(msg: any) {
        if (!this.isHost) {
            const file = this.sharedFiles.find(f => f.name === msg.fileName);
            if (file) {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
                const content = doc ? doc.getText() : fs.readFileSync(file.path, 'utf8');
                if (this.calculateHash(content) !== msg.hash) {
                    this.sendMessage('REQUEST_FULL_SYNC', { fileName: msg.fileName });
                }
            }
        }
    }

    private async handleFileAssigneeUpdate(msg: any) {
        if (!this.isHost) {
            const file = this.sharedFiles.find(f => f.name === msg.fileName);
            if (file) {
                file.assigneeId = msg.assigneeId;
                file.assigneeName = msg.assigneeName;
                await this.updateReadonlyState(file);
                this.pushUIUpdate();
            }
        }
    }

    private handleJoinRequest(msg: any, peerId: string) {
        // [추가] 방 참여 요청 처리 (호스트 전용)
        if (this.isHost) {
            this.joinRequests.push({
                peerId,
                name: msg.name || peerId,
                description: msg.description || '',
                timestamp: Date.now()
            });
            vscode.window.showInformationMessage(`방 참여 요청: ${msg.name || peerId}`);
            this.pushUIUpdate();
        }
    }

    private handleJoinResponse(msg: any) {
        // [추가] 방 참여 응답 처리 (게스트 전용)
        if (!this.isHost) {
            if (msg.approved) {
                vscode.window.showInformationMessage("방 참여가 승인되었습니다!");
                this.isConnected = true; // [추가] 승인 시 연결 완료 상태로 전환
                this.isAutoJoin = false; // [추가] 자동 참여 모드 해제
                this.updateStatus('Connected');
            } else {
                vscode.window.showErrorMessage(`방 참여가 거절되었습니다: ${msg.reason || '사유 없음'}`);
                this.reset();
            }
        }
    }

    private handleKicked(msg: any) {
        // [추가] 강제 퇴장 처리 (게스트 전용)
        if (!this.isHost) {
            vscode.window.showErrorMessage(`퇴장되었습니다: ${msg.reason}`);
            this.reset();
        }
    }

    private async handleSetPermission(msg: any) {
        // [추가] 호스트로부터 권한 변경 메시지 수신 (게스트 전용)
        if (!this.isHost) {
            const p = msg.permission as PeerPermission;
            this.participants[this.myId] = {
                name: this.myName,
                globalCanEdit: p.globalCanEdit,
                filePermissions: p.filePermissions
            };
            this.logToUI(`Permission updated: Global=${p.globalCanEdit}`);
            await this.updateAllReadonlyStates(); // [수정] 비동기로 순차 처리 대기
            this.pushUIUpdate();
        }
    }

    private pendingJoinRequest: { roomName: string, description: string } | null = null; // [추가] 대기 중인 요청 저장

    /**
     * 방 참여 요청을 보냅니다. (게스트용)
     * @param roomName 방 이름.
     * @param description 참여 목적 설명.
     */
    public async sendJoinRequest(roomName: string, description: string) {
        this.roomName = roomName;
        this.isSetupMode = false;
        this.isAutoJoin = true; // [추가] 자동 참여 모드 설정
        this.pendingJoinRequest = { roomName, description }; // 요청 큐에 저장
        this.pushUIUpdate();

        // 허브 생성 (게스트 모드)
        this.hub.createHub(false, roomName, 'default');
    }

    /**
     * 방 참여 요청을 승인합니다. (호스트용)
     * @param peerId 승인할 피어 ID.
     */
    public approveRequest(peerId: string) {
        if (!this.isHost) return;
        
        // [수정] 승인 시 게스트를 참가자로 추가
        const request = this.joinRequests.find(req => req.peerId === peerId);
        if (request) {
            this.handleGuestJoin({ name: request.name }, peerId);
        }
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        
        // 승인 메시지 전송 및 피어 ID 할당
        this.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
        this.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
        
        this.pushUIUpdate();
    }

    /**
     * 방 참여 요청을 거절합니다. (호스트용)
     * @param peerId 거절할 피어 ID.
     */
    public rejectRequest(peerId: string) {
        if (!this.isHost) return;
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        
        // 거절 메시지 전송
        this.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: false, reason: '호스트가 요청을 거절했습니다.' });
        
        this.pushUIUpdate();
    }

    /**
     * 호스트가 특정 피어의 권한을 설정합니다.
     * @param peerId 대상 피어 ID.
     * @param permission 설정할 권한 객체.
     */
    public setPeerPermission(peerId: string, permission: PeerPermission) {
        if (!this.isHost) return;

        // participants 목록 업데이트
        this.participants[peerId] = permission;
        
        // 해당 피어에게 SET_PERMISSION 메시지 전송
        this.sendMessageToPeer(peerId, 'SET_PERMISSION', { permission });
        
        // 전체 사용자 목록 갱신 브로드캐스트
        this.broadcastUserList();
        this.logToUI(`Permission set for ${peerId}: Global=${permission.globalCanEdit}`);
    }

    /**
     * 특정 파일의 담당자를 지정하고 브로드캐스트합니다.
     * @param fileName 대상 파일 이름.
     * @param assigneeId 담당자 피어 ID.
     */
    public setFileAssignee(fileName: string, assigneeId: string) {
        if (!this.isHost) return;

        const file = this.sharedFiles.find(f => f.name === fileName);
        if (!file) return;

        file.assigneeId = assigneeId || undefined;
        if (assigneeId === 'host') {
            file.assigneeName = this.myName;
        } else if (assigneeId && this.participants[assigneeId]) {
            file.assigneeName = this.participants[assigneeId].name;
        } else {
            file.assigneeName = undefined;
        }

        // 전체 게스트들에게 파일 담당자 변경 브로드캐스트
        this.sendMessage('FILE_ASSIGNEE_UPDATE', { 
            fileName, 
            assigneeId: file.assigneeId, 
            assigneeName: file.assigneeName 
        });

        this.logToUI(`File owner for ${fileName} updated: ${file.assigneeName || 'Unassigned'}`);
        
        // 내 에디터 및 UI 업데이트
        this.pushUIUpdate();
    }

    /**
     * 호스트에서 받은 커서 정보를 다른 모든 피어에게 브로드캐스트합니다.
     * @param msg 커서 업데이트 메시지.
     * @param senderId 메시지를 보낸 피어의 ID.
     */
    private broadcastCursor(msg: any, senderId: string) {
        // 호스트가 받은 커서 정보를 다른 모든 피어에게 전달
        this.hub.sendToEngine({ type: 'peerData', value: { type: 'CURSOR_UPDATE', ...msg } });
    }

    /**
     * 피어 ID에 할당된 색상을 가져옵니다.
     * @param peerId 색상을 가져올 피어의 ID.
     * @returns 할당된 색상 코드(HEX).
     */
    private getUserColor(peerId: string): string {
        // 호스트나 기본 피어는 빨간색 반환
        if (peerId === 'host' || (!this.isHost && peerId === 'default')) return '#f44336';
        // 색상이 없으면 새로 할당
        if (!this.userColorMap.has(peerId)) {
            const color = this.colorPalette[this.userColorMap.size % this.colorPalette.length];
            this.userColorMap.set(peerId, color);
        }
        return this.userColorMap.get(peerId)!;
    }

    private setupSelectionListeners() {
        vscode.window.onDidChangeTextEditorSelection(e => {
            // [핵심] myId가 정상적으로 할당된 경우에만 전송
            if (!this.myId || this.myId === 'default' || this.myId === '') return;

            const file = this.sharedFiles.find(f => f.path === e.textEditor.document.uri.fsPath);
            if (!file) return;

            const ydoc = this.yDocs.get(file.name);
            const ytext = this.yTexts.get(file.name);
            if (!ydoc || !ytext) return;

            const selection = e.selections[0];
            const document = e.textEditor.document;

            try {
                // 커서 위치 및 드래그 영역의 Yjs 상대 위치 생성
                const startIndex = document.offsetAt(selection.start);
                const endIndex = document.offsetAt(selection.end);
                const activeIndex = document.offsetAt(selection.active);

                const startRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, startIndex));
                const endRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, endIndex));
                const activeRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, activeIndex));

                this.sendMessage('CURSOR_UPDATE', {
                    fileName: file.name,
                    userId: this.myId,
                    userName: this.myName,
                    startRel,
                    endRel,
                    activeRel
                });
            } catch (err) {
                this.logToUI(`Error creating relative cursor positions: ${err}`);
            }
        });
    }

    /**
     * 원격 피어의 커서 및 선택 영역을 업데이트하고 렌더링합니다.
     * @param msg 커서 업데이트 메시지.
     * @param peerId 피어 ID.
     */
    private updateRemoteCursor(msg: any, peerId: string) {
        // [핵심] 호스트를 거쳐서 온 경우, 실제 원작자의 peerId는 msg.userId에 담겨있음
        const actualPeerId = msg.userId || peerId; 
        
        // 내 자신의 커서 업데이트라면 렌더링하지 않음
        if (actualPeerId === this.myId) return;

        // 마지막 커서 상태 저장 (에디터 재개방 시 복구용)
        this.remoteCursorStates.set(actualPeerId, msg);
        
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) {
            // 파일이 다르거나 없더라도 이전 데코레이션은 무조건 정리 (고스트 커서 방지)
            const prevCursor = this.remoteCursorDecorations.get(actualPeerId);
            if (prevCursor) prevCursor.dispose();
            const prevSelection = this.remoteSelectionDecorations.get(actualPeerId);
            if (prevSelection) prevSelection.dispose();
            return;
        }

        // 해당 파일의 모든 원격 커서 다시 그리기 (겹침 방지 및 수직 스택 계산)
        this.renderCursorsForFile(file);
    }

    private renderCursorsForFile(file: SharedFile) {
        const ydoc = this.yDocs.get(file.name);
        if (!ydoc) return;

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path && !d.isClosed);
        if (!doc) return;

        // 해당 파일에 있는 모든 원격 피어 필터링
        const peersInFile = Array.from(this.remoteCursorStates.entries())
            .filter(([id, state]) => state.fileName === file.name && id !== this.myId);

        // 먼저 각 피어별로 Yjs 상대 좌표로부터 최신 실제 Position을 역산
        const parsedPeers: { peerId: string; state: any; activePos: vscode.Position; startPos: vscode.Position; endPos: vscode.Position }[] = [];
        peersInFile.forEach(([peerId, state]) => {
            if (!state.startRel || !state.endRel || !state.activeRel) return;

            try {
                const startRelPos = Y.createRelativePositionFromJSON(state.startRel);
                const endRelPos = Y.createRelativePositionFromJSON(state.endRel);
                const activeRelPos = Y.createRelativePositionFromJSON(state.activeRel);

                const startAbs = Y.createAbsolutePositionFromRelativePosition(startRelPos, ydoc);
                const endAbs = Y.createAbsolutePositionFromRelativePosition(endRelPos, ydoc);
                const activeAbs = Y.createAbsolutePositionFromRelativePosition(activeRelPos, ydoc);

                if (startAbs && endAbs && activeAbs) {
                    parsedPeers.push({
                        peerId,
                        state,
                        activePos: doc.positionAt(activeAbs.index),
                        startPos: doc.positionAt(startAbs.index),
                        endPos: doc.positionAt(endAbs.index)
                    });
                }
            } catch (e) {}
        });

        // 위치별 피어 그룹화 (겹침 방지 및 수직 스택용)
        const posGroups = new Map<string, string[]>();
        parsedPeers.forEach(p => {
            const key = `${p.activePos.line},${p.activePos.character}`;
            if (!posGroups.has(key)) posGroups.set(key, []);
            posGroups.get(key)!.push(p.peerId);
        });

        // 정렬
        posGroups.forEach(ids => ids.sort());

        // 렌더링 적용
        parsedPeers.forEach(p => {
            const key = `${p.activePos.line},${p.activePos.character}`;
            const group = posGroups.get(key)!;
            const rank = group.indexOf(p.peerId);
            
            this.applyPeerDecorationWithPositions(p.peerId, p.state, file, rank, p.activePos, p.startPos, p.endPos);
        });
    }

    /**
     * 역산된 에디터 좌표를 기반으로 개별 피어의 데코레이션을 생성하고 적용합니다.
     */
    private applyPeerDecorationWithPositions(peerId: string, state: any, file: SharedFile, rank: number, activePos: vscode.Position, startPos: vscode.Position, endPos: vscode.Position) {
        // 이전 데코레이션 정리
        const prevCursor = this.remoteCursorDecorations.get(peerId);
        if (prevCursor) prevCursor.dispose();
        const prevSelection = this.remoteSelectionDecorations.get(peerId);
        if (prevSelection) prevSelection.dispose();

        const editorConfig = vscode.workspace.getConfiguration('editor', vscode.Uri.file(file.path));
        const editorFontSize = editorConfig.get<number>('fontSize') || 14;
        const badgeFontSize = Math.max(9, Math.round(editorFontSize * 0.8));

        const color = this.getUserColor(peerId); 
        const verticalOffset = 1.4 + (rank * 1.5);

        // 새 커서 데코레이션 생성
        const cursorDeco = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: color,
            after: {
                contentText: state.userName || 'Anonymous', 
                backgroundColor: color, color: 'white', 
                margin: `${verticalOffset}em 0 0 0`, 
                fontWeight: 'bold',
                textDecoration: `none; font-size: ${badgeFontSize}px; padding: 1px 4px; border-radius: 3px; position: absolute; z-index: ${1000 - rank}; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3); text-shadow: -1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.8);`
            }
        });
        // 새 선택 영역 데코레이션 생성
        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        
        this.remoteCursorDecorations.set(peerId, cursorDeco);
        this.remoteSelectionDecorations.set(peerId, selectionDeco);
        
        const cursorRange = [new vscode.Range(activePos, activePos)];
        const selectionRange = [new vscode.Range(startPos, endPos)];

        // 가시적인 모든 에디터 중 해당 파일에 대해 데코레이션 적용
        const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.fsPath === file.path);
        editors.forEach(editor => {
            editor.setDecorations(cursorDeco, cursorRange);
            editor.setDecorations(selectionDeco, selectionRange);
        });
    }

    /**
     * 모든 에디터의 데코레이션을 현재 상태를 기반으로 새로고침합니다.
     */
    private refreshAllDecorations() {
        // 중복 렌더링을 방지하기 위해 파일 단위로 처리
        const processedFiles = new Set<string>();
        vscode.window.visibleTextEditors.forEach(editor => {
            const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file && !processedFiles.has(file.path)) {
                this.renderCursorsForFile(file);
                processedFiles.add(file.path);
            }
        });

        // 사용자 정의 데코레이션(오타, 오류, 하이라이트 등) 업데이트
        this.refreshDecorationsInEditors();
    }

    /**
     * 피어의 역할을 설정하고 초기화합니다.
     * @param msg 역할 설정 메시지 (호스트 여부, 방 이름 포함).
     */
    public handleSetRole(msg: any) {
        this.isHost = msg.isHost;
        this.myId = this.isHost ? 'host' : '';
        this.roomName = msg.roomName || 'Untitled Room';
        this.myName = this.isHost ? 'Host' : '';
        this.initialName = this.myName;
        this.logToUI(`Role set: ${this.isHost ? 'Host' : 'Guest'} for room "${this.roomName}"`);
        this.updateStatus('Initializing...');

        if (this.isHost) { 
            this.isSetupMode = false;
            this.initializeStorage(); 
            this.participants['host'] = { name: this.myName, globalCanEdit: true, filePermissions: {} }; 
            this.hub.createHub(true, this.roomName, 'none'); 
            
            if (this.roomName && this.roomName !== 'Untitled Room') {
                this.inviteGuest(true);
            }
        } else { 
            this.isSetupMode = (this.roomName && this.roomName !== 'Untitled Room') ? false : true; 
            this.startPolling(); 
            this.hub.createHub(false, this.roomName, 'default'); 
            if (this.isSetupMode) this.updateStatus('Waiting...'); // [수정] 대기 모드 시 Waiting... 상태 표시
        }
        this.pushUIUpdate();
    }

    /**
     * 게스트를 초대합니다.
     * @param isSilent true일 경우 UI를 초대 화면으로 전환하지 않고 배경에서 생성합니다.
     */
    public inviteGuest(isSilent: boolean = false) {
        if (!this.isHost) return;
        // 새로운 피어 ID 생성
        const newPeerId = 'guest_' + Date.now();
        this.pendingInvites.add(newPeerId);
        
        // 수동 연결(+ 버튼 클릭) 시에만 설정 모드로 전환
        if (!isSilent) this.isSetupMode = true; 
        
        // 허브에 새로운 피어 추가 (방 이름과 새 피어 ID 전달)
        this.hub.createHub(true, this.roomName, newPeerId); 
        this.pushUIUpdate();
    }

    /**
     * 게스트 초기 스냅샷을 처리합니다.
     * @param msg 초기화 메시지 (파일 이름 및 내용 포함).
     */
    private async handleGuestInit(msg: any) {
        this.isHost = false;
        if (!this.isStorageInitialized) this.initializeStorage();
        
        if (!this.storagePath) {
            this.logToUI(`Error: Storage not initialized before handleGuestInit. myId=${this.myId}`);
            return;
        }

        // 스냅샷 경로 생성 및 파일 쓰기 (호스트가 넘겨준 원본 확장자를 가진 고유명 그대로 사용)
        const snapshotPath = path.join(this.storagePath, msg.fileName);
        this.logToUI(`Writing snapshot to: ${snapshotPath}`);
        fs.writeFileSync(snapshotPath, msg.content);
        
        // [수정] 파일 목록에 먼저 추가 (여기서 읽기 전용 상태가 설정됨)
        this.addSharedFile(msg.fileName, snapshotPath, undefined, msg.assigneeId, msg.assigneeName);

        // 문서 열기 및 표시
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);

        // 호스트에게 Sync Step 1 요청 전송하여 Yjs 동기화 시작
        const ydoc = this.yDocs.get(msg.fileName);
        if (ydoc) {
            const stateVector = Y.encodeStateVector(ydoc);
            this.sendMessage('YJS_SYNC_STEP_1', {
                fileName: msg.fileName,
                stateVector: Buffer.from(stateVector).toString('base64')
            });
        }
    }

    /**
     * 사용자 명단 업데이트를 처리합니다.
     * @param msg 사용자 명단 업데이트 메시지 (사용자 목록, 방 이름 포함).
     */
    private async handleUserListUpdate(msg: any) {
        // 참가자 목록 업데이트
        this.participants = msg.users;
        this.logToUI(`User list updated. ${Object.keys(this.participants).length} users. myId=${this.myId}`);
        
        // 방 이름이 제공되고 방 이름이 없을 경우 설정
        if (msg.roomName && (this.roomName === '' || this.roomName === 'Untitled Room')) {
            this.roomName = msg.roomName;
            if (!this.isHost) {
                this.isStorageInitialized = false;
                this.initializeStorage();
            }
        }
        // 저장소 초기화 필요 시 초기화
        if (!this.isHost && !this.isStorageInitialized && this.roomName) this.initializeStorage();
        
        // 내 이름을 덮어쓰지 않고 myId(peerId)가 있을 때만 명단에서 업데이트하도록 변경
        if (!this.isHost && this.myId) {
            const myData = this.participants[this.myId] || this.participants['default'];
            if (myData) {
                this.myName = myData.name;
            }
        }
        
        await this.updateAllReadonlyStates(); // [수정] 비동기로 순차 처리 대기
        this.pushUIUpdate();
    }

    private async handleGuestEdit(msg: any) {
        // 편집 대상 파일 찾기
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (file) { 
            // 전체 공유 시 호스트 실제 에디터 내용 업데이트 및 브로드캐스트
            await this.forceUpdateEditor(file.name, msg.content, file.path); 
            this.broadcastFullContent(file.name, file.path); 
        }
    }

    /**
     * 게스트 참여 요청을 처리합니다.
     * @param msg 참여 메시지 (게스트 이름 포함).
     * @param peerId 참여한 게스트의 피어 ID.
     */
    private handleGuestJoin(msg: any, peerId: string) {
        // 호스트일 경우 참가자 목록에 추가 및 목록/전체 내용 브로드캐스트
        if (this.isHost) { 
            this.participants[peerId] = { name: msg.name, globalCanEdit: false, filePermissions: {} }; 
            this.broadcastUserList(); 
            
            // [추가] 새로 들어온 게스트에게 현재 공유 중인 모든 파일 스냅샷 전송
            this.sharedFiles.forEach(f => {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f.path);
                const content = doc ? doc.getText() : fs.readFileSync(f.path, 'utf8');
                // 해당 피어에게만 초기 스냅샷 전송 (파일 목록 생성 및 에디터 열기 유도)
                this.sendMessageToPeer(peerId, 'INIT_SNAPSHOT', { 
                    fileName: f.name, 
                    content,
                    assigneeId: f.assigneeId,
                    assigneeName: f.assigneeName
                });
            });

            // 현재 데코레이션 목록 전송 (비공개 처리 적용)
            const peerDecos = this.decorations.filter(d => d.visibility !== 'host' || d.creatorId === peerId);
            this.sendMessageToPeer(peerId, 'SYNC_DECORATIONS', { decorations: peerDecos });
        }
    }

    private closingDocuments = new Set<string>();

    /**
     * 현재 사용자가 특정 파일에 대한 편집 권한이 있는지 확인합니다.
     * @param fileName 확인 대상 파일 이름.
     */
    private canIEdit(fileName: string): boolean {
        // 호스트는 항상 가능
        if (this.isHost) return true;
        
        // 내 ID 또는 기본 ID로 데이터 찾기
        const myData = this.participants[this.myId] || this.participants['default'];
        
        if (!myData) return false; // 기본 권한 없음
        
        // 파일 담당자 지정 체크
        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file && file.assigneeId) {
            // 담당자가 지정되어 있으면, 내 ID가 담당자 ID여야만 편집 가능
            return file.assigneeId === this.myId;
        }
        
        // 1. 전체 권한이 있으면 통과
        if (myData.globalCanEdit) return true;
        
        // 2. 파일별 권한 확인
        return myData.filePermissions[fileName] === true;
    }

    /**
     * 모든 공유 파일의 읽기 전용 상태를 현재 권한에 맞게 업데이트합니다.
     */
    private async updateAllReadonlyStates() {
        if (this.isHost) return;
        for (const file of this.sharedFiles) {
            await this.updateReadonlyState(file);
        }
    }

    /**
     * 특정 공유 파일의 읽기 전용 상태를 업데이트합니다.
     * @param file 대상 공유 파일.
     */
    private async updateReadonlyState(file: SharedFile) {
        if (this.isHost) return;
        try {
            const canEdit = this.canIEdit(file.name);
            const targetMode = canEdit ? 0o666 : 0o444;
            
            // 1. 파일 시스템 속성 변경 (물리적 차단)
            if (fs.existsSync(file.path)) {
                fs.chmodSync(file.path, targetMode);
            }
            
            // 2. 현재 열려있는 에디터들에 대해 세션 내 읽기 전용 상태 적용 (UI 차단)
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.uri.fsPath === file.path) {
                await this.applyEditorReadonlyState(activeEditor, !canEdit);
            }
        } catch (e) {
            this.logToUI(`Failed to update readonly state for ${file.name}: ${e}`);
        }
    }

    /**
     * VS Code 에디터에 세션 읽기 전용 상태를 적용하거나 해제합니다.
     * @param editor 대상 에디터.
     * @param readonly 읽기 전용 여부.
     */
    private async applyEditorReadonlyState(editor: vscode.TextEditor, readonly: boolean) {
        if (this.isHost) return;
        
        // 에디터가 활성화된 상태여야 명령이 해당 에디터에 적용됨
        if (vscode.window.activeTextEditor !== editor) return;

        try {
            if (readonly) {
                await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
            } else {
                // [수정] 세션 읽기 전용 상태를 초기화하여 디스크 상태를 따르거나 쓰기 가능하게 변경
                await vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
            }
        } catch (e) {
            this.logToUI(`Failed to execute session command: ${e}`);
        }
    }

    /**
     * 텍스트 문서 변경 이벤트 리스너를 설정합니다.
     */
    private setupTextListeners() {
        // 에디터 변경 감지 (새로 열거나 탭 전환 시 읽기 전용 상태 동기화 및 공유 상태 컨텍스트 업데이트)
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            this.updateActiveFileSharedContext();
            if (!editor || this.isHost) return;
            const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                const canEdit = this.canIEdit(file.name);
                await this.applyEditorReadonlyState(editor, !canEdit);
            }
        });

        vscode.workspace.onDidChangeTextDocument(e => {
            const file = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!file) return;

            if (this.isApplyingRemoteChange || this.closingDocuments.has(e.document.uri.fsPath)) return;

            // 권한 체크
            if (!this.canIEdit(file.name)) {
                this.logToUI(`Blocked unauthorized edit on ${file.name}`);
                return;
            }

            const ydoc = this.yDocs.get(file.name);
            const ytext = this.yTexts.get(file.name);
            if (!ydoc || !ytext) return;

            // 로컬 에디터 변경 내용을 Yjs 문서에 적용
            ydoc.transact(() => {
                for (const change of e.contentChanges) {
                    const startOffset = change.rangeOffset;
                    const deleteLength = change.rangeLength;
                    const newText = change.text;

                    if (deleteLength > 0) {
                        ytext.delete(startOffset, deleteLength);
                    }
                    if (newText.length > 0) {
                        ytext.insert(startOffset, newText);
                    }
                }
            });

            // 로컬 트랜잭션 반영 후 데코레이션 상대 위치 역산 갱신
            this.recalculateDecorationsPositions(file.name, file.path);

            // 타이핑 멈춤 감지 시 에디터와 Yjs의 텍스트가 일치하는지 보정 테스트 트리거
            this.triggerSelfCorrection(file.name, file.path);
        });

        vscode.workspace.onWillSaveTextDocument(e => {
            // 호스트가 아니며 공유 파일 저장 시 상태 메시지 표시
            if (!this.isHost && this.sharedFiles.some(f => f.path === e.document.uri.fsPath)) {
                vscode.window.setStatusBarMessage("P2P: Changes synced to Host.", 3000);
            }
        });

        // [추가] 에디터가 닫힐 때 발생하는 '의도치 않은 변경 이벤트' 차단을 위한 리스너
        vscode.workspace.onDidCloseTextDocument(doc => {
            this.closingDocuments.add(doc.uri.fsPath);
            // 잠시 후 목록에서 제거 (이벤트 루프가 소진될 때까지 보호)
            setTimeout(() => {
                this.closingDocuments.delete(doc.uri.fsPath);
            }, 500);
        });

        // 에디터 가시성 변경 시 데코레이션 다시 그리기 (파일 재개방 대응)
        vscode.window.onDidChangeVisibleTextEditors(() => {
            this.refreshAllDecorations();
        });

        // 폰트 크기 변경 감지 및 데코레이션 갱신 리스너 등록
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('editor.fontSize')) {
                    this.sharedFiles.forEach(file => this.renderCursorsForFile(file));
                    this.refreshDecorationsInEditors();
                }
            })
        );
    }
    
    /**
     * 공유 파일 저장을 위한 저장소를 초기화합니다.
     */
    private initializeStorage() {
        if (this.isStorageInitialized) return;
        // 호스트나 게스트 연결 정보가 없으면 반환
        if (!this.isHost && (!this.myId || this.myId === 'default' || !this.roomName || this.roomName === 'Untitled Room')) return;

        // 동일한 기기 내 다중 인스턴스 충돌 방지를 위해 myId를 경로에 포함
        const folderName = this.isHost ? 'host' : this.myId;
        this.storagePath = path.join(this.context.globalStorageUri.fsPath, sanitizePath(this.roomName), sanitizePath(folderName));
        // 디렉토리 존재 확인 및 생성
        ensureDirectory(this.storagePath);
        this.isStorageInitialized = true;
    }

    /**
     * 에디터의 내용을 강제로 업데이트합니다.
     * @param fileName 파일 이름.
     * @param content 파일의 새로운 내용.
     * @param specificPath 특정 파일 경로 (선택 사항).
     */
    private async forceUpdateEditor(fileName: string, content: string, specificPath?: string) {
        // 파일 경로 확인
        const filePath = specificPath || this.sharedFiles.find(f => f.name === fileName)?.path;
        if (!filePath) return;
        
        // 문서 상태 확인 및 내용 업데이트
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath && !d.isClosed);
        if (!doc) { 
            fs.writeFileSync(filePath, content); 
            return; 
        }
        
        const oldText = doc.getText();
        
        if (oldText === content) {
            if (doc.isDirty) {
                try { await doc.save(); } catch(e) {}
            }
            return;
        }

        // 원격 변경 사항 적용 플래그 설정
        this.lastRemoteContentMap.set(fileName, content);

        // [추가] 쓰기 전 잠시 읽기 전용 속성 해제
        const currentMode = fs.statSync(filePath).mode;
        const wasReadonly = (currentMode & 0o200) === 0;
        if (wasReadonly) fs.chmodSync(filePath, 0o666);

        this.remoteChangeLockCount++;

        try {
            // [수정] 전체 교체가 아닌 최소 범위 교체 (Surgical Update)
            let start = 0;
            while (start < oldText.length && start < content.length && oldText[start] === content[start]) {
                start++;
            }
            let oldEnd = oldText.length;
            let newEnd = content.length;
            while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === content[newEnd - 1]) {
                oldEnd--;
                newEnd--;
            }

            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(oldEnd)), content.slice(start, newEnd));
            await vscode.workspace.applyEdit(edit);
            
            // [수정] 외부 파일 직접 쓰기(fs.writeFileSync) 대신 VS Code API를 통한 안전한 저장 수행
            try { await doc.save(); } catch(e) {}
        } finally {
            // [추가] 속성 복구
            if (wasReadonly) fs.chmodSync(filePath, 0o444);
            // 변경 사항 적용 후 플래그 해제, 자가 보정 및 데코레이션 상대 위치 역산 갱신
            setTimeout(() => { 
                if (this.remoteChangeLockCount > 0) this.remoteChangeLockCount--;
                this.recalculateDecorationsPositions(fileName, filePath);
                this.triggerSelfCorrection(fileName, filePath);
            }, 300);
        }
    }

    /**
     * 활성화된 파일을 공유합니다.
     * @param targetUri 공유할 파일의 URI (선택 사항).
     */
    public async shareActiveFile(targetUri?: vscode.Uri) {
        if (!this.isHost || !this.isStorageInitialized) return;
        
        let sourcePath: string; let document: vscode.TextDocument;
        // URI가 제공되면 해당 파일 열기
        if (targetUri) { 
            sourcePath = targetUri.fsPath; 
            document = await vscode.workspace.openTextDocument(targetUri); 
        } else { 
            // URI가 없으면 활성화된 에디터 파일 사용
            const editor = vscode.window.activeTextEditor; 
            if (!editor) return; 
            sourcePath = editor.document.uri.fsPath; 
            document = editor.document; 
        }
        
        const fileName = path.basename(sourcePath);
        // 이미 실제 파일이 공유 중인 경우 무시
        if (this.sharedFiles.find(f => f.path === sourcePath)) return;
        
        // 공유할 때마다 고유 경로를 갖도록 하되 원본 확장자를 유지 (원본파일명_타임스탬프.확장자)
        const timestamp = Date.now();
        const ext = path.extname(fileName);
        const baseName = path.basename(fileName, ext);
        const virtualFileName = `${baseName}_${timestamp}${ext}`;
        
        // 원본 백업본 생성 (.original)
        const backupPath = path.join(this.storagePath, `${baseName}_${timestamp}.original`);
        fs.writeFileSync(backupPath, document.getText());
        
        // 호스트는 에디터를 전환하지 않고 실제 프로젝트 파일(sourcePath)에서 직접 동 편집
        
        // 게스트에게 초기 스냅샷 전송
        this.sendMessage('INIT_SNAPSHOT', { 
            fileName: virtualFileName, 
            content: document.getText(),
            assigneeId: undefined,
            assigneeName: undefined
        });
        this.addSharedFile(virtualFileName, sourcePath, backupPath);
        this.logToUI(`Started sharing: ${fileName}`);
    }



    /**
     * 사용자 이름을 변경합니다.
     * @param newName 새로운 사용자 이름.
     */
    public changeMyName(newName: string) {
        // [추가] 중복 이름 검사 (공백 제외 및 대소문자 무시 비교 권장되나 현재는 단순 비교)
        const trimmedNewName = newName.trim();
        if (!trimmedNewName) return;

        const isDuplicate = Object.entries(this.participants).some(([id, data]) => id !== this.myId && data.name === trimmedNewName);
        
        if (isDuplicate) {
            vscode.window.showWarningMessage(`"${trimmedNewName}" 이름은 이미 사용 중입니다. 다른 이름을 선택해주세요.`);
            this.pushUIUpdate(); // UI 입력을 원래 이름으로 복구하기 위해 강제 업데이트
            return;
        }

        if (this.isHost) { 
            // 호스트 이름 변경 및 명단 브로드캐스트
            this.myName = trimmedNewName; 
            this.participants['host'] = { ...this.participants['host'], name: trimmedNewName }; 
            this.broadcastUserList(); 

            // 호스트가 남긴 데코레이션의 작성자 이름 변경 및 전송
            this.decorations.forEach(d => {
                if (d.creatorId === 'host') d.creatorName = trimmedNewName;
            });
            this.broadcastDecorations();
        } else { 
            // 게스트 이름 변경 및 서버에 알림
            this.myName = trimmedNewName;
            this.sendMessage('GUEST_RENAME', { newName: trimmedNewName }); 

            // 로컬 데코레이션에 즉시 반영
            this.decorations.forEach(d => {
                if (d.creatorId === this.myId) d.creatorName = trimmedNewName;
            });
            this.refreshDecorationsInEditors();
            this.pushUIUpdate();
        }

        // 이름 변경 즉시 커서 정보도 최신 이름으로 브로드캐스트
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                const ydoc = this.yDocs.get(file.name);
                const ytext = this.yTexts.get(file.name);
                if (ydoc && ytext) {
                    const selection = editor.selection;
                    const document = editor.document;
                    try {
                        const startIndex = document.offsetAt(selection.start);
                        const endIndex = document.offsetAt(selection.end);
                        const activeIndex = document.offsetAt(selection.active);

                        const startRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, startIndex));
                        const endRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, endIndex));
                        const activeRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, activeIndex));

                        this.sendMessage('CURSOR_UPDATE', {
                            fileName: file.name,
                            userId: this.myId,
                            userName: this.myName,
                            startRel,
                            endRel,
                            activeRel
                        });
                    } catch (e) {}
                }
            }
        }
        this.pushUIUpdate();
    }

    /**
     * 참가자 명단을 모든 피어에게 브로드캐스트합니다.
     */
    private broadcastUserList() {
        if (this.isHost) {
            // 'default' ID를 제외한 참가자 목록 생성
            const filteredParticipants = { ...this.participants };
            delete filteredParticipants['default'];
            // 사용자 목록 및 방 이름 업데이트 메시지 전송
            this.sendMessage('USER_LIST_UPDATE', { users: filteredParticipants, roomName: this.roomName });
        }
        this.pushUIUpdate();
    }

    /**
     * 공유 중인 모든 파일의 내용을 브로드캐스트합니다.
     */
    private broadcastAll() { 
        // 공유 중인 각 파일에 대해 전체 내용 브로드캐스트 실행
        this.sharedFiles.forEach(f => this.broadcastFullContent(f.name, f.path)); 
    }

    /**
     * 특정 파일의 전체 내용을 브로드캐스트합니다.
     * @param fileName 파일 이름.
     * @param filePath 파일 경로.
     */
    private broadcastFullContent(fileName: string, filePath: string) {
        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file) {
            // 열려있는 문서에서 내용 가져오기, 없으면 파일 시스템에서 읽기
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
            const content = doc ? doc.getText() : fs.readFileSync(filePath, 'utf8');
            
            // 전체 동기화 메시지 전송
            this.sendMessage('SYNC_FULL', { fileName, content });
        }
    }

    /**
     * 텍스트 내용의 MD5 해시를 계산합니다.
     * @param text 해시를 계산할 텍스트.
     * @returns 16진수 해시 문자열.
     */
    private calculateHash(text: string): string {
        return crypto.createHash('md5').update(text).digest('hex');
    }

    /**
     * 엔진을 통해 메시지를 전송합니다.
     * @param type 메시지 유형.
     * @param data 메시지 데이터.
     */
    private sendMessage(type: string, data: any) { 
        if (this.isHost) {
            // 호스트일 경우 참가자들에게만 개별 전송
            Object.keys(this.participants).forEach(peerId => {
                if (peerId !== 'host') {
                    this.sendMessageToPeer(peerId, type, data);
                }
            });
        } else {
            // 게스트일 경우 허브를 통해 전송
            this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } });
        }
    }

    /**
     * 특정 피어에게 메시지를 전송합니다.
     * @param peerId 대상 피어 ID.
     * @param type 메시지 유형.
     * @param data 메시지 데이터.
     */
    private sendMessageToPeer(peerId: string, type: string, data: any) { 
        // 특정 피어에게 PeerData 형식으로 메시지 전송
        this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }, peerId); 
    }

    /**
     * 공유 파일 목록에 파일을 추가합니다.
     * @param name 파일 이름.
     * @param filePath 파일 경로.
     * @param source 원본 파일 경로 (선택 사항).
     * @param assigneeId 담당자 피어 ID (선택 사항).
     * @param assigneeName 담당자 이름 (선택 사항).
     */
    private addSharedFile(name: string, filePath: string, source?: string, assigneeId?: string, assigneeName?: string) {
        // 중복 공유 구분을 위해 고유 이름(name)을 기준으로 탐색
        let file = this.sharedFiles.find(f => f.name === name);
        if (!file) {
            file = { name, path: filePath, source, assigneeId, assigneeName };
            this.sharedFiles.push(file);
        } else {
            // 이미 있으면 정보 업데이트
            file.path = filePath;
            file.source = source;
            file.assigneeId = assigneeId;
            file.assigneeName = assigneeName;
        }

        // Yjs Doc 및 Text 객체 초기 생성 및 이벤트 바인딩
        if (!this.yDocs.has(name)) {
            const ydoc = new Y.Doc();
            const ytext = ydoc.getText('codetext');
            this.yDocs.set(name, ydoc);
            this.yTexts.set(name, ytext);

            // 호스트인 경우 원본 파일 내용을 Yjs에 채워넣음
            if (this.isHost) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    ytext.insert(0, content);
                } catch (e) {
                    this.logToUI(`Error reading original file for initial Yjs insert: ${e}`);
                }
            }

            // Yjs 문서 업데이트 이벤트 바인딩
            ydoc.on('update', (update, origin) => {
                // 원격 변경 적용 중이거나 다른 피어가 보낸 변경이라면 무한 에코 루프 방지를 위해 스킵
                if (this.isApplyingRemoteChange || origin === 'remote') return;

                const base64Update = Buffer.from(update).toString('base64');
                this.sendMessage('YJS_UPDATE', { fileName: name, update: base64Update });
            });

            // Yjs 텍스트 변경 감지 시 에디터에 반영
            ytext.observe(event => {
                if (event.transaction.origin === 'remote') {
                    this.forceUpdateEditor(name, ytext.toString(), filePath);
                }
            });
        }
        
        // [추가] 파일 추가 시 읽기 전용 상태 설정
        this.updateReadonlyState(file);
        
        // UI 상태 업데이트 알림
        this.pushUIUpdate();
    }

    /**
     * 활성화된 에디터의 파일 공유를 중지합니다.
     */
    public async stopSharing() {
        const editor = vscode.window.activeTextEditor; 
        if (!editor) return;
        
        // 현재 에디터의 파일 찾기
        const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
        if (file) await this.stopSharingByName(file.name);
    }

    /**
     * 이름으로 특정 파일 공유를 중지합니다.
     * @param fileName 중지할 파일 이름.
     */
    public async stopSharingByName(fileName: string) {
        if (!this.isHost) return;
        
        // 공유 중지 확인
        const answer = await vscode.window.showWarningMessage(`"${fileName}" 공유를 중지하시겠습니까?`, { modal: true }, "중지");
        if (answer !== "중지") return;
        
        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file && file.source) {
            // 변경 사항 저장
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
            if (doc) { 
                await doc.save();
                
                // 원본 백업 파일(file.source)과 현재 프로젝트 실제 파일(file.path)을 Diff 비교
                vscode.commands.executeCommand(
                    'vscode.diff',
                    vscode.Uri.file(file.source),
                    vscode.Uri.file(file.path),
                    `파일 비교: ${file.name} (원본 vs 협업본)`
                );
            }
            // 공유 중지 알림 전송 및 원격 처리
            this.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
        }
    }

    /**
     * 로컬 에디터 문서의 텍스트가 Yjs 내부의 진리 텍스트와 일치하는지 검증하고 강제 보정합니다.
     */
    private triggerSelfCorrection(fileName: string, filePath: string) {
        const timer = this.selfCorrectionTimers.get(fileName);
        if (timer) clearTimeout(timer);

        const newTimer = setTimeout(async () => {
            const ytext = this.yTexts.get(fileName);
            if (!ytext) return;

            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath && !d.isClosed);
            if (doc) {
                const editorText = doc.getText();
                const yjsText = ytext.toString();
                if (editorText !== yjsText) {
                    this.logToUI(`Self-correction (desync resolve) triggered for ${fileName} due to text mismatch.`);
                    await this.forceUpdateEditor(fileName, yjsText, filePath);
                }
            }
        }, 250);
        this.selfCorrectionTimers.set(fileName, newTimer);
    }

    /**
     * Yjs 상대 위치를 이용해 데코레이션(리뷰)들의 현재 절대 에디터 좌표를 역산하여 갱신합니다.
     */
    private recalculateDecorationsPositions(fileName: string, filePath: string) {
        const ydoc = this.yDocs.get(fileName);
        const ytext = this.yTexts.get(fileName);
        if (!ydoc || !ytext) return;

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath && !d.isClosed);
        if (!doc) return;

        let isModified = false;

        this.decorations.forEach(d => {
            if (d.fileName !== fileName || !d.startRel || !d.endRel) return;

            try {
                const startRelPos = Y.createRelativePositionFromJSON(d.startRel);
                const endRelPos = Y.createRelativePositionFromJSON(d.endRel);

                const startAbs = Y.createAbsolutePositionFromRelativePosition(startRelPos, ydoc);
                const endAbs = Y.createAbsolutePositionFromRelativePosition(endRelPos, ydoc);

                if (startAbs && endAbs) {
                    const newStartPos = doc.positionAt(startAbs.index);
                    const newEndPos = doc.positionAt(endAbs.index);

                    if (d.startLine !== newStartPos.line || d.startChar !== newStartPos.character ||
                        d.endLine !== newEndPos.line || d.endChar !== newEndPos.character) {
                        
                        d.startLine = newStartPos.line;
                        d.startChar = newStartPos.character;
                        d.endLine = newEndPos.line;
                        d.endChar = newEndPos.character;
                        isModified = true;
                    }
                }
            } catch (e) {
                this.logToUI(`Error recalculating position for decoration ${d.id}: ${e}`);
            }
        });

        if (isModified) {
            this.refreshDecorationsInEditors();
            this.pushUIUpdate();
            if (this.isHost) {
                this.broadcastDecorations();
            }
        }
        this.refreshAllDecorations(); // 데코레이션 보정 여부와 관계없이 상대방 사용자 커서들도 실시간 역산하여 새로 칠함
    }

    /**
     * YJS 동기화 Sync Step 1 요청을 처리합니다 (호스트 전용).
     */
    private handleYjsSyncStep1(msg: any) {
        const name = msg.fileName;
        const ydoc = this.yDocs.get(name);
        if (!ydoc) return;

        try {
            const guestStateVector = Uint8Array.from(Buffer.from(msg.stateVector, 'base64'));
            const update = Y.encodeStateAsUpdate(ydoc, guestStateVector);

            this.sendMessage('YJS_SYNC_STEP_2', {
                fileName: name,
                update: Buffer.from(update).toString('base64')
            });
        } catch (e) {
            this.logToUI(`Error in handleYjsSyncStep1: ${e}`);
        }
    }

    /**
     * YJS 동기화 Sync Step 2 응답을 처리합니다 (게스트 전용).
     */
    private async handleYjsSyncStep2(msg: any) {
        const name = msg.fileName;
        const ydoc = this.yDocs.get(name);
        if (!ydoc) return;

        try {
            const update = Uint8Array.from(Buffer.from(msg.update, 'base64'));
            this.remoteChangeLockCount++;
            Y.applyUpdate(ydoc, update, 'remote');
        } catch (e) {
            this.logToUI(`Error in handleYjsSyncStep2: ${e}`);
        } finally {
            setTimeout(() => {
                if (this.remoteChangeLockCount > 0) this.remoteChangeLockCount--;
            }, 400);
        }
    }

    /**
     * 실시간 YJS 델타 변경 패킷을 처리합니다.
     */
    private async handleYjsUpdate(msg: any) {
        const name = msg.fileName;
        const ydoc = this.yDocs.get(name);
        if (!ydoc) return;

        try {
            const updateBinary = Uint8Array.from(Buffer.from(msg.update, 'base64'));
            this.remoteChangeLockCount++;
            Y.applyUpdate(ydoc, updateBinary, 'remote');
        } catch (e) {
            this.logToUI(`Error applying Yjs update: ${e}`);
        } finally {
            setTimeout(() => {
                if (this.remoteChangeLockCount > 0) this.remoteChangeLockCount--;
            }, 400);
        }
    }

    /**
     * 원격 공유 중지 요청을 처리합니다.
     * @param fileName 중지할 파일 이름.
     */
    private async handleRemoteStop(fileName: string) {
        // 공유 파일 목록에서 인덱스 확인
        const index = this.sharedFiles.findIndex(f => f.name === fileName);
        if (index === -1) return;
        
        const file = this.sharedFiles[index];
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
        
        // 문서 닫기 및 탭 그룹에서 제거 (게스트만 수행)
        if (!this.isHost && doc) {
            // [추가] 즉시 닫기 보호 목록에 추가 (이벤트 차단)
            this.closingDocuments.add(doc.uri.fsPath);

            // [추가] 에디터가 더티 상태라면 강제 저장하여 팝업 방지
            if (doc.isDirty) {
                try { await doc.save(); } catch(e) {}
            }

            // [수정] 해당 파일을 열고 있는 모든 탭을 찾아 확실하게 닫기
            const tabsToClose = vscode.window.tabGroups.all
                .flatMap(g => g.tabs)
                .filter(t => (t.input as any)?.uri?.fsPath === file.path);

            for (const tab of tabsToClose) {
                try {
                    // [핵심] 탭이 닫힐 때까지 확실히 대기
                    await vscode.window.tabGroups.close(tab);
                } catch (e) {}
            }
        }
        
        // [추가] 에디터가 완전히 정리되기를 잠시 기다림
        await new Promise(resolve => setTimeout(resolve, 50));

        // 파일 삭제 시도 (게스트만 수행)
        if (!this.isHost && fs.existsSync(file.path)) {
            try { 
                // [추가] 읽기 전용 속성 해제 후 삭제
                fs.chmodSync(file.path, 0o666);
                fs.unlinkSync(file.path); 
            } catch(e) {}
        }
        
        // 목록에서 제거 및 동기화 맵 갱신
        this.sharedFiles.splice(index, 1);
        this.lastRemoteContentMap.delete(fileName);

        // Yjs 자원 해제
        const ydoc = this.yDocs.get(fileName);
        if (ydoc) {
            ydoc.destroy();
            this.yDocs.delete(fileName);
            this.yTexts.delete(fileName);
        }

        // 해당 파일에 남겨졌던 모든 데코레이션(리뷰) 삭제 및 에디터 갱신
        this.decorations = this.decorations.filter(d => d.fileName !== fileName);
        this.refreshDecorationsInEditors();

        this.pushUIUpdate();
    }

    /**
     * 모든 공유 및 리소스를 정리하고 중지합니다.
     */
    public async stopAll() {
        // 폴링 타이머 중지
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        
        // [수정] 공유 중인 모든 파일 공유 중지 (비동기 순차 처리)
        const fileNames = this.sharedFiles.map(f => f.name);
        for (const name of fileNames) {
            await this.handleRemoteStop(name);
        }

        // 커서 및 선택 영역 데코레이션 해제
        this.remoteCursorDecorations.forEach(d => d.dispose());
        this.remoteCursorDecorations.clear();
        this.remoteSelectionDecorations.forEach(d => d.dispose());
        this.remoteSelectionDecorations.clear();
        this.remoteCursorStates.clear();
        // 사용자 색상 맵 초기화
        this.userColorMap.clear();
    }

    /**
     * 특정 피어를 강제로 퇴장시킵니다. (호스트 전용)
     * @param peerId 퇴장시킬 피어 ID.
     */
    public kickPeer(peerId: string) {
        if (!this.isHost) return;

        // 퇴장 메시지 전송
        this.sendMessageToPeer(peerId, 'KICKED', { reason: '호스트에 의해 방에서 퇴장되었습니다.' });

        // 로컬에서 즉시 연결 해제 처리
        this.handlePeerDisconnect(peerId);
    }

    /**
     * 피어 연결 해제 이벤트를 처리합니다.
     * @param peerId 연결이 해제된 피어 ID.
     */
    public handlePeerDisconnect(peerId: string) {
        if (!this.isHost) {
            // 게스트일 경우 호스트 연결 손실 알림
            if (peerId === 'default' || peerId === 'all') { 
                vscode.window.showErrorMessage("호스트와의 연결이 끊겼습니다."); 
                this.reset(); 
            }
        } else {
            // 호스트일 경우 참가자 제거 및 UI 알림
            const disconnectedName = this.participants[peerId] || '누군가';
            vscode.window.setStatusBarMessage(`P2P: ${disconnectedName}님이 방을 나갔습니다.`, 3000);
            delete this.participants[peerId];
            
            // 해당 피어의 데코레이션 및 색상 정리
            const deco = this.remoteCursorDecorations.get(peerId); 
            if (deco) deco.dispose(); 
            this.remoteCursorDecorations.delete(peerId);
            this.remoteCursorStates.delete(peerId);
            
            const selDeco = this.remoteSelectionDecorations.get(peerId); 
            if (selDeco) selDeco.dispose(); 
            this.remoteSelectionDecorations.delete(peerId);
            
            this.userColorMap.delete(peerId); 
            this.pushUIUpdate(); 
            this.broadcastUserList();
        }
    }

    /**
     * 엔진의 모든 상태를 초기화합니다.
     */
    public reset(skipUIUpdate = false) {
        // 타이머 중지 및 리소스 정리
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.stopAll();
        
        // 모든 상태 변수 초기화
        this.isHost = false; 
        this.isConnected = false; 
        this.connectionType = 'Direct';
        this.roomName = ''; 
        this.myName = ''; 
        this.myId = ''; 
        this.initialName = ''; 
        this.participants = {}; 
        this.isSetupMode = false; 
        this.isStorageInitialized = false; 
        this.lastRemoteContentMap.clear();

        // Yjs 자원 초기화
        this.yDocs.forEach(d => d.destroy());
        this.yDocs.clear();
        this.yTexts.clear();

        // 데코레이션 초기화
        this.decorations = [];
        this.refreshDecorationsInEditors();
        
        // UI 상태 갱신
        if (!skipUIUpdate) {
            this.pushUIUpdate();
        }
    }

    /**
     * 전체 동기화를 위해 주기적인 폴링을 시작합니다.
     */
    private startPolling() {
        // 기존 폴링 타이머 중지
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        
        if (this.isHost) {
            // 호스트: 1초마다 공유 파일 해시 브로드캐스트
            this.pollingTimer = setInterval(() => {
                this.sharedFiles.forEach(f => {
                    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f.path);
                    const content = doc ? doc.getText() : fs.readFileSync(f.path, 'utf8');
                    this.sendMessage('FILE_HASH', { fileName: f.name, hash: this.calculateHash(content) });
                });
            }, 1000);
        } else {
            // 게스트: 5초마다 전체 동기화 요청 (기존 방식 유지 - 백업용)
            this.pollingTimer = setInterval(() => { 
                if (this.sharedFiles.length > 0) this.sendMessage('REQUEST_FULL_SYNC', {}); 
            }, 5000);
        }
    }

    /**
     * 엔진 웹뷰에 상태를 업데이트합니다.
     */
    private updateStatus(status: string) {
        let finalStatus = status;
        if (status === 'Connected' && this.connectionType === 'TURN') {
            finalStatus = 'Connected (via TURN)';
        }
        this.logToUI(`Status: ${finalStatus}`);
        this.hub.sendToEngine({ type: 'status', status: finalStatus });
    }

    /**
     * 데코레이션 목록을 참가자들에게 공유합니다. (호스트 전용)
     */
    private broadcastDecorations() {
        if (!this.isHost) return;
        Object.keys(this.participants).forEach(peerId => {
            if (peerId !== 'host') {
                const filtered = this.decorations.filter(d => d.visibility !== 'host' || d.creatorId === peerId);
                this.sendMessageToPeer(peerId, 'SYNC_DECORATIONS', { decorations: filtered });
            }
        });
        this.refreshDecorationsInEditors();
        this.pushUIUpdate();
    }

    /**
     * 에디터에 데코레이션을 렌더링합니다.
     */
    private refreshDecorationsInEditors() {
        const visibleEditors = vscode.window.visibleTextEditors;
        visibleEditors.forEach(editor => {
            const document = editor.document;
            const file = this.sharedFiles.find(f => f.path === document.uri.fsPath);
            if (!file) {
                // 공유 파일이 아닌 경우 데코레이션 제거
                editor.setDecorations(this.typoDecoType, []);
                editor.setDecorations(this.grammarDecoType, []);
                editor.setDecorations(this.logicalDecoType, []);
                editor.setDecorations(this.otherDecoType, []);
                editor.setDecorations(this.highlightDecoType, []);
                return;
            }

            const editorConfig = vscode.workspace.getConfiguration('editor', editor.document.uri);
            const editorFontSize = editorConfig.get<number>('fontSize') || 14;
            const badgeFontSize = Math.max(9, Math.round(editorFontSize * 0.8));

            // 본인에게 보이는 데코레이션 필터링
            const fileDecos = this.decorations.filter(d => d.fileName === file.name);
            const visibleDecos = fileDecos.filter(d => {
                if (d.visibility === 'host') {
                    return this.isHost || d.creatorId === this.myId;
                }
                return true;
            });

            const decosByType: { [key: string]: vscode.DecorationOptions[] } = {
                Typo: [],
                Grammar: [],
                Logical: [],
                Other: [],
                Highlight: []
            };

            visibleDecos.forEach(d => {
                const range = new vscode.Range(
                    new vscode.Position(d.startLine, d.startChar),
                    new vscode.Position(d.endLine, d.endChar)
                );

                const hoverMarkdown = new vscode.MarkdownString();
                hoverMarkdown.isTrusted = true;
                const typeName = d.type === 'Typo' ? '오타' :
                                 d.type === 'Grammar' ? '문법 오류' :
                                 d.type === 'Logical' ? '논리 오류' :
                                 d.type === 'Other' ? '기타' : '하이라이트';

                hoverMarkdown.appendMarkdown(`### 🔍 [${typeName}] \n\n`);
                hoverMarkdown.appendMarkdown(`**작성자:** ${d.creatorName} (${d.creatorId === 'host' ? 'Host' : 'Guest'})\n\n`);
                if (d.memo) {
                    hoverMarkdown.appendMarkdown(`**메모:** ${d.memo}\n\n`);
                }

                // 삭제 권한이 있는 경우 툴팁에 삭제 버튼 추가
                const canDelete = this.isHost || d.creatorId === this.myId;
                if (canDelete) {
                    const deleteCommandUri = vscode.Uri.parse(`command:p2p-code-share.deleteDecoration?${encodeURIComponent(JSON.stringify(d.id))}`);
                    hoverMarkdown.appendMarkdown(`[🗑️ 삭제하기](${deleteCommandUri})`);
                }

                const badgeColor = d.type === 'Typo' ? '#d9534f' :
                                   d.type === 'Grammar' ? '#f0ad4e' :
                                   d.type === 'Logical' ? '#d9534f' :
                                   d.type === 'Other' ? '#5bc0de' : '#5cb85c';

                decosByType[d.type].push({
                    range,
                    hoverMessage: hoverMarkdown,
                    renderOptions: {
                        after: {
                            contentText: `[${typeName}]`,
                            color: 'white',
                            backgroundColor: badgeColor,
                            margin: '1.4em 0 0 0.2ch',
                            fontWeight: 'bold',
                            textDecoration: `none; font-size: ${badgeFontSize}px; padding: 1px 4px; border-radius: 3px; position: absolute; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3); z-index: 999; text-shadow: -1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.8);`
                        }
                    }
                });
            });

            editor.setDecorations(this.typoDecoType, decosByType['Typo']);
            editor.setDecorations(this.grammarDecoType, decosByType['Grammar']);
            editor.setDecorations(this.logicalDecoType, decosByType['Logical']);
            editor.setDecorations(this.otherDecoType, decosByType['Other']);
            editor.setDecorations(this.highlightDecoType, decosByType['Highlight']);
        });
    }

    /**
     * 우클릭 메뉴를 통해 데코레이션을 추가하는 플로우입니다.
     */
    public async addDecorationFlow() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const document = editor.document;
        const file = this.sharedFiles.find(f => f.path === document.uri.fsPath);
        if (!file) {
            vscode.window.showWarningMessage("공유 중인 파일에서만 데코레이션을 추가할 수 있습니다.");
            return;
        }

        const selection = editor.selection;

        const typePick = await vscode.window.showQuickPick([
            { label: 'Typo (오타)', value: 'Typo' },
            { label: 'Grammar Error (문법 오류)', value: 'Grammar' },
            { label: 'Logical Error (논리 오류)', value: 'Logical' },
            { label: 'Other (기타)', value: 'Other' },
            { label: 'Highlight (하이라이트)', value: 'Highlight' }
        ], { placeHolder: '데코레이션 종류를 선택하세요' });

        if (!typePick) return;

        const visibilityPick = await vscode.window.showQuickPick([
            { label: 'Everyone (모두에게 보이기)', value: 'everyone' },
            { label: 'Host only (host에게만 보이기)', value: 'host' }
        ], { placeHolder: '공개 범위를 선택하세요' });

        if (!visibilityPick) return;

        const memo = await vscode.window.showInputBox({
            prompt: '메모 내용을 입력하세요',
            placeHolder: '여기에 메모 내용을 입력할 수 있습니다.'
        });

        if (memo === undefined) return;

        const ydoc = this.yDocs.get(file.name);
        const ytext = this.yTexts.get(file.name);
        let startRel: any = undefined;
        let endRel: any = undefined;

        if (ydoc && ytext) {
            const startIndex = document.offsetAt(selection.start);
            const endIndex = document.offsetAt(selection.end);
            startRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, startIndex));
            endRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, endIndex));
        }

        const newDeco: FileDecoration = {
            id: crypto.randomBytes(8).toString('hex'),
            fileName: file.name,
            startLine: selection.start.line,
            startChar: selection.start.character,
            endLine: selection.end.line,
            endChar: selection.end.character,
            type: typePick.value as any,
            visibility: visibilityPick.value as any,
            creatorId: this.myId,
            creatorName: this.myName || 'Anonymous',
            memo: memo || '',
            startRel,
            endRel
        };

        if (this.isHost) {
            this.decorations.push(newDeco);
            this.broadcastDecorations();
        } else {
            this.sendMessage('ADD_DECORATION', { decoration: newDeco });
        }
        
        this.refreshDecorationsInEditors();
        this.pushUIUpdate();
    }

    /**
     * 지정된 ID의 데코레이션을 삭제합니다.
     */
    public deleteDecoration(id: string) {
        if (this.isHost) {
            this.decorations = this.decorations.filter(d => d.id !== id);
            this.broadcastDecorations();
        } else {
            const deco = this.decorations.find(d => d.id === id);
            if (deco && deco.creatorId === this.myId) {
                this.sendMessage('DELETE_DECORATION', { id });
                // 게스트는 호스트 응답 전 로컬 상태를 우선 업데이트하여 화면 전환 반응성을 높임
                this.decorations = this.decorations.filter(d => d.id !== id);
                this.refreshDecorationsInEditors();
                this.pushUIUpdate();
            } else {
                vscode.window.showWarningMessage("본인이 작성한 데코레이션만 삭제할 수 있습니다.");
            }
        }
    }

    /**
     * 해당 데코레이션이 작성된 파일과 라인 위치로 이동합니다.
     */
    public jumpToDecoration(fileName: string, line: number, char: number) {
        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file) {
            vscode.workspace.openTextDocument(file.path).then(doc => {
                vscode.window.showTextDocument(doc).then(editor => {
                    const pos = new vscode.Position(line, char);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                });
            });
        }
    }

    /**
     * UI 웹뷰에 로그를 출력합니다.
     */
    private logToUI(message: string) {
        // UI 콜백을 활용하여 로그 메시지 전달
        this.updateUI({ 
            type: 'log', 
            message,
            // 로그와 함께 현재 상태도 전달하여 UI가 초기화되지 않도록 함
            participants: this.participants,
            roomName: this.roomName,
            files: this.sharedFiles,
            isConnected: this.isConnected
        });
    }

    /**
     * 현재 상태를 바탕으로 UI 업데이트를 실행합니다.
     */
    public pushUIUpdate() { 
        // 사용자에게 보일 수 있는 데코레이션만 필터링 (host만 보기 설정인 경우 creator 및 host만 보임)
        const visibleDecos = this.decorations.filter(d => {
            if (d.visibility === 'host') {
                return this.isHost || d.creatorId === this.myId;
            }
            return true;
        });

        // UI 콜백을 호출하여 현재 상태 전달
        this.updateUI({ 
            type: 'renderParticipants', 
            myName: this.myName, 
            myId: this.myId, 
            others: this.participants, 
            roomName: this.roomName, 
            files: this.sharedFiles, 
            isSetupMode: this.isSetupMode, 
            isConnected: this.isConnected,
            connectionType: this.connectionType,
            // [핵심] 현재 초대 중인 아이디 목록 및 참여 요청 목록을 UI로 전달
            pendingInvites: Array.from(this.pendingInvites),
            joinRequests: this.joinRequests,
            decorations: visibleDecos
        });
        this.updateActiveFileSharedContext();
    }

    /**
     * 현재 활성화된 에디터의 파일이 공유 중인지 여부를 VS Code context에 업데이트합니다.
     */
    public updateActiveFileSharedContext() {
        const editor = vscode.window.activeTextEditor;
        const isShared = editor ? this.sharedFiles.some(f => f.path === editor.document.uri.fsPath) : false;
        vscode.commands.executeCommand('setContext', 'p2pCodeShare.isActiveFileShared', isShared);
    }
}
