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
// P2P 네트워킹을 위한 허브 매니저
import { HubManager } from './HubManager';
// 프로젝트 고유 타입
import { SharedFile, P2PMessage } from '../types';
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
    private participants: { [key: string]: string } = {};
    private lastRemoteContentMap = new Map<string, string>();
    private pollingTimer?: NodeJS.Timeout;
    public roomName = ''; 
    private isStorageInitialized = false;
    public isSetupMode = false; 
    public isConnected = false; 
    private pendingInvites = new Set<string>();

    private remoteCursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteSelectionDecorations = new Map<string, vscode.TextEditorDecorationType>();
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
            console.log(`[P2P DEBUG] 피어로부터 데이터 수신: ${peerId}`);
            try {
                // 수신된 P2P 메시지 파싱
                const msg = JSON.parse(text) as P2PMessage;
                switch (msg.type) {
                    case 'SET_ROLE': this.handleSetRole(msg); break;
                    case 'ON_CONNECTED': 
                        // 피어 연결 초기화 처리
                        console.log(`[P2P DEBUG] 피어에 대해 ON_CONNECTED 수신: ${peerId}`);
                        if (this.isHost) {
                            if (this.pendingInvites.has(peerId)) {
                                this.isSetupMode = false;
                                this.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
                                this.pendingInvites.delete(peerId);
                            }
                        } else {
                            this.isConnected = true;
                            this.isSetupMode = false;
                        }
                        this.pushUIUpdate();
                        break;
                    case 'ASSIGN_PEER_ID':
                        // 게스트 노드에 대한 피어 ID 할당
                        if (!this.isHost) {
                            console.log(`[P2P DEBUG] ASSIGN_PEER_ID 수신: ${msg.peerId}`);
                            const oldId = this.myId || 'default';
                            this.myId = msg.peerId;
                            this.myName = msg.peerId; 
                            this.initialName = this.myId; 
                            this.isStorageInitialized = false; 
                            this.initializeStorage(); 
                            
                            // UI에 피어 ID 변경 알림
                            this.sendMessage('updatePeerId', { oldId, newId: this.myId });
                            
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
                        console.log(`[P2P DEBUG] 피어로부터 GUEST_JOIN: ${peerId}, 이름: ${msg.name}`);
                        this.handleGuestJoin(msg, peerId); break;
                    case 'GUEST_RENAME':
                        // 참가자 이름 변경
                        if (this.isHost) { this.participants[peerId] = msg.newName; this.broadcastUserList(); }
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'GUEST_EDIT': if (this.isHost) { await this.handleGuestEdit(msg); } break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastAll(); break;
                    case 'STOP_SHARING': await this.handleRemoteStop(msg.fileName); break;
                    case 'CURSOR_UPDATE': 
                        // 커서 및 선택 영역 업데이트 처리
                        const senderId = msg.userId || peerId; 
                        this.updateRemoteCursor(msg, senderId); 
                        if (this.isHost) this.broadcastCursor(msg, senderId);
                        break;
                }
            } catch (e) {}
        };
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
        
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) return;
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === file.path);
        if (!editor) return;
        
        // 기존 커서/선택 영역 데코레이션 제거
        const prevCursor = this.remoteCursorDecorations.get(actualPeerId);
        if (prevCursor) prevCursor.dispose();
        const prevSelection = this.remoteSelectionDecorations.get(actualPeerId);
        if (prevSelection) prevSelection.dispose();
        
        const color = this.getUserColor(actualPeerId); 
        // 새 커서 데코레이션 생성
        const cursorDeco = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: color,
            after: {
                contentText: msg.userName, backgroundColor: color, color: 'white', margin: '1.4em 0 0 0', fontWeight: 'bold',
                textDecoration: `none; font-size: 12px; padding: 2px 6px; border-radius: 4px; position: absolute; z-index: 100; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3);`
            }
        });
        // 새 선택 영역 데코레이션 생성
        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        this.remoteCursorDecorations.set(actualPeerId, cursorDeco);
        this.remoteSelectionDecorations.set(actualPeerId, selectionDeco);
        
        const cursorRange = [new vscode.Range(new vscode.Position(msg.cursorPos[0], msg.cursorPos[1]), new vscode.Position(msg.cursorPos[0], msg.cursorPos[1]))];
        const selectionRange = [new vscode.Range(new vscode.Position(msg.selectionRange[0], msg.selectionRange[1]), new vscode.Position(msg.selectionRange[2], msg.selectionRange[3]))];
        // 에디터에 데코레이션 적용
        editor.setDecorations(cursorDeco, cursorRange);
        editor.setDecorations(selectionDeco, selectionRange);
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

        if (this.isHost) { 
            // 호스트일 경우 저장소 초기화 및 참가자 등록 (연결 상태는 HubManager 콜백에서 설정)
            this.isSetupMode = false;
            this.initializeStorage(); 
            this.participants['host'] = this.myName; 
            this.hub.createHub(true, this.roomName, 'none'); 
            
            // [고도화] 이름이 있는 방일 경우, 자동으로 첫 번째 게스트를 위한 연결 준비(초대) 시작
            if (this.roomName && this.roomName !== 'Untitled Room') {
                this.inviteGuest(true);
            }
        } else { 
            // 게스트일 경우 방 이름이 있으면 자동 연결이므로 설정 모드(SDP 화면)로 바로 가지 않음
            // 방 이름이 없으면 수동 연결이므로 즉시 설정 모드로 진입
            this.isSetupMode = (this.roomName && this.roomName !== 'Untitled Room') ? false : true; 
            this.startPolling(); 
            this.hub.createHub(false, this.roomName, 'default'); 
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
        // 스냅샷 경로 생성 및 파일 쓰기
        const snapshotPath = path.join(this.storagePath, msg.fileName + '.shared');
        fs.writeFileSync(snapshotPath, msg.content);
        // 문서 열기 및 표시
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.addSharedFile(msg.fileName, snapshotPath);
    }

    /**
     * 사용자 명단 업데이트를 처리합니다.
     * @param msg 사용자 명단 업데이트 메시지 (사용자 목록, 방 이름 포함).
     */
    private handleUserListUpdate(msg: any) {
        // 참가자 목록 업데이트
        this.participants = msg.users;
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
            if (this.participants[this.myId]) {
                this.myName = this.participants[this.myId];
            } else if (this.participants['default']) {
                this.myName = this.participants['default'];
            }
        }
        
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
            this.participants[peerId] = msg.name; 
            this.broadcastUserList(); 
            
            // [추가] 새로 들어온 게스트에게 현재 공유 중인 모든 파일 스냅샷 전송
            this.sharedFiles.forEach(f => {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f.path);
                const content = doc ? doc.getText() : fs.readFileSync(f.path, 'utf8');
                // 해당 피어에게만 초기 스냅샷 전송 (파일 목록 생성 및 에디터 열기 유도)
                this.sendMessageToPeer(peerId, 'INIT_SNAPSHOT', { fileName: f.name, content });
            });
        }
    }

    /**
     * 텍스트 문서 변경 이벤트 리스너를 설정합니다.
     */
    private setupTextListeners() {
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange) return;
            const file = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!file) return;

            // [핵심] 실제 사용자의 타이핑인지 확인: 변경사항의 reason이 정의되지 않았거나(수동 입력) 
            // 프로그램에 의한 변경이 아님을 확인
            const isManualChange = e.contentChanges.length > 0;
            if (!isManualChange) return;

            const text = e.document.getText();
            if (text === this.lastRemoteContentMap.get(file.name)) return;

            this.lastRemoteContentMap.set(file.name, text);
            // 호스트 여부에 따라 동기화 메시지 전송
            this.sendMessage(this.isHost ? 'SYNC_FULL' : 'GUEST_EDIT', { fileName: file.name, content: text });
        });
        vscode.workspace.onWillSaveTextDocument(e => {
            // 호스트가 아니며 공유 파일 저장 시 상태 메시지 표시
            if (!this.isHost && this.sharedFiles.some(f => f.path === e.document.uri.fsPath)) {
                vscode.window.setStatusBarMessage("P2P: Changes synced to Host.", 3000);
            }
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
        if (!doc) { fs.writeFileSync(filePath, content); return; }
        if (doc.getText() === content) return;

        // 원격 변경 사항 적용 플래그 설정
        this.lastRemoteContentMap.set(fileName, content);
        this.isApplyingRemoteChange = true;
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
            await vscode.workspace.applyEdit(edit);
        } finally {
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
        this.sendMessage('INIT_SNAPSHOT', { fileName, content: document.getText() });
        this.addSharedFile(fileName, snapshotPath, sourcePath);
    }

    /**
     * 사용자 이름을 변경합니다.
     * @param newName 새로운 사용자 이름.
     */
    public changeMyName(newName: string) {
        if (this.isHost) { 
            // 호스트 이름 변경 및 명단 브로드캐스트
            this.myName = newName; 
            this.participants['host'] = newName; 
            this.broadcastUserList(); 
        } else { 
            // 게스트 이름 변경 및 서버에 알림
            this.myName = newName;
            this.sendMessage('GUEST_RENAME', { newName }); 
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
     * 엔진을 통해 메시지를 전송합니다.
     * @param type 메시지 유형.
     * @param data 메시지 데이터.
     */
    private sendMessage(type: string, data: any) { 
        // PeerData 형식으로 메시지 전송
        this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }); 
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
     */
    private addSharedFile(name: string, filePath: string, source?: string) {
        // 이미 목록에 없으면 파일 추가
        if (!this.sharedFiles.find(f => f.path === filePath)) {
            this.sharedFiles.push({ name, path: filePath, source });
        }
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
            if (!this.isHost) await doc.save();
            const targetTab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => (t.input as any).uri?.fsPath === file.path);
            if (targetTab) await vscode.window.tabGroups.close(targetTab);
        }
        
        // 파일 삭제 시도
        if (fs.existsSync(file.path)) try { fs.unlinkSync(file.path); } catch(e) {}
        
        // 목록에서 제거 및 동기화 맵 갱신
        this.sharedFiles.splice(index, 1);
        this.lastRemoteContentMap.delete(fileName);
        this.pushUIUpdate();
    }

    /**
     * 모든 공유 및 리소스를 정리하고 중지합니다.
     */
    public stopAll() {
        // 폴링 타이머 중지
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        // 공유 중인 모든 파일 공유 중지
        this.sharedFiles.forEach(f => this.handleRemoteStop(f.name));
        // 커서 및 선택 영역 데코레이션 해제
        this.remoteCursorDecorations.forEach(d => d.dispose());
        this.remoteCursorDecorations.clear();
        this.remoteSelectionDecorations.forEach(d => d.dispose());
        this.remoteSelectionDecorations.clear();
        // 사용자 색상 맵 초기화
        this.userColorMap.clear();
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
        
        // 5초 간격으로 전체 동기화 요청 전송
        this.pollingTimer = setInterval(() => { 
            if (!this.isHost && this.sharedFiles.length > 0) this.sendMessage('REQUEST_FULL_SYNC', {}); 
        }, 5000);
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
            // [핵심] 현재 초대 중인 아이디 목록을 UI로 전달
            pendingInvites: Array.from(this.pendingInvites)
        });
    }
}
