/**
 * @file FileStorageManager.ts
 * @description 파일 저장소 초기화, 경로 정규화, 파일 I/O 및 읽기 전용 상태 관리를 담당합니다.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SharedFile } from '../../types';
import { sanitizePath, ensureDirectory } from '../../utils/helpers';
import { SyncEngine } from '../SyncEngine';

export class FileStorageManager {
    public storagePath: string = '';
    public isStorageInitialized: boolean = false;
    public sharedFiles: SharedFile[] = [];
    public closingDocuments = new Set<string>();

    constructor(private engine: SyncEngine) {}

    /**
     * 공유 파일 저장을 위한 저장소를 초기화합니다.
     */
    public initializeStorage() {
        if (this.isStorageInitialized) return;
        // 호스트나 게스트 연결 정보가 없으면 반환
        if (!this.engine.isHost && (!this.engine.myId || this.engine.myId === 'default' || !this.engine.roomName || this.engine.roomName === 'Untitled Room')) return;

        // 동일한 기기 내 다중 인스턴스 충돌 방지를 위해 myId를 경로에 포함
        const folderName = this.engine.isHost ? 'host' : this.engine.myId;
        this.storagePath = path.join(this.engine.context.globalStorageUri.fsPath, sanitizePath(this.engine.roomName), sanitizePath(folderName));
        // 디렉토리 존재 확인 및 생성
        ensureDirectory(this.storagePath);
        this.isStorageInitialized = true;
    }

    /**
     * 모든 공유 파일의 읽기 전용 상태를 현재 권한에 맞게 업데이트합니다.
     */
    public async updateAllReadonlyStates() {
        if (this.engine.isHost) return;
        for (const file of this.sharedFiles) {
            await this.updateReadonlyState(file);
        }
    }

    /**
     * 특정 공유 파일의 읽기 전용 상태를 업데이트합니다.
     * @param file 대상 공유 파일.
     */
    public async updateReadonlyState(file: SharedFile) {
        if (this.engine.isHost) return;
        try {
            const canEdit = this.engine.participantManager.canIEdit(file.name);
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
            this.engine.logToUI(`Failed to update readonly state for ${file.name}: ${e}`);
        }
    }

    /**
     * VS Code 에디터에 세션 읽기 전용 상태를 적용하거나 해제합니다.
     * @param editor 대상 에디터.
     * @param readonly 읽기 전용 여부.
     */
    public async applyEditorReadonlyState(editor: vscode.TextEditor, readonly: boolean) {
        if (this.engine.isHost) return;
        
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
            this.engine.logToUI(`Failed to execute session command: ${e}`);
        }
    }

    /**
     * 에디터의 내용을 강제로 업데이트합니다.
     * @param fileName 파일 이름.
     * @param content 파일의 새로운 내용.
     * @param specificPath 특정 파일 경로 (선택 사항).
     */
    public async forceUpdateEditor(fileName: string, content: string, specificPath?: string) {
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

        // [추가] 쓰기 전 잠시 읽기 전용 속성 해제
        const currentMode = fs.statSync(filePath).mode;
        const wasReadonly = (currentMode & 0o200) === 0;
        if (wasReadonly) fs.chmodSync(filePath, 0o666);

        this.engine.documentSyncManager.remoteChangeLockCount++;

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
                if (this.engine.documentSyncManager.remoteChangeLockCount > 0) {
                    this.engine.documentSyncManager.remoteChangeLockCount--;
                }
                this.engine.decorationManager.debouncedRecalculateDecorations(fileName, filePath);
                this.engine.documentSyncManager.triggerSelfCorrection(fileName, filePath);
            }, 50);
        }
    }

    /**
     * 공유 파일 목록에 파일을 추가합니다.
     * @param name 파일 이름.
     * @param filePath 파일 경로.
     * @param source 원본 파일 경로 (선택 사항).
     * @param assigneeId 담당자 피어 ID (선택 사항).
     * @param assigneeName 담당자 이름 (선택 사항).
     */
    public addSharedFile(name: string, filePath: string, source?: string, assigneeId?: string, assigneeName?: string) {
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
        this.engine.documentSyncManager.initYjsDoc(name, filePath);
        
        // [추가] 파일 추가 시 읽기 전용 상태 설정
        this.updateReadonlyState(file);
        
        // UI 상태 업데이트 알림
        this.engine.pushUIUpdate();
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
        if (!this.engine.isHost) return;
        
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
            this.engine.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
        }
    }

    /**
     * 원격 공유 중지 요청을 처리합니다.
     * @param fileName 중지할 파일 이름.
     */
    public async handleRemoteStop(fileName: string) {
        // 공유 파일 목록에서 인덱스 확인
        const index = this.sharedFiles.findIndex(f => f.name === fileName);
        if (index === -1) return;
        
        const file = this.sharedFiles[index];
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
        
        // 문서 닫기 및 탭 그룹에서 제거 (게스트만 수행)
        if (!this.engine.isHost && doc) {
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
        if (!this.engine.isHost && fs.existsSync(file.path)) {
            try { 
                // [추가] 읽기 전용 속성 해제 후 삭제
                fs.chmodSync(file.path, 0o666);
                fs.unlinkSync(file.path); 
            } catch(e) {}
        }
        
        // 목록에서 제거
        this.sharedFiles.splice(index, 1);

        // Yjs 자원 해제
        this.engine.documentSyncManager.destroyYjsDoc(fileName);

        // 해당 파일에 남겨졌던 모든 데코레이션(리뷰) 삭제 및 에디터 갱신
        this.engine.decorationManager.removeDecorationsForFile(fileName);

        this.engine.pushUIUpdate();
    }

    /**
     * 활성화된 파일을 공유합니다.
     * @param targetUri 공유할 파일의 URI (선택 사항).
     */
    public async shareActiveFile(targetUri?: vscode.Uri) {
        if (!this.engine.isHost || !this.isStorageInitialized) return;
        
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
        
        // 게스트에게 초기 스냅샷 전송
        this.engine.sendMessage('INIT_SNAPSHOT', { 
            fileName: virtualFileName, 
            content: document.getText(),
            assigneeId: undefined,
            assigneeName: undefined
        });
        this.addSharedFile(virtualFileName, sourcePath, backupPath);
        this.engine.logToUI(`Started sharing: ${fileName}`);
    }

    public reset() {
        this.sharedFiles = [];
        this.closingDocuments.clear();
        this.isStorageInitialized = false;
        this.storagePath = '';
    }
}
