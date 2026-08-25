/**
 * @file ParticipantManager.ts
 * @description 참여자 목록 관리, 승인/거절, 권한 부여, 이름 변경, 강퇴 등의 로직을 처리합니다.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { PeerPermission } from '../../types';
import { SyncEngine } from '../SyncEngine';

export class ParticipantManager {
    public participants: { [key: string]: PeerPermission } = {};
    public joinRequests: any[] = [];
    public pendingInvites = new Set<string>();
    public isAutoJoin = false;
    public pendingJoinRequest: { roomName: string, description: string } | null = null;
    private joinTimeout?: NodeJS.Timeout;

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
     * @param description 참여 목적 설명.
     */
    public async sendJoinRequest(roomName: string, description: string) {
        this.engine.roomName = roomName;
        this.engine.isSetupMode = false;
        this.isAutoJoin = true; // [추가] 자동 참여 모드 설정
        this.pendingJoinRequest = { roomName, description }; // 요청 큐에 저장
        this.engine.pushUIUpdate();

        // 15초 내에 연결 단계가 완료되지 않으면 에러 및 리셋 처리
        if (this.joinTimeout) {
            clearTimeout(this.joinTimeout);
        }
        this.joinTimeout = setTimeout(() => {
            if (!this.engine.isConnected && this.isAutoJoin) {
                vscode.window.showErrorMessage("호스트와의 연결 시도 시간이 초과되었습니다. 방 이름이 올바른지 혹은 호스트가 온라인인지 확인해주세요.");
                this.engine.reset();
                this.engine.hub.dispose();
            }
        }, 15000);

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
            this.handleGuestJoin({ name: request.name }, peerId);
        }
        
        // 요청 목록에서 제거
        this.joinRequests = this.joinRequests.filter(req => req.peerId !== peerId);
        
        // 승인 메시지 전송 및 피어 ID 할당
        this.engine.sendMessageToPeer(peerId, 'JOIN_RESPONSE', { approved: true });
        this.engine.sendMessageToPeer(peerId, 'ASSIGN_PEER_ID', { peerId });
        
        this.engine.pushUIUpdate();
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
        
        this.engine.pushUIUpdate();
    }

    /**
     * 호스트가 게스트의 참여를 처리합니다.
     */
    public handleGuestJoin(msg: any, peerId: string) {
        if (this.engine.isHost) { 
            this.participants[peerId] = { name: msg.name, globalCanEdit: false, filePermissions: {} }; 
            this.broadcastUserList(); 
            
            // [추가] 새로 들어온 게스트에게 현재 공유 중인 모든 파일 스냅샷 전송
            this.engine.fileStorageManager.sharedFiles.forEach(f => {
                const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === f.path);
                const content = doc ? doc.getText() : fs.readFileSync(f.path, 'utf8');
                // 해당 피어에게만 초기 스냅샷 전송 (파일 목록 생성 및 에디터 열기 유도)
                this.engine.sendMessageToPeer(peerId, 'INIT_SNAPSHOT', { 
                    fileName: f.name, 
                    content,
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

        // 로컬에서 즉시 연결 해제 처리
        this.handlePeerDisconnect(peerId);
    }

    /**
     * 피어 연결 해제 이벤트를 처리합니다.
     * @param peerId 연결이 해제된 피어 ID.
     */
    public handlePeerDisconnect(peerId: string) {
        if (!this.engine.isHost) {
            // 게스트일 경우 호스트 연결 손실 알림 (승인되어 연결된 상태였을 때만 알림 표시)
            if (peerId === 'default' || peerId === 'all') { 
                if (this.engine.isConnected) {
                    vscode.window.showErrorMessage("호스트와의 연결이 끊겼습니다."); 
                }
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
            this.joinRequests.push({
                peerId,
                name: msg.name || peerId,
                description: msg.description || '',
                timestamp: Date.now()
            });
            vscode.window.showInformationMessage(`방 참여 요청: ${msg.name || peerId}`);
            this.engine.pushUIUpdate();
        }
    }

    /**
     * [추가] 방 참여 응답 처리 (게스트 전용)
     */
    public handleJoinResponse(msg: any) {
        if (!this.engine.isHost) {
            if (msg.approved) {
                vscode.window.showInformationMessage("방 참여가 승인되었습니다!");
                this.engine.isConnected = true;
                this.isAutoJoin = false;
                this.engine.updateStatus('Connected');
            } else {
                vscode.window.showErrorMessage(`방 참여가 거절되었습니다: ${msg.reason || '사유 없음'}`);
                this.engine.reset();
            }
        }
    }

    /**
     * [추가] 강제 퇴장 처리 (게스트 전용)
     */
    public handleKicked(msg: any) {
        if (!this.engine.isHost) {
            vscode.window.showErrorMessage(`퇴장되었습니다: ${msg.reason}`);
            this.engine.reset();
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

    public reset() {
        this.clearJoinTimeout();
        this.participants = {};
        this.joinRequests = [];
        this.pendingInvites.clear();
        this.isAutoJoin = false;
        this.pendingJoinRequest = null;
    }
}
