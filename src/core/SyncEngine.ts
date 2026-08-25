/**
 * @file SyncEngine.ts
 * @description 피어 간 파일 내용, 커서 및 상태를 동기화하기 위한 핵심 엔진입니다.
 * 각 서브매니저들을 조정하는 Orchestrator 역할을 수행합니다.
 */

import * as vscode from 'vscode';
import { HubManager } from './HubManager';
import { SharedFile, P2PMessage, PeerPermission, FileDecoration, ChatMessage } from '../types';
import { ChatPanel } from '../ui/ChatPanel';

import { FileStorageManager } from './sync/FileStorageManager';
import { ParticipantManager } from './sync/ParticipantManager';
import { CursorManager } from './sync/CursorManager';
import { DecorationManager } from './sync/DecorationManager';
import { DocumentSyncManager } from './sync/DocumentSyncManager';

export class SyncEngine {
    // 채팅 관련 속성
    public chatHistory: ChatMessage[] = [];
    public chatPanel?: ChatPanel;
    public unreadChatCount = 0; // 안 읽은 메시지 수 카운터
    public isFollowMeMode = false; // [추가] 화면 동기화(팔로우) 활성화 여부


    // 서브 매니저 인스턴스
    public fileStorageManager: FileStorageManager;
    public participantManager: ParticipantManager;
    public cursorManager: CursorManager;
    public decorationManager: DecorationManager;
    public documentSyncManager: DocumentSyncManager;

    // 공통 상태 변수
    public isHost = false; 
    public myName = '';
    public myId = ''; 
    public initialName = '';
    public roomName = ''; 
    public isSetupMode = false; 
    public isConnected = false; 
    public connectionType = 'Direct';

    // 기존 속성과의 하위 호환성 매핑 (Getter/Setter)
    public get sharedFiles(): SharedFile[] {
        return this.fileStorageManager.sharedFiles;
    }
    public get participants(): { [key: string]: PeerPermission } {
        return this.participantManager.participants;
    }
    public get decorations(): FileDecoration[] {
        return this.decorationManager.decorations;
    }
    public get cursorFilter(): 'host' | 'editable' | 'all' {
        return this.cursorManager.cursorFilter;
    }

    constructor(
        public hub: HubManager,
        public context: vscode.ExtensionContext,
        private updateUI: (state: any) => void
    ) {
        // 매니저 초기화
        this.fileStorageManager = new FileStorageManager(this);
        this.participantManager = new ParticipantManager(this);
        this.cursorManager = new CursorManager(this);
        this.decorationManager = new DecorationManager(this);
        this.documentSyncManager = new DocumentSyncManager(this);

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
                    case 'FOLLOW_UPDATE':
                        // 게스트가 호스트의 화면 위치를 추적하여 동기화
                        if (!this.isHost) {
                            await this.handleFollowUpdate(msg.fileName, msg.startLine, msg.endLine);
                        }
                        break;
                    case 'INIT_SNAPSHOT': 
                        if (!this.fileStorageManager.isStorageInitialized) {
                            this.fileStorageManager.initializeStorage();
                        }
                        await this.documentSyncManager.handleGuestInit(msg); 
                        break;
                    case 'YJS_SYNC_STEP_1': this.documentSyncManager.handleYjsSyncStep1(msg); break;
                    case 'YJS_SYNC_STEP_2': await this.documentSyncManager.handleYjsSyncStep2(msg); break;
                    case 'YJS_UPDATE': await this.documentSyncManager.handleYjsUpdate(msg); break;
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
                        if (this.isHost) { 
                            this.participantManager.participants[peerId] = { 
                                ...(this.participantManager.participants[peerId] || { globalCanEdit: false, filePermissions: {} }), 
                                name: msg.newName 
                            }; 
                            this.participantManager.broadcastUserList(); 

                            // 해당 게스트가 남긴 데코레이션의 작성자 이름 변경 및 브로드캐스트
                            this.decorationManager.decorations.forEach(d => {
                                if (d.creatorId === peerId) d.creatorName = msg.newName;
                            });
                            this.decorationManager.broadcastDecorations();
                        }
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
                    case 'JOIN_RESPONSE': this.participantManager.handleJoinResponse(msg); break;
                    case 'KICKED': this.participantManager.handleKicked(msg); break;
                    case 'SET_PERMISSION': await this.participantManager.handleSetPermission(msg); break;
                    case 'ADD_DECORATION':
                        if (this.isHost) {
                            this.decorationManager.decorations.push(msg.decoration);
                            this.decorationManager.broadcastDecorations();
                        }
                        break;
                    case 'DELETE_DECORATION':
                        if (this.isHost) {
                            const deco = this.decorationManager.decorations.find(d => d.id === msg.id);
                            if (deco && (deco.creatorId === peerId || peerId === 'host')) {
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
                }
            } catch (e) {}
        };
    }

    private handleOnConnected(peerId: string) {
        this.logToUI(`ON_CONNECTED received: ${peerId}`);
        if (this.isHost) {
            if (this.participantManager.pendingInvites.has(peerId)) {
                this.isSetupMode = false;
                this.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
                this.participantManager.pendingInvites.delete(peerId);
            }
        } else {
            if (!this.participantManager.isAutoJoin) {
                this.isConnected = true;
                this.isSetupMode = false;
                this.logToUI("Manual connection complete");
                this.updateStatus('Connected');
            } else {
                this.logToUI("Connected to host, waiting for join approval...");
                this.updateStatus('Waiting...');
            }
        }
        this.pushUIUpdate();
    }

    private handleAssignPeerId(msg: any) {
        if (!this.isHost) {
            this.logToUI(`ASSIGN_PEER_ID received: ${msg.peerId}`);
            const oldId = this.myId || 'default';
            this.myId = msg.peerId;
            this.myName = msg.peerId; 
            this.initialName = this.myId; 
            this.fileStorageManager.isStorageInitialized = false; 
            this.fileStorageManager.initializeStorage(); 
            
            // UI에 피어 ID 변경 알림
            this.sendMessage('updatePeerId', { oldId, newId: this.myId });
            
            if (this.participantManager.isAutoJoin && this.participantManager.pendingJoinRequest) {
                this.sendMessage('JOIN_REQUEST', { 
                    name: this.myId, 
                    description: this.participantManager.pendingJoinRequest.description 
                });
                this.participantManager.pendingJoinRequest = null;
                // 호스트에게 요청을 정상 송신했으므로 초기 연결 타임아웃 해제
                this.participantManager.clearJoinTimeout();
            }
            
            this.sendMessage('GUEST_JOIN', { name: this.myName }); 
            this.pushUIUpdate();
        }
    }

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
        
        if (!this.isHost && this.myId) {
            const myData = this.participantManager.participants[this.myId] || this.participantManager.participants['default'];
            if (myData) {
                this.myName = myData.name;
            }
        }
        
        await this.fileStorageManager.updateAllReadonlyStates();
        this.pushUIUpdate();
        this.cursorManager.refreshAllDecorations();
    }

    private broadcastCursor(msg: any, senderId: string) {
        this.hub.sendToEngine({ type: 'peerData', value: { type: 'CURSOR_UPDATE', ...msg } });
    }

    /**
     * 텍스트 문서 변경 이벤트 리스너를 설정합니다.
     */
    private setupTextListeners() {
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            this.updateActiveFileSharedContext();
            if (!editor) return;

            // [추가] 호스트 활성 탭 전환 시 화면 추적 동기화
            if (this.isHost && this.isFollowMeMode) {
                const file = this.fileStorageManager.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
                if (file && editor.visibleRanges.length > 0) {
                    const range = editor.visibleRanges[0];
                    this.sendMessage('FOLLOW_UPDATE', {
                        fileName: file.name,
                        startLine: range.start.line,
                        endLine: range.end.line
                    });
                }
            }

            if (this.isHost) return;
            const file = this.fileStorageManager.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                const canEdit = this.participantManager.canIEdit(file.name);
                await this.fileStorageManager.applyEditorReadonlyState(editor, !canEdit);
            }
        });

        // [추가] 호스트 스크롤 변경 시 화면 추적 동기화
        vscode.window.onDidChangeTextEditorVisibleRanges(e => {
            if (this.isHost && this.isFollowMeMode) {
                const file = this.fileStorageManager.sharedFiles.find(f => f.path === e.textEditor.document.uri.fsPath);
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
            const file = this.fileStorageManager.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!file) return;

            if (this.documentSyncManager.isApplyingRemoteChange || this.fileStorageManager.closingDocuments.has(e.document.uri.fsPath)) return;

            // 권한 체크
            if (!this.participantManager.canIEdit(file.name)) {
                this.logToUI(`Blocked unauthorized edit on ${file.name}`);
                return;
            }

            const ydoc = this.documentSyncManager.yDocs.get(file.name);
            const ytext = this.documentSyncManager.yTexts.get(file.name);
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

            this.decorationManager.debouncedRecalculateDecorations(file.name, file.path);
            this.documentSyncManager.triggerSelfCorrection(file.name, file.path);
        });

        vscode.workspace.onWillSaveTextDocument(e => {
            if (!this.isHost && this.fileStorageManager.sharedFiles.some(f => f.path === e.document.uri.fsPath)) {
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
        this.roomName = msg.roomName || 'Untitled Room';
        this.myName = this.isHost ? 'Host' : '';
        this.initialName = this.myName;
        this.logToUI(`Role set: ${this.isHost ? 'Host' : 'Guest'} for room "${this.roomName}"`);
        this.updateStatus('Initializing...');

        if (this.isHost) { 
            this.isSetupMode = false;
            this.fileStorageManager.initializeStorage(); 
            this.participantManager.participants['host'] = { name: this.myName, globalCanEdit: true, filePermissions: {} }; 
            this.hub.createHub(true, this.roomName, 'none'); 
            
            if (this.roomName && this.roomName !== 'Untitled Room') {
                this.participantManager.inviteGuest(true);
            }
        } else { 
            this.isSetupMode = (this.roomName && this.roomName !== 'Untitled Room') ? false : true; 
            this.hub.createHub(false, this.roomName, 'default'); 
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
            connectionType: this.connectionType,
            pendingInvites: Array.from(this.participantManager.pendingInvites),
            joinRequests: this.participantManager.joinRequests,
            decorations: visibleDecos,
            cursorFilter: this.cursorManager.cursorFilter,
            unreadChatCount: this.unreadChatCount,
            isFollowMeMode: this.isFollowMeMode
        });
        this.updateActiveFileSharedContext();
    }

    /**
     * 현재 활성화된 에디터의 파일이 공유 중인지 여부를 VS Code context에 업데이트합니다.
     */
    public updateActiveFileSharedContext() {
        const editor = vscode.window.activeTextEditor;
        const isShared = editor ? this.fileStorageManager.sharedFiles.some(f => f.path === editor.document.uri.fsPath) : false;
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

    // Proxy 호출 연결
    public async shareActiveFile(targetUri?: vscode.Uri) {
        await this.fileStorageManager.shareActiveFile(targetUri);
    }
    public async stopSharing() {
        await this.fileStorageManager.stopSharing();
    }
    public async stopSharingByName(fileName: string) {
        await this.fileStorageManager.stopSharingByName(fileName);
    }
    public inviteGuest(isSilent: boolean = false) {
        this.participantManager.inviteGuest(isSilent);
    }
    public async sendJoinRequest(roomName: string, description: string) {
        await this.participantManager.sendJoinRequest(roomName, description);
    }
    public approveRequest(peerId: string) {
        this.participantManager.approveRequest(peerId);
    }
    public rejectRequest(peerId: string) {
        this.participantManager.rejectRequest(peerId);
    }
    public setPeerPermission(peerId: string, permission: PeerPermission) {
        this.participantManager.setPeerPermission(peerId, permission);
    }
    public setFileAssignee(fileName: string, assigneeId: string) {
        this.participantManager.setFileAssignee(fileName, assigneeId);
    }
    public changeMyName(newName: string) {
        this.participantManager.changeMyName(newName);
    }
    public kickPeer(peerId: string) {
        this.participantManager.kickPeer(peerId);
    }
    public handlePeerDisconnect(peerId: string) {
        this.participantManager.handlePeerDisconnect(peerId);
    }
    public deleteDecoration(id: string) {
        this.decorationManager.deleteDecoration(id);
    }
    public jumpToDecoration(fileName: string, line: number, char: number) {
        this.decorationManager.jumpToDecoration(fileName, line, char);
    }
    public setCursorFilter(filter: 'host' | 'editable' | 'all') {
        this.cursorManager.setCursorFilter(filter);
    }
    public async addDecorationFlow() {
        await this.decorationManager.addDecorationFlow();
    }

    /**
     * 방 나가기(퇴장) 플로우를 처리합니다.
     */
    public async leaveRoomFlow() {
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
                this.reset();
                this.hub.dispose();
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
                vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
            }
        } else {
            // 3. 게스트인 경우 호스트에게 퇴장 알림 전송
            this.sendMessage('GUEST_LEAVE', { userId: this.myId });

            // 4. 로컬 사본 파일들을 완전히 제거 (에디터 닫기 및 디스크 파일 삭제)
            const filesToClean = [...this.fileStorageManager.sharedFiles];
            for (const file of filesToClean) {
                await this.fileStorageManager.handleRemoteStop(file.name);
            }

            // 5. 연결 초기화 및 종료
            this.reset();
            this.hub.dispose();
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isConnected', false);
            vscode.commands.executeCommand('setContext', 'p2pCodeShare.isHost', false);
        }
    }

    /**
     * 게스트가 방을 퇴장할 때 호스트가 수신하여 해당 게스트 리소스(커서, 데코레이션)를 정리합니다.
     */
    private handleGuestLeave(msg: any, peerId: string) {
        if (this.isHost) {
            const actualPeerId = msg.userId || peerId;
            this.logToUI(`GUEST_LEAVE received from: ${actualPeerId}`);

            // 1. 이 게스트가 생성한 데코레이션 완전히 삭제 및 전송
            this.decorationManager.decorations = this.decorationManager.decorations.filter(d => d.creatorId !== actualPeerId);
            this.decorationManager.refreshDecorationsInEditors();
            this.decorationManager.broadcastDecorations();

            // 2. 해당 피어 연결 정리 (커서 정리, 참가자 리스트 제거, 유저 리스트 브로드캐스트)
            this.participantManager.handlePeerDisconnect(actualPeerId);
        }
    }

    /**
     * 실시간 P2P 채팅 메시지를 보냅니다.
     */
    public sendChatMessage(text: string) {
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
    }

    /**
     * 호스트가 화면 동기화를 제어할 수 있도록 스위치를 토글합니다.
     */
    public setFollowMeMode(enabled: boolean) {
        this.isFollowMeMode = enabled;
        this.logToUI(`Follow Me Mode: ${enabled ? 'Enabled' : 'Disabled'}`);
        
        // 켜지는 시점에 현재 에디터 위치 즉시 브로드캐스트
        if (enabled && this.isHost) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const file = this.fileStorageManager.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
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
     * 게스트가 호스트의 화면 위치 정보를 수신하여 에디터를 강제로 열고 스크롤합니다.
     */
    public async handleFollowUpdate(fileName: string, startLine: number, endLine: number) {
        try {
            const file = this.fileStorageManager.sharedFiles.find(f => f.name === fileName);
            if (!file) return;

            // 1. 문서 열기
            const doc = await vscode.workspace.openTextDocument(file.path);
            
            // 2. 현재 보이는 에디터 중에서 해당 문서를 보여주는 에디터 탐색
            let targetEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file.path);
            
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
                // AtTop 혹은 Default 스크롤 동작 적용
                targetEditor.revealRange(range, vscode.TextEditorRevealType.AtTop);
            }
        } catch (e) {
            console.error("Failed to apply follow update:", e);
        }
    }

    /**
     * 엔진의 모든 상태를 초기화합니다.
     */
    public reset(skipUIUpdate = false) {
        this.fileStorageManager.reset();
        this.participantManager.reset();
        this.cursorManager.reset();
        this.decorationManager.reset();
        this.documentSyncManager.reset();
        
        // 채팅 기록 리셋 및 팝업창 닫기
        this.chatHistory = [];
        if (this.chatPanel) {
            this.chatPanel.dispose();
            this.chatPanel = undefined;
        }

        this.isHost = false; 
        this.isConnected = false; 
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
