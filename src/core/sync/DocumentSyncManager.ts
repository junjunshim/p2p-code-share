/**
 * @file DocumentSyncManager.ts
 * @description Yjs CRDT 문서 관리, 초기 스냅샷 번들링, 실시간 델타 업데이트 및 에디터 동기화를 전담합니다.
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as fs from 'fs';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual } from '../../utils/helpers';

export class DocumentSyncManager {
    public yDocs = new Map<string, Y.Doc>();
    public yTexts = new Map<string, Y.Text>();

    // 원격 변경 적용 중 에코 방지 플래그 (파일별 단일 실행 컨텍스트용)
    public isApplyingRemote = new Map<string, boolean>();

    // 에디터 업데이트 순차 처리 큐 (FIFO Promise Queue)
    private editorUpdateQueues = new Map<string, Promise<void>>();

    // 자가 보정 (유휴 상태 이상 감지) 타이머
    private selfCorrectionTimers = new Map<string, NodeJS.Timeout>();

    constructor(private engine: SyncEngine) {}

    /**
     * 호스트가 새 파일을 공유할 때 Yjs 문서를 생성하고 초기 텍스트를 로드합니다.
     * @returns 초기 Yjs 상태의 Base64 인코딩 문자열
     */
    public createDocForHost(name: string, initialContent: string): string {
        this.destroyYjsDoc(name);

        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('codetext');
        ytext.insert(0, initialContent);

        this.yDocs.set(name, ydoc);
        this.yTexts.set(name, ytext);

        this.bindYjsEvents(name, ydoc, ytext);

        // 현재 문서 상태를 base64로 인코딩하여 반환
        return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
    }

    /**
     * 게스트가 초기 스냅샷을 수신했을 때 Yjs 문서를 생성하고 동기화합니다.
     */
    public createDocForGuest(name: string, yjsStateBase64?: string, fallbackContent?: string) {
        this.destroyYjsDoc(name);

        const ydoc = new Y.Doc();
        const ytext = ydoc.getText('codetext');

        if (yjsStateBase64) {
            try {
                const stateBinary = Uint8Array.from(Buffer.from(yjsStateBase64, 'base64'));
                Y.applyUpdate(ydoc, stateBinary, 'init');
            } catch (e) {
                if (fallbackContent) {
                    ytext.insert(0, fallbackContent);
                }
            }
        } else if (fallbackContent) {
            ytext.insert(0, fallbackContent);
        }

        this.yDocs.set(name, ydoc);
        this.yTexts.set(name, ytext);

        this.bindYjsEvents(name, ydoc, ytext);
    }

    /**
     * Yjs 문서의 update 및 observe 이벤트를 바인딩합니다.
     */
    private bindYjsEvents(name: string, ydoc: Y.Doc, ytext: Y.Text) {
        // Yjs 로컬 변경이 발생했을 때 피어들에게 브로드캐스트
        ydoc.on('update', (update, origin) => {
            // 원격 변경 적용 또는 초기화 단계는 브로드캐스트하지 않음 (무한 루프 방지)
            if (origin === 'remote' || origin === 'init') return;

            const base64Update = Buffer.from(update).toString('base64');
            this.engine.sendMessage('YJS_UPDATE', { fileName: name, update: base64Update });
        });

        // 원격 변경으로 Yjs 텍스트가 갱신되면 에디터 UI에 순차적으로 반영
        ytext.observe(event => {
            if (event.transaction.origin === 'remote') {
                this.queueUpdateEditor(name);
            }
        });
    }

    /**
     * 로컬 사용자의 타이핑을 Yjs 문서에 적용합니다.
     */
    public applyLocalChanges(fileName: string, contentChanges: readonly vscode.TextDocumentContentChangeEvent[]) {
        const ydoc = this.yDocs.get(fileName);
        const ytext = this.yTexts.get(fileName);
        if (!ydoc || !ytext) return;

        // 오프셋 위치가 변경되지 않도록 역순 정렬
        const sortedChanges = [...contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);

        ydoc.transact(() => {
            for (const change of sortedChanges) {
                if (change.rangeLength > 0) {
                    ytext.delete(change.rangeOffset, change.rangeLength);
                }
                if (change.text.length > 0) {
                    ytext.insert(change.rangeOffset, change.text);
                }
            }
        }, 'local');
    }

    /**
     * 원격에서 수신한 Yjs 델타 업데이트를 문서에 적용합니다.
     */
    public async handleYjsUpdate(msg: any) {
        const ydoc = this.yDocs.get(msg.fileName);
        if (!ydoc) return;

        try {
            const updateBinary = Uint8Array.from(Buffer.from(msg.update, 'base64'));
            Y.applyUpdate(ydoc, updateBinary, 'remote');
        } catch (e) {
            this.engine.logToUI(`Error applying Yjs update for ${msg.fileName}: ${e}`);
        }
    }

    /**
     * 원격 변경 사항을 에디터에 순차적으로 적용하기 위한 FIFO 큐입니다.
     */
    public queueUpdateEditor(fileName: string): Promise<void> {
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (!file) return Promise.resolve();

        const prev = this.editorUpdateQueues.get(fileName) || Promise.resolve();
        const next = prev.then(async () => {
            await this.applyYjsTextToEditor(fileName, file.path);
        }).catch(err => {
            this.engine.logToUI(`queueUpdateEditor error for ${fileName}: ${err}`);
        });

        this.editorUpdateQueues.set(fileName, next);
        return next;
    }

    /**
     * Yjs의 최신 텍스트와 VS Code 에디터의 텍스트를 최소 범위 교체(Surgical Diff)로 동기화합니다.
     */
    private async applyYjsTextToEditor(fileName: string, filePath: string) {
        // 이미 공유가 중지되었거나 Yjs 문서가 파기된 경우 즉시 중단
        if (!this.engine.fileStorageManager.sharedFiles.some(f => f.name === fileName)) return;

        const ytext = this.yTexts.get(fileName);
        if (!ytext) return;
        const targetContent = ytext.toString();

        const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, filePath) && !d.isClosed);
        if (!doc) {
            // 에디터가 열려있지 않다면 디스크에 직접 기록
            try {
                if (fs.existsSync(filePath)) {
                    fs.writeFileSync(filePath, targetContent, 'utf8');
                }
            } catch (e) {}
            return;
        }

        const oldText = doc.getText();
        if (oldText === targetContent) return;

        // 최소 변경 범위 (Surgical Range) 계산
        let start = 0;
        while (start < oldText.length && start < targetContent.length && oldText[start] === targetContent[start]) {
            start++;
        }

        let oldEnd = oldText.length;
        let newEnd = targetContent.length;
        while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === targetContent[newEnd - 1]) {
            oldEnd--;
            newEnd--;
        }

        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(oldEnd));
        const replaceText = targetContent.slice(start, newEnd);

        // 에코 방지를 위해 현재 파일에 대해 플래그 설정 (0ms 동기식 락)
        this.isApplyingRemote.set(fileName, true);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, range, replaceText);
            await vscode.workspace.applyEdit(edit);
        } catch (e) {
            this.engine.logToUI(`applyEdit failed for ${fileName}: ${e}`);
        } finally {
            // applyEdit 직후 즉시 플래그 해제
            this.isApplyingRemote.set(fileName, false);
            this.engine.decorationManager.debouncedRecalculateDecorations(fileName, filePath);
            this.engine.fileStorageManager.scheduleDebouncedSave(filePath);
        }
    }

    /**
     * 유휴 상태에서 혹시 모를 불일치를 검사하는 안전망입니다 (타이핑 멈춘 후 1.5초).
     */
    public triggerSelfCorrection(fileName: string, filePath: string) {
        const timer = this.selfCorrectionTimers.get(fileName);
        if (timer) clearTimeout(timer);

        const newTimer = setTimeout(async () => {
            this.selfCorrectionTimers.delete(fileName);
            const ytext = this.yTexts.get(fileName);
            if (!ytext) return;

            const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, filePath) && !d.isClosed);
            if (doc) {
                const editorText = doc.getText();
                const yjsText = ytext.toString();
                if (editorText !== yjsText) {
                    this.engine.logToUI(`Self-correction sync for ${fileName}`);
                    await this.queueUpdateEditor(fileName);
                }
            }
        }, 1500);
        this.selfCorrectionTimers.set(fileName, newTimer);
    }

    /**
     * 특정 파일의 Yjs 리소스를 해제합니다.
     */
    public destroyYjsDoc(fileName: string) {
        const timer = this.selfCorrectionTimers.get(fileName);
        if (timer) {
            clearTimeout(timer);
            this.selfCorrectionTimers.delete(fileName);
        }
        const ydoc = this.yDocs.get(fileName);
        if (ydoc) {
            ydoc.destroy();
            this.yDocs.delete(fileName);
            this.yTexts.delete(fileName);
        }
        this.isApplyingRemote.delete(fileName);
        this.editorUpdateQueues.delete(fileName);
    }

    /**
     * 모든 Yjs 문서를 정리하고 초기화합니다.
     */
    public reset() {
        this.selfCorrectionTimers.forEach(t => clearTimeout(t));
        this.selfCorrectionTimers.clear();
        this.yDocs.forEach(d => d.destroy());
        this.yDocs.clear();
        this.yTexts.clear();
        this.isApplyingRemote.clear();
        this.editorUpdateQueues.clear();
    }
}
