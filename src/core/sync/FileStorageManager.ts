/**
 * @file FileStorageManager.ts
 * @description 공유 파일 목록, 로컬 스토리지 I/O, 읽기 전용 상태 및 공유 시작/중지 관리를 담당합니다.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SharedFile } from '../../types';
import { sanitizePath, ensureDirectory, isPathEqual } from '../../utils/helpers';
import { SyncEngine } from '../SyncEngine';

export class FileStorageManager {
    public storagePath: string = '';
    public isStorageInitialized: boolean = false;
    public sharedFiles: SharedFile[] = [];
    public closingDocuments = new Set<string>();
    private debouncedSaveTimers = new Map<string, NodeJS.Timeout>();

    constructor(private engine: SyncEngine) {}

    /**
     * 공유 파일 저장을 위한 저장소를 초기화합니다.
     */
    public initializeStorage() {
        if (this.isStorageInitialized) return;
        if (!this.engine.isHost && (!this.engine.myId || this.engine.myId === 'default' || !this.engine.roomName || this.engine.roomName === 'Untitled Room')) return;

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

        // 3. Yjs Doc 생성 및 초기 상태 인코딩
        const yjsState = this.engine.documentSyncManager.createDocForHost(fileName, document.getText());

        // 4. 게스트들에게 초기 파일 스냅샷 브로드캐스트
        this.engine.sendMessage('INIT_SNAPSHOT', {
            fileName,
            content: document.getText(),
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
        
        // 로컬 임시 파일 작성
        fs.writeFileSync(filePath, msg.content, 'utf8');

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
        const existing = this.debouncedSaveTimers.get(filePath);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            this.debouncedSaveTimers.delete(filePath);
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
        if (index === -1) return;

        const file = this.sharedFiles[index];

        // 게스트의 경우 탭을 닫고 임시 파일 정리
        if (!this.engine.isHost) {
            this.closingDocuments.add(file.path);
            const tabsToClose = vscode.window.tabGroups.all
                .flatMap(g => g.tabs)
                .filter(t => isPathEqual((t.input as any)?.uri?.fsPath, file.path));

            for (const tab of tabsToClose) {
                try { await vscode.window.tabGroups.close(tab); } catch (e) {}
            }

            if (fs.existsSync(file.path)) {
                try { fs.unlinkSync(file.path); } catch (e) {}
            }
        }

        this.sharedFiles.splice(index, 1);
        this.engine.documentSyncManager.destroyYjsDoc(fileName);
        this.engine.decorationManager.removeDecorationsForFile(fileName);
        this.engine.cursorManager.clearCursorsForFile(fileName);
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
