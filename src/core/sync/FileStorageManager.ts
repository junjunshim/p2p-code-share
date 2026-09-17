/**
 * @file FileStorageManager.ts
 * @description 공유 파일 목록, 로컬 스토리지 I/O, 읽기 전용 상태 및 공유 시작/중지 관리를 담당합니다.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SharedFile } from '../../types';
import { sanitizePath, ensureDirectory, isPathEqual, normalizeEOL } from '../../utils/helpers';
import { SyncEngine } from '../SyncEngine';

export class FileStorageManager {
    public storagePath: string = '';
    public isStorageInitialized: boolean = false;
    public sharedFiles: SharedFile[] = [];
    public closingDocuments = new Set<string>();
    private debouncedSaveTimers = new Map<string, NodeJS.Timeout>();

    constructor(private engine: SyncEngine) {}

    /**
     * 현재 방을 제외한 이전 임시 방 스토리지 디렉터리들을 안전하게 삭제합니다 (게스트 전용).
     */
    public cleanOldRoomStorages(currentRoomName?: string) {
        if (this.engine.isHost) return;

        try {
            const baseStorage = this.engine.context.globalStorageUri.fsPath;
            if (!fs.existsSync(baseStorage)) return;

            const currentSanitized = currentRoomName ? sanitizePath(currentRoomName) : (this.engine.roomName ? sanitizePath(this.engine.roomName) : '');

            const entries = fs.readdirSync(baseStorage, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // 현재 참여하는 방의 폴더가 아니면 이전 방의 임시 폴더이므로 정리
                    if (currentSanitized && entry.name === currentSanitized) {
                        continue;
                    }
                    const targetDir = path.join(baseStorage, entry.name);
                    try {
                        fs.rmSync(targetDir, { recursive: true, force: true });
                    } catch (e) {
                        // 권한이나 사용 중 등으로 삭제 실패 시 다음 기회로 패스
                    }
                }
            }
        } catch (e) {
            // 정리 중 오류가 발생해도 P2P 연결 흐름에 지장을 주지 않도록 방어
        }
    }

    /**
     * 공유 파일 저장을 위한 저장소를 초기화합니다.
     */
    public initializeStorage() {
        if (this.isStorageInitialized) return;
        if (!this.engine.isHost && (!this.engine.myId || this.engine.myId === 'default' || !this.engine.roomName || this.engine.roomName === 'Untitled Room')) return;

        // 게스트의 경우 새로운 방에 입장할 때 다른 방의 기존 임시 폴더들을 정리
        if (!this.engine.isHost && this.engine.roomName) {
            this.cleanOldRoomStorages(this.engine.roomName);
        }

        // 기기 내 충돌 방지를 위해 myId/roomName 기반 폴더 생성
        const folderName = this.engine.isHost ? 'host' : (this.engine.myId || 'guest');
        this.storagePath = path.join(this.engine.context.globalStorageUri.fsPath, sanitizePath(this.engine.roomName), sanitizePath(folderName));
        ensureDirectory(this.storagePath);
        this.isStorageInitialized = true;
    }

    /**
     * 호스트가 활성화된 파일을 공유합니다.
     */
    public async shareActiveFile(targetUri?: vscode.Uri) {
        if (!this.engine.isHost) return;
        this.initializeStorage();

        let sourcePath: string;
        let document: vscode.TextDocument;

        if (targetUri) {
            sourcePath = targetUri.fsPath;
            document = await vscode.workspace.openTextDocument(targetUri);
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage("공유할 파일을 에디터에서 열어주세요.");
                return;
            }
            sourcePath = editor.document.uri.fsPath;
            document = editor.document;

            // 호스트 에디터의 EOL을 LF로 정규화하여 Yjs와의 오프셋 체계 불일치 방지
            if (document.eol !== vscode.EndOfLine.LF) {
                await editor.edit(builder => {
                    builder.setEndOfLine(vscode.EndOfLine.LF);
                });
            }
        }

        const fileName = path.basename(sourcePath);

        // 이미 공유 중인지 확인
        if (this.sharedFiles.some(f => isPathEqual(f.path, sourcePath) || f.name === fileName)) {
            vscode.window.showInformationMessage(`"${fileName}" 파일은 이미 공유 중입니다.`);
            return;
        }

        // 1. 호스트 원본 백업본 생성 (공유 중지 시 diff 비교용)
        const backupPath = path.join(this.storagePath, `${fileName}.original`);
        fs.writeFileSync(backupPath, document.getText(), 'utf8');

        // 2. 호스트 공유 파일 목록에 등록
        const sharedFile: SharedFile = {
            name: fileName,
            path: sourcePath,
            source: backupPath,
            assigneeId: undefined,
            assigneeName: undefined
        };
        this.sharedFiles.push(sharedFile);

        // 3. Yjs Doc 생성 및 초기 상태 인코딩 (개행 LF로 정규화)
        const normalizedContent = normalizeEOL(document.getText());
        const yjsState = this.engine.documentSyncManager.createDocForHost(fileName, normalizedContent);

        // 4. 게스트들에게 초기 파일 스냅샷 브로드캐스트
        this.engine.sendMessage('INIT_SNAPSHOT', {
            fileName,
            content: normalizedContent,
            yjsState,
            assigneeId: undefined,
            assigneeName: undefined
        });

        this.engine.logToUI(`Started sharing: ${fileName}`);
        this.engine.pushUIUpdate();
    }

    /**
     * 게스트가 호스트로부터 초기 파일 스냅샷을 수신하여 로컬에 열고 Yjs를 동기화합니다.
     */
    public async handleGuestInitSnapshot(msg: any) {
        this.initializeStorage();
        if (!this.storagePath) return;

        const filePath = path.join(this.storagePath, msg.fileName);
        const normalizedContent = normalizeEOL(msg.content || '');
        
        // 로컬 임시 파일 작성 (LF 개행 유지)
        fs.writeFileSync(filePath, normalizedContent, 'utf8');

        // 공유 파일 목록에 추가 또는 업데이트
        let file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) {
            file = {
                name: msg.fileName,
                path: filePath,
                assigneeId: msg.assigneeId,
                assigneeName: msg.assigneeName
            };
            this.sharedFiles.push(file);
        } else {
            file.path = filePath;
            file.assigneeId = msg.assigneeId;
            file.assigneeName = msg.assigneeName;
        }

        // Yjs 문서 생성 및 상태 초기화
        this.engine.documentSyncManager.createDocForGuest(msg.fileName, msg.yjsState, msg.content);

        // 권한 설정 적용
        await this.updateReadonlyState(file);

        // VS Code에서 파일 열기
        try {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
            this.engine.logToUI(`Error opening document ${msg.fileName}: ${e}`);
        }

        this.engine.pushUIUpdate();
    }

    /**
     * 특정 파일의 읽기 전용 상태를 업데이트합니다.
     */
    public async updateReadonlyState(file: SharedFile) {
        if (this.engine.isHost) return;
        try {
            const canEdit = this.engine.participantManager.canIEdit(file.name);
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && isPathEqual(activeEditor.document.uri.fsPath, file.path)) {
                await this.applyEditorReadonlyState(activeEditor, !canEdit);
            }
        } catch (e) {}
    }

    public async updateAllReadonlyStates() {
        if (this.engine.isHost) return;
        for (const file of this.sharedFiles) {
            await this.updateReadonlyState(file);
        }
    }

    public async applyEditorReadonlyState(editor: vscode.TextEditor, readonly: boolean) {
        if (this.engine.isHost) return;
        if (vscode.window.activeTextEditor !== editor) return;

        try {
            if (readonly) {
                await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession');
            } else {
                await vscode.commands.executeCommand('workbench.action.files.resetActiveEditorReadonlyInSession');
            }
        } catch (e) {}
    }

    /**
     * 백그라운드에서 디바운스 방식으로 디스크에 저장합니다 (실시간 타이핑 중 I/O 렉 방지).
     */
    public scheduleDebouncedSave(filePath: string) {
        // 이미 공유 목록에 없는 파일이거나 닫히는 중인 파일은 저장 예약하지 않음
        if (!this.sharedFiles.some(f => isPathEqual(f.path, filePath)) || this.closingDocuments.has(filePath)) {
            return;
        }

        const existing = this.debouncedSaveTimers.get(filePath);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            this.debouncedSaveTimers.delete(filePath);
            // 타이머 실행 시점에도 공유 파일 목록에 존재하는지 재검증
            if (!this.sharedFiles.some(f => isPathEqual(f.path, filePath)) || this.closingDocuments.has(filePath)) {
                return;
            }
            const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, filePath) && !d.isClosed);
            if (doc && doc.isDirty) {
                try {
                    await doc.save();
                } catch (e) {}
            }
        }, 1500);

        this.debouncedSaveTimers.set(filePath, timer);
    }

    /**
     * 활성화된 에디터의 파일 공유를 중지합니다.
     */
    public async stopSharing() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const file = this.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
        if (file) await this.stopSharingByName(file.name);
    }

    /**
     * 이름으로 파일 공유를 중지합니다 (호스트 전용).
     */
    public async stopSharingByName(fileName: string) {
        if (!this.engine.isHost) return;

        const answer = await vscode.window.showWarningMessage(`"${fileName}" 공유를 중지하시겠습니까?`, { modal: true }, "중지");
        if (answer !== "중지") return;

        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file) {
            // 변경 사항 저장
            const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, file.path));
            if (doc) {
                await doc.save();
                if (file.source && fs.existsSync(file.source)) {
                    // 원본 백업본과 현재 협업본을 Diff 비교
                    vscode.commands.executeCommand(
                        'vscode.diff',
                        vscode.Uri.file(file.source),
                        vscode.Uri.file(file.path),
                        `파일 비교: ${file.name} (원본 vs 협업본)`
                    );
                }
            }

            // 게스트들에게 공유 중지 전송
            this.engine.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
        }
    }

    /**
     * 원격 공유 중지 요청을 처리합니다 (게스트 및 호스트 공통 목록 정리).
     */
    public async handleRemoteStop(fileName: string) {
        const index = this.sharedFiles.findIndex(f => f.name === fileName);
        const file = index !== -1 ? this.sharedFiles[index] : undefined;
        const filePath = file?.path || (this.storagePath ? path.join(this.storagePath, fileName) : '');

        // 1. 예약된 디바운스 디스크 저장 타이머 및 타이핑 락 즉시 취소
        if (filePath) {
            const timer = this.debouncedSaveTimers.get(filePath);
            if (timer) {
                clearTimeout(timer);
                this.debouncedSaveTimers.delete(filePath);
            }
        }

        // 에디터의 readonly 상태(타이핑 락 등) 무조건 해제 (호스트 원본 파일이 readonly로 남는 문제 방지)
        this.engine.remoteTypingLocked.delete(fileName);
        const lockTimer = this.engine.localTypingUnlockTimers.get(fileName);
        if (lockTimer) {
            clearTimeout(lockTimer);
            this.engine.localTypingUnlockTimers.delete(fileName);
        }
        await this.engine.setEditorReadonly(fileName, false, filePath);

        // 2. 메모리 영역(Yjs Doc, 커서, 데코레이션) 즉시 파기 및 정리 (동기식)
        this.engine.documentSyncManager.destroyYjsDoc(fileName);
        this.engine.decorationManager.removeDecorationsForFile(fileName);
        this.engine.cursorManager.clearCursorsForFile(fileName);

        // 3. 공유 파일 목록에서 즉시 제거하여 이후 모든 이벤트 리스너에서 제외
        if (index !== -1) {
            this.sharedFiles.splice(index, 1);
        }

        // 4. 게스트의 경우 열린 에디터 탭 닫기 및 임시 파일 삭제
        if (!this.engine.isHost && filePath) {
            this.closingDocuments.add(filePath);

            // 4-1. 열려있는 문서의 dirty 상태 해제 (저장하여 isDirty=false로 만들어 닫을 때 'Save / Don't Save' 팝업 방지)
            const matchingDocs = vscode.workspace.textDocuments.filter(d => isPathEqual(d.uri.fsPath, filePath) && !d.isClosed);
            for (const doc of matchingDocs) {
                if (doc.isDirty) {
                    try {
                        await doc.save();
                    } catch (e) {}
                }
            }

            // 4-2. 에디터 탭 닫기 (isDirty=false 상태이므로 팝업 없이 즉시 닫힘)
            const tabsToClose = vscode.window.tabGroups.all
                .flatMap(g => g.tabs)
                .filter(t => {
                    const uri = (t.input as any)?.uri;
                    return uri && isPathEqual(uri.fsPath, filePath);
                });

            for (const tab of tabsToClose) {
                try { await vscode.window.tabGroups.close(tab); } catch (e) {}
            }

            // 4-3. 에디터가 닫힌 후 디스크 임시 파일 완전히 삭제
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (e) {
                    try {
                        fs.rmSync(filePath, { force: true });
                    } catch (e2) {}
                }
            }

            if (file?.source && fs.existsSync(file.source)) {
                try { fs.unlinkSync(file.source); } catch (e) {}
            }

            setTimeout(() => {
                this.closingDocuments.delete(filePath);
            }, 1000);
        }

        this.engine.pushUIUpdate();
    }

    public reset() {
        this.debouncedSaveTimers.forEach(t => clearTimeout(t));
        this.debouncedSaveTimers.clear();
        this.sharedFiles = [];
        this.closingDocuments.clear();
        this.isStorageInitialized = false;
        this.storagePath = '';
    }
}
