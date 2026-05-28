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
import { SharedFile, P2PMessage, PeerPermission } from '../types';
// 경로 정리 및 디렉토리 생성을 위한 유틸리티
import { sanitizePath, ensureDirectory } from '../utils/helpers';

/**
 * SyncEngine 클래스.
 * 파일 공유, 커서 및 피어 상태에 대한 동기화 로직을 처리합니다.
 */
export class SyncEngine {
    private isApplyingRemoteChange = false;
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
                    case 'ON_CONNECTED': 
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
                        break;
                    case 'ASSIGN_PEER_ID':
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
                        break;
                    case 'INIT_SNAPSHOT': 
                        // 로컬 저장소 및 게스트 스냅샷 초기화
                        if (!this.isStorageInitialized) this.initializeStorage();
                        await this.handleGuestInit(msg); 
                        break;
                    case 'SYNC_FULL': await this.forceUpdateEditor(msg.fileName, msg.content); break;
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
                        }
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'GUEST_EDIT': if (this.isHost) { await this.handleGuestEdit(msg); } break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastAll(); break;
                    case 'FILE_HASH':
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
                        break;
                    case 'FILE_ASSIGNEE_UPDATE':
                        if (!this.isHost) {
                            const file = this.sharedFiles.find(f => f.name === msg.fileName);
                            if (file) {
                                file.assigneeId = msg.assigneeId;
                                file.assigneeName = msg.assigneeName;
                                await this.updateReadonlyState(file);
                                this.pushUIUpdate();
                            }
                        }
                        break;
                    case 'STOP_SHARING': await this.handleRemoteStop(msg.fileName); break;
                    case 'CURSOR_UPDATE': 
                        // 커서 및 선택 영역 업데이트 처리
                        const senderId = msg.userId || peerId; 
                        this.updateRemoteCursor(msg, senderId); 
                        if (this.isHost) this.broadcastCursor(msg, senderId);
                        break;
                    case 'JOIN_REQUEST':
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
                        break;
                    case 'JOIN_RESPONSE':
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
                        break;
                    case 'KICKED':
                        // [추가] 강제 퇴장 처리 (게스트 전용)
                        if (!this.isHost) {
                            vscode.window.showErrorMessage(`퇴장되었습니다: ${msg.reason}`);
                            this.reset();
                        }
                        break;
                    case 'SET_PERMISSION':
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
                        break;
                }
            } catch (e) {}
        };
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

    /**
     * 텍스트 에디터 선택 영역 변경 이벤트 리스너를 설정합니다.
     */
    private setupSelectionListeners() {
        vscode.window.onDidChangeTextEditorSelection(e => {
            // [핵심] myId가 정상적으로 할당된 경우에만 전송
            if (!this.myId || this.myId === 'default' || this.myId === '') return;

            const file = this.sharedFiles.find(f => f.path === e.textEditor.document.uri.fsPath);
            if (!file) return;
            const selection = e.selections[0];
            // 커서 및 선택 영역 정보 브로드캐스트
            this.sendMessage('CURSOR_UPDATE', {
                fileName: file.name,
                userId: this.myId,
                userName: this.myName,
                cursorPos: [selection.active.line, selection.active.character],
                selectionRange: [selection.start.line, selection.start.character, selection.end.line, selection.end.character]
            });
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

    /**
     * 특정 파일의 모든 원격 커서를 다시 그립니다. (동일 위치 겹침 방지)
     * @param file 렌더링할 공유 파일.
     */
    private renderCursorsForFile(file: SharedFile) {
        // 해당 파일에 있는 모든 원격 피어 필터링
        const peersInFile = Array.from(this.remoteCursorStates.entries())
            .filter(([id, state]) => state.fileName === file.name && id !== this.myId);

        // 위치별 피어 그룹화 (line,char -> [peerId1, peerId2, ...])
        const posGroups = new Map<string, string[]>();
        peersInFile.forEach(([id, state]) => {
            const key = `${state.cursorPos[0]},${state.cursorPos[1]}`;
            if (!posGroups.has(key)) posGroups.set(key, []);
            posGroups.get(key)!.push(id);
        });

        // 각 위치 그룹 내에서 피어 ID 순으로 정렬 (안정적인 랭킹 부여)
        posGroups.forEach(ids => ids.sort());

        // 각 피어별로 랭킹에 따른 데코레이션 적용
        peersInFile.forEach(([peerId, state]) => {
            const key = `${state.cursorPos[0]},${state.cursorPos[1]}`;
            const group = posGroups.get(key)!;
            const rank = group.indexOf(peerId);
            
            this.applyPeerDecoration(peerId, state, file, rank);
        });
    }

    /**
     * 개별 피어의 데코레이션을 생성하고 적용합니다.
     * @param peerId 피어 ID.
     * @param state 커서 상태.
     * @param file 대상 파일.
     * @param rank 해당 위치에서의 랭킹 (0부터 시작, 수직 오프셋 결정).
     */
    private applyPeerDecoration(peerId: string, state: any, file: SharedFile, rank: number) {
        // 이전 데코레이션 정리
        const prevCursor = this.remoteCursorDecorations.get(peerId);
        if (prevCursor) prevCursor.dispose();
        const prevSelection = this.remoteSelectionDecorations.get(peerId);
        if (prevSelection) prevSelection.dispose();

        const color = this.getUserColor(peerId); 
        // 랭킹에 따라 수직 오프셋 계산 (기본 1.4em 아래부터 시작하여 랭크당 약 1.5em씩 추가)
        const verticalOffset = 1.4 + (rank * 1.5);

        // 새 커서 데코레이션 생성
        const cursorDeco = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: color,
            after: {
                contentText: state.userName || 'Anonymous', 
                backgroundColor: color, color: 'white', 
                margin: `${verticalOffset}em 0 0 0`, 
                fontWeight: 'bold',
                textDecoration: `none; font-size: 11px; padding: 1px 4px; border-radius: 3px; position: absolute; z-index: ${1000 - rank}; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3);`
            }
        });
        // 새 선택 영역 데코레이션 생성
        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        
        this.remoteCursorDecorations.set(peerId, cursorDeco);
        this.remoteSelectionDecorations.set(peerId, selectionDeco);
        
        const cursorRange = [new vscode.Range(new vscode.Position(state.cursorPos[0], state.cursorPos[1]), new vscode.Position(state.cursorPos[0], state.cursorPos[1]))];
        const selectionRange = [new vscode.Range(new vscode.Position(state.selectionRange[0], state.selectionRange[1]), new vscode.Position(state.selectionRange[2], state.selectionRange[3]))];

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

        // 스냅샷 경로 생성 및 파일 쓰기
        const snapshotPath = path.join(this.storagePath, msg.fileName + '.shared');
        this.logToUI(`Writing snapshot to: ${snapshotPath}`);
        fs.writeFileSync(snapshotPath, msg.content);
        
        // [수정] 파일 목록에 먼저 추가 (여기서 읽기 전용 상태가 설정됨)
        this.addSharedFile(msg.fileName, snapshotPath, undefined, msg.assigneeId, msg.assigneeName);

        // 문서 열기 및 표시
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
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

    /**
     * 게스트의 편집 내용을 처리합니다.
     * @param msg 편집 메시지 (파일 이름 및 내용 포함).
     */
    private async handleGuestEdit(msg: any) {
        // 편집 대상 파일 찾기
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (file) { 
            // 에디터 강제 업데이트 및 전체 내용 브로드캐스트
            await this.forceUpdateEditor(msg.fileName, msg.content, file.path); 
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
        // 에디터 변경 감지 (새로 열거나 탭 전환 시 읽기 전용 상태 동기화)
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (!editor || this.isHost) return;
            const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                const canEdit = this.canIEdit(file.name);
                await this.applyEditorReadonlyState(editor, !canEdit);
            }
        });

        vscode.workspace.onDidChangeTextDocument(e => {
            // [수정] 원격 변경 적용 중이거나, 문서가 닫히는 중이면 동기화 무시
            if (this.isApplyingRemoteChange || this.closingDocuments.has(e.document.uri.fsPath)) return;
            
            const file = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!file) return;

            // [추가] 권한 체크
            if (!this.canIEdit(file.name)) {
                this.logToUI(`Blocked unauthorized edit on ${file.name}`);
                // TODO: Undo 로직 추가 가능
                return;
            }

            // [핵심] 실제 사용자의 타이핑인지 확인
            const isManualChange = e.contentChanges.length > 0;
            if (!isManualChange) return;

            // [추가] 타이핑 속도에 따른 적응형 디바운싱
            const now = Date.now();
            const timeSinceLastKeystroke = now - this.lastKeystrokeTime;
            this.lastKeystrokeTime = now;

            // 타이핑이 빠를수록(예: < 300ms) 디바운스 시간을 줄이고(예: 50ms), 느리면 늘림(예: 200ms)
            const dynamicDelay = timeSinceLastKeystroke < 300 ? 50 : 200;

            if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
            this.syncDebounceTimer = setTimeout(() => {
                const text = e.document.getText();
                if (text === this.lastRemoteContentMap.get(file.name)) return;

                this.lastRemoteContentMap.set(file.name, text);
                // 호스트 여부에 따라 동기화 메시지 전송
                this.sendMessage(this.isHost ? 'SYNC_FULL' : 'GUEST_EDIT', { fileName: file.name, content: text });
            }, dynamicDelay);
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
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (!doc) { 
            fs.writeFileSync(filePath, content); 
            return; 
        }
        
        const oldText = doc.getText();
        
        // [수정] 내용이 이미 같더라도 디스크 파일은 최신 상태로 업데이트
        // (게스트가 'Don't Save'로 닫을 때 최신 상태로 복구되도록 보장)
        if (oldText === content) {
            try { 
                const currentMode = fs.statSync(filePath).mode;
                const wasReadonly = (currentMode & 0o200) === 0;
                if (wasReadonly) fs.chmodSync(filePath, 0o666);
                fs.writeFileSync(filePath, content); 
                if (wasReadonly) fs.chmodSync(filePath, 0o444);
            } catch(e) {}
            return;
        }

        // 원격 변경 사항 적용 플래그 설정
        this.lastRemoteContentMap.set(fileName, content);

        // [추가] 쓰기 전 잠시 읽기 전용 속성 해제
        const currentMode = fs.statSync(filePath).mode;
        const wasReadonly = (currentMode & 0o200) === 0;
        if (wasReadonly) fs.chmodSync(filePath, 0o666);

        this.isApplyingRemoteChange = true;

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
            
            // [추가] 에디터 적용 직후 디스크 파일도 즉시 동기화
            try { fs.writeFileSync(filePath, content); } catch(e) {}
        } finally {
            // [추가] 속성 복구
            if (wasReadonly) fs.chmodSync(filePath, 0o444);
            // 변경 사항 적용 후 플래그 해제
            setTimeout(() => { this.isApplyingRemoteChange = false; }, 100);
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
        if (this.sharedFiles.find(f => f.source === sourcePath)) return;
        
        // 공유 스냅샷 파일 생성 및 저장
        const snapshotPath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(snapshotPath, document.getText());
        
        // 스냅샷 문서 열기 및 표시
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        
        // 게스트에게 초기 스냅샷 전송
        this.sendMessage('INIT_SNAPSHOT', { 
            fileName, 
            content: document.getText(),
            assigneeId: undefined,
            assigneeName: undefined
        });
        this.addSharedFile(fileName, snapshotPath, sourcePath);
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
        } else { 
            // 게스트 이름 변경 및 서버에 알림
            this.myName = trimmedNewName;
            this.sendMessage('GUEST_RENAME', { newName: trimmedNewName }); 
        }

        // 이름 변경 즉시 커서 정보도 최신 이름으로 브로드캐스트
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const file = this.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                const selection = editor.selection;
                this.sendMessage('CURSOR_UPDATE', {
                    fileName: file.name,
                    userId: this.myId,
                    userName: this.myName,
                    cursorPos: [selection.active.line, selection.active.character],
                    selectionRange: [selection.start.line, selection.start.character, selection.end.line, selection.end.character]
                });
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
        // 열려있는 문서에서 내용 가져오기, 없으면 파일 시스템에서 읽기
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const content = doc ? doc.getText() : fs.readFileSync(filePath, 'utf8');
        // 전체 동기화 메시지 전송
        this.sendMessage('SYNC_FULL', { fileName, content });
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
        // 이미 목록에 없으면 파일 추가
        let file = this.sharedFiles.find(f => f.path === filePath);
        if (!file) {
            file = { name, path: filePath, source, assigneeId, assigneeName };
            this.sharedFiles.push(file);
        } else {
            // 이미 있으면 정보 업데이트
            file.assigneeId = assigneeId;
            file.assigneeName = assigneeName;
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
            // 변경 사항 저장 및 원본 파일 업데이트
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
            if (doc) { 
                await doc.save(); 
                fs.writeFileSync(file.source, doc.getText()); 
            }
            // 공유 중지 알림 전송 및 원격 처리
            this.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
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
        
        // 문서 닫기 및 탭 그룹에서 제거
        if (doc) {
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

        // 파일 삭제 시도
        if (fs.existsSync(file.path)) {
            try { 
                // [추가] 읽기 전용 속성 해제 후 삭제
                fs.chmodSync(file.path, 0o666);
                fs.unlinkSync(file.path); 
            } catch(e) {}
        }
        
        // 목록에서 제거 및 동기화 맵 갱신
        this.sharedFiles.splice(index, 1);
        this.lastRemoteContentMap.delete(fileName);
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
    public reset() {
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
        
        // UI 상태 갱신
        this.pushUIUpdate();
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
            joinRequests: this.joinRequests
        });
    }
}
