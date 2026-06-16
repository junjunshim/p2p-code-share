/**
 * @file DocumentSyncManager.ts
 * @description Yjs 문서 및 텍스트 관리, 초기 스냅샷 전송/복구, 실시간 델타 업데이트 및 자가 보정 기능을 담당합니다.
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as fs from 'fs';
import * as path from 'path';
import { SyncEngine } from '../SyncEngine';

export class DocumentSyncManager {
    public yDocs = new Map<string, Y.Doc>();
    public yTexts = new Map<string, Y.Text>();
    public remoteChangeLockCount = 0;
    private selfCorrectionTimers = new Map<string, NodeJS.Timeout>();

    public get isApplyingRemoteChange(): boolean {
        return this.remoteChangeLockCount > 0;
    }

    constructor(private engine: SyncEngine) {}

    /**
     * Yjs Doc 및 Text 객체를 초기 생성하고 이벤트를 바인딩합니다.
     */
    public initYjsDoc(name: string, filePath: string) {
        if (this.yDocs.has(name)) return;

        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('codetext');
        this.yDocs.set(name, ydoc);
        this.yTexts.set(name, ytext);

        // 호스트인 경우 원본 파일 내용을 Yjs에 채워넣음
        if (this.engine.isHost) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                ytext.insert(0, content);
            } catch (e) {
                this.engine.logToUI(`Error reading original file for initial Yjs insert: ${e}`);
            }
        }

        // Yjs 문서 업데이트 이벤트 바인딩
        ydoc.on('update', (update, origin) => {
            // 원격 변경 적용 중이거나 다른 피어가 보낸 변경이라면 무한 에코 루프 방지를 위해 스킵
            if (this.isApplyingRemoteChange || origin === 'remote') return;

            const base64Update = Buffer.from(update).toString('base64');
            this.engine.sendMessage('YJS_UPDATE', { fileName: name, update: base64Update });
        });

        // Yjs 텍스트 변경 감지 시 에디터에 반영
        ytext.observe(event => {
            if (event.transaction.origin === 'remote') {
                this.engine.fileStorageManager.forceUpdateEditor(name, ytext.toString(), filePath);
            }
        });
    }

    public destroyYjsDoc(name: string) {
        const ydoc = this.yDocs.get(name);
        if (ydoc) {
            ydoc.destroy();
            this.yDocs.delete(name);
            this.yTexts.delete(name);
        }
    }

    /**
     * 게스트 초기 스냅샷을 처리합니다.
     * @param msg 초기화 메시지 (파일 이름 및 내용 포함).
     */
    public async handleGuestInit(msg: any) {
        this.engine.isHost = false;
        if (!this.engine.fileStorageManager.isStorageInitialized) {
            this.engine.fileStorageManager.initializeStorage();
        }
        
        if (!this.engine.fileStorageManager.storagePath) {
            this.engine.logToUI(`Error: Storage not initialized before handleGuestInit. myId=${this.engine.myId}`);
            return;
        }

        // 스냅샷 경로 생성 및 파일 쓰기
        const snapshotPath = path.join(this.engine.fileStorageManager.storagePath, msg.fileName);
        this.engine.logToUI(`Writing snapshot to: ${snapshotPath}`);
        fs.writeFileSync(snapshotPath, msg.content);
        
        // 파일 목록에 추가
        this.engine.fileStorageManager.addSharedFile(msg.fileName, snapshotPath, undefined, msg.assigneeId, msg.assigneeName);

        // 문서 열기 및 표시
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);

        // 호스트에게 Sync Step 1 요청 전송하여 Yjs 동기화 시작
        const ydoc = this.yDocs.get(msg.fileName);
        if (ydoc) {
            const stateVector = Y.encodeStateVector(ydoc);
            this.engine.sendMessage('YJS_SYNC_STEP_1', {
                fileName: msg.fileName,
                stateVector: Buffer.from(stateVector).toString('base64')
            });
        }
    }

    /**
     * YJS 동기화 Sync Step 1 요청을 처리합니다 (호스트 전용).
     */
    public handleYjsSyncStep1(msg: any) {
        const name = msg.fileName;
        const ydoc = this.yDocs.get(name);
        if (!ydoc) return;

        try {
            const guestStateVector = Uint8Array.from(Buffer.from(msg.stateVector, 'base64'));
            const update = Y.encodeStateAsUpdate(ydoc, guestStateVector);

            this.engine.sendMessage('YJS_SYNC_STEP_2', {
                fileName: name,
                update: Buffer.from(update).toString('base64')
            });
        } catch (e) {
            this.engine.logToUI(`Error in handleYjsSyncStep1: ${e}`);
        }
    }

    /**
     * YJS 동기화 Sync Step 2 응답을 처리합니다 (게스트 전용).
     */
    public async handleYjsSyncStep2(msg: any) {
        const name = msg.fileName;
        const ydoc = this.yDocs.get(name);
        if (!ydoc) return;

        try {
            const update = Uint8Array.from(Buffer.from(msg.update, 'base64'));
            this.remoteChangeLockCount++;
            Y.applyUpdate(ydoc, update, 'remote');
        } catch (e) {
            this.engine.logToUI(`Error in handleYjsSyncStep2: ${e}`);
        } finally {
            setTimeout(() => {
                if (this.remoteChangeLockCount > 0) this.remoteChangeLockCount--;
            }, 400);
        }
    }

    /**
     * 실시간 YJS 델타 변경 패킷을 처리합니다.
     */
    public async handleYjsUpdate(msg: any) {
        const name = msg.fileName;
        const ydoc = this.yDocs.get(name);
        if (!ydoc) return;

        try {
            const updateBinary = Uint8Array.from(Buffer.from(msg.update, 'base64'));
            this.remoteChangeLockCount++;
            Y.applyUpdate(ydoc, updateBinary, 'remote');
        } catch (e) {
            this.engine.logToUI(`Error applying Yjs update: ${e}`);
        } finally {
            setTimeout(() => {
                if (this.remoteChangeLockCount > 0) this.remoteChangeLockCount--;
            }, 50);
        }
    }

    /**
     * 로컬 에디터 문서의 텍스트가 Yjs 내부의 진리 텍스트와 일치하는지 검증하고 강제 보정합니다.
     */
    public triggerSelfCorrection(fileName: string, filePath: string) {
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
                    this.engine.logToUI(`Self-correction (desync resolve) triggered for ${fileName} due to text mismatch.`);
                    await this.engine.fileStorageManager.forceUpdateEditor(fileName, yjsText, filePath);
                }
            }
        }, 200);
        this.selfCorrectionTimers.set(fileName, newTimer);
    }

    public reset() {
        this.yDocs.forEach(d => d.destroy());
        this.yDocs.clear();
        this.yTexts.clear();
        this.selfCorrectionTimers.forEach(t => clearTimeout(t));
        this.selfCorrectionTimers.clear();
        this.remoteChangeLockCount = 0;
    }
}
