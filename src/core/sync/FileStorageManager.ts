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

/**
 * FileStorageManager 클래스.
 * 실시간 협업 대상 파일 목록(SharedFile)을 관리하며, 로컬 임시 디렉터리 파일 입출력(I/O),
 * 파일 생성/백업/삭제, 게스트 읽기 전용(Readonly) 모드 전환, 디바운스 파일 저장 등을 총괄합니다.
 */
export class FileStorageManager {
    /** 임시 공유 파일들이 저장되는 로컬 디렉터리 절대 경로 */
    public storagePath: string = '';

    /** 로컬 스토리지 디렉터리가 정상적으로 생성/초기화되었는지 여부 플래그 */
    public isStorageInitialized: boolean = false;

    /** 현재 세션에서 공유 중인 파일 메타데이터 목록 */
    public sharedFiles: SharedFile[] = [];

    /** 현재 닫기 작업이 진행 중인 파일 경로 세트 (저장 타이머 중복 실행 방지용) */
    public closingDocuments = new Set<string>();

    /** 파일별 디스크 디바운스 저장을 제어하는 타이머 맵 */
    private debouncedSaveTimers = new Map<string, NodeJS.Timeout>();

    /**
     * FileStorageManager 인스턴스를 생성합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     */
    constructor(private engine: SyncEngine) {}

    /**
     * 현재 방을 제외한 이전 임시 세션 디렉터리들을 안전하게 삭제하여 디스크 용량을 확보합니다 (게스트 전용).
     * @param currentRoomName 현재 참여 중인 방 이름 (선택 사항).
     * @returns {void}
     */
    public cleanOldRoomStorages(currentRoomName?: string): void {
        if (this.engine.isHost) return;

        try {
            const baseStorage = this.engine.context.globalStorageUri.fsPath;
            if (!fs.existsSync(baseStorage)) return;

            const currentSanitized = currentRoomName ? sanitizePath(currentRoomName) : (this.engine.roomName ? sanitizePath(this.engine.roomName) : '');

            const entries = fs.readdirSync(baseStorage, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // 현재 참여 중인 방의 폴더가 아니면 이전 세션의 잔여 임시 폴더이므로 정리
                    if (currentSanitized && entry.name === currentSanitized) {
                        continue;
                    }
                    const targetDir = path.join(baseStorage, entry.name);
                    try {
                        fs.rmSync(targetDir, { recursive: true, force: true });
                    } catch (e) {
                        // 권한 문제나 파일 락 등으로 삭제 실패 시 다음 기회로 패스
                    }
                }
            }
        } catch (e) {
            // 디렉터리 정리 실패가 전체 연결 프로세스에 영향을 주지 않도록 방어
        }
    }

    /**
     * 게스트가 방을 퇴장하거나 강퇴당했을 때 현재 방의 임시 스토리지 전체를 깨끗하게 삭제합니다.
     * @returns {Promise<void>}
     */
    public async clearLocalStorage(): Promise<void> {
        if (this.engine.isHost) return;

        // 1. 열려있는 모든 공유 파일 에디터 탭 닫기 및 파일별 정리
        const filesToClean = [...this.sharedFiles];
        for (const file of filesToClean) {
            await this.handleRemoteStop(file.name);
        }

        // 2. 현재 방 및 사용자 스토리지 디렉터리 통째로 삭제
        try {
            if (this.storagePath && fs.existsSync(this.storagePath)) {
                fs.rmSync(this.storagePath, { recursive: true, force: true });
            }

            // 상위의 방 폴더(방 이름 폴더)도 비어있거나 남아있으면 삭제 시도
            if (this.engine.roomName) {
                const roomDir = path.join(this.engine.context.globalStorageUri.fsPath, sanitizePath(this.engine.roomName));
                if (fs.existsSync(roomDir)) {
                    fs.rmSync(roomDir, { recursive: true, force: true });
                }
            }
        } catch (e) {
            // 파일 락 등의 이유로 즉시 삭제 실패 시에도 익스텐션 정지에 영향 없도록 무시
        }
    }

    /**
     * 공유 파일 저장을 위한 전용 임시 디렉터리를 초기화하고 준비합니다.
     * @returns {void}
     */
    public initializeStorage(): void {
        if (this.isStorageInitialized) return;
        if (!this.engine.isHost && (!this.engine.myId || this.engine.myId === 'default' || !this.engine.roomName || this.engine.roomName === 'Untitled Room')) return;

        // 게스트의 경우 새로운 방에 입장할 때 다른 방의 기존 임시 폴더들을 정리
        if (!this.engine.isHost && this.engine.roomName) {
            this.cleanOldRoomStorages(this.engine.roomName);
        }

        // 로컬 충돌 방지를 위해 myId 및 roomName 기반 독립 폴더 생성
        const folderName = this.engine.isHost ? 'host' : (this.engine.myId || 'guest');
        this.storagePath = path.join(this.engine.context.globalStorageUri.fsPath, sanitizePath(this.engine.roomName), sanitizePath(folderName));
        ensureDirectory(this.storagePath);
        this.isStorageInitialized = true;
    }

    /**
     * 호스트 측에서 현재 활성화된 에디터의 파일 또는 컨텍스트 메뉴에서 선택한 파일을 공유 시작합니다.
     * @param targetUri 컨텍스트 메뉴 등을 통해 전달된 대상 파일 URI (선택 사항).
     * @returns {Promise<void>}
     */
    public async shareActiveFile(targetUri?: vscode.Uri): Promise<void> {
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
     * 게스트가 호스트로부터 초기 파일 스냅샷(INIT_SNAPSHOT)을 수신하여 로컬 임시 파일로 저장하고 Yjs 문서를 동기화합니다.
     * @param msg 스냅샷 데이터(파일명, 텍스트 내용, Yjs 상태, 권한 등)를 담은 메시지 객체.
     * @returns {Promise<void>}
     */
    public async handleGuestInitSnapshot(msg: any): Promise<void> {
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

        // 편집 권한에 따른 읽기 전용 상태 설정
        await this.updateReadonlyState(file);

        // VS Code 에디터에 파일 열기
        try {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) {
            this.engine.logToUI(`Error opening document ${msg.fileName}: ${e}`);
        }

        this.engine.pushUIUpdate();
    }

    /**
     * 특정 공유 파일에 대해 현재 사용자의 편집 권한에 따라 읽기 전용 상태를 적용합니다.
     * @param file 대상 공유 파일 객체.
     * @returns {Promise<void>}
     */
    public async updateReadonlyState(file: SharedFile): Promise<void> {
        if (this.engine.isHost) return;
        try {
            const canEdit = this.engine.participantManager.canIEdit(file.name);
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && isPathEqual(activeEditor.document.uri.fsPath, file.path)) {
                await this.applyEditorReadonlyState(activeEditor, !canEdit);
            }
        } catch (e) {}
    }

    /**
     * 공유 중인 모든 파일의 읽기 전용 상태를 일괄 갱신합니다.
     * @returns {Promise<void>}
     */
    public async updateAllReadonlyStates(): Promise<void> {
        if (this.engine.isHost) return;
        for (const file of this.sharedFiles) {
            await this.updateReadonlyState(file);
        }
    }

    /**
     * VS Code 에디터에 내장된 세션 단위 읽기 전용 모드를 토글합니다.
     * @param editor 대상 텍스트 에디터.
     * @param readonly 읽기 전용 여부.
     * @returns {Promise<void>}
     */
    public async applyEditorReadonlyState(editor: vscode.TextEditor, readonly: boolean): Promise<void> {
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
     * 실시간 타이핑 중 빈번한 디스크 I/O 렉을 방지하기 위해 디바운스(1.5초) 방식으로 문서를 저장합니다.
     * @param filePath 저장 대상 로컬 파일 절대 경로.
     * @returns {void}
     */
    public scheduleDebouncedSave(filePath: string): void {
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
     * 현재 활성화된 에디터 파일의 공유를 중지합니다.
     * @returns {Promise<void>}
     */
    public async stopSharing(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const file = this.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
        if (file) await this.stopSharingByName(file.name);
    }

    /**
     * 특정 파일명의 공유를 중지하고 변경 사항을 백업본과 Diff 비교합니다 (호스트 전용).
     * @param fileName 공유를 중지할 파일 이름.
     * @returns {Promise<void>}
     */
    public async stopSharingByName(fileName: string): Promise<void> {
        if (!this.engine.isHost) return;

        const answer = await vscode.window.showWarningMessage(`"${fileName}" 공유를 중지하시겠습니까?`, { modal: true }, "중지");
        if (answer !== "중지") return;

        const file = this.sharedFiles.find(f => f.name === fileName);
        if (file) {
            // 변경 사항 최종 저장
            const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, file.path));
            if (doc) {
                await doc.save();
                if (file.source && fs.existsSync(file.source)) {
                    // 원본 백업본과 현재 협업본 간의 변경점 Diff 뷰 실행
                    vscode.commands.executeCommand(
                        'vscode.diff',
                        vscode.Uri.file(file.source),
                        vscode.Uri.file(file.path),
                        `파일 비교: ${file.name} (원본 vs 협업본)`
                    );
                }
            }

            // 게스트들에게 공유 중지 통지
            this.engine.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
        }
    }

    /**
     * 공유 중지(호스트 명령 또는 피어 알림) 발생 시 메모리 자원, 타이머, 탭 및 임시 파일을 정리합니다.
     * @param fileName 정리할 파일 이름.
     * @returns {Promise<void>}
     */
    public async handleRemoteStop(fileName: string): Promise<void> {
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

    /**
     * FileStorageManager의 모든 타이머, 파일 목록 및 상태를 초기화합니다.
     * @returns {void}
     */
    public reset(): void {
        this.debouncedSaveTimers.forEach(t => clearTimeout(t));
        this.debouncedSaveTimers.clear();
        this.sharedFiles = [];
        this.closingDocuments.clear();
        this.isStorageInitialized = false;
        this.storagePath = '';
    }
}
