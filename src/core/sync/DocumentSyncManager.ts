/**
 * @file DocumentSyncManager.ts
 * @description Yjs CRDT 문서 관리, 초기 스냅샷 번들링, 실시간 델타 업데이트 및 에디터 동기화를 전담합니다.
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as fs from 'fs';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual } from '../../utils/helpers';

/**
 * DocumentSyncManager 클래스.
 * Yjs CRDT(Conflict-free Replicated Data Types) 문서 인스턴스를 파일별로 생성 및 관리하고,
 * 로컬 에디터 변경 사항을 Yjs 텍스트로 변환하여 P2P 브로드캐스트하며,
 * 원격 피어로부터 수신된 Yjs 델타 업데이트를 VS Code 에디터 버퍼에 최소 범위 교체(Surgical Diff) 방식으로 안전하게 동기화합니다.
 */
export class DocumentSyncManager {
    /** 파일명별 Y.Doc 인스턴스 맵 */
    public yDocs = new Map<string, Y.Doc>();

    /** 파일명별 공유 텍스트 Y.Text 인스턴스 맵 */
    public yTexts = new Map<string, Y.Text>();

    /** 원격 델타 변경을 에디터에 적용하는 동안 로컬 텍스트 변경 리스너가 중복 발동(에코)되는 것을 방지하기 위한 플래그 맵 */
    public isApplyingRemote = new Map<string, boolean>();

    /** 고속 연속 타이핑 시 에디터 UI 스레드 부하를 방지하기 위한 렌더링 디바운스(30ms) 타이머 맵 */
    private renderDebounceTimers = new Map<string, NodeJS.Timeout>();

    /** 원격 변경 사항을 에디터에 순차적으로 적용하기 위한 파일별 FIFO Promise 큐 맵 */
    private editorUpdateQueues = new Map<string, Promise<void>>();

    /** 사용자가 타이핑을 멈춘 후 에디터 버퍼와 Yjs 텍스트 간의 미세한 불일치를 검사하여 자동 동기화하는 자가 보정 타이머 맵 */
    private selfCorrectionTimers = new Map<string, NodeJS.Timeout>();

    /**
     * DocumentSyncManager 인스턴스를 생성합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     */
    constructor(private engine: SyncEngine) {}

    /**
     * 호스트가 새로운 파일을 공유할 때 Yjs 문서 및 텍스트를 생성하고 초기 파일 내용을 로드합니다.
     * @param name 공유할 파일 이름.
     * @param initialContent 초기 파일 텍스트 내용.
     * @returns 게스트에게 전달할 초기 Yjs 상태의 Base64 인코딩 문자열.
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
     * 게스트가 호스트로부터 초기 스냅샷(INIT_SNAPSHOT)을 수신했을 때 Yjs 문서를 생성하고 초기 상태를 복원합니다.
     * @param name 대상 파일 이름.
     * @param yjsStateBase64 호스트가 전송한 Yjs 초기 상태 벡터 Base64 문자열 (선택 사항).
     * @param fallbackContent Yjs 복원 실패 시 사용할 원시 텍스트 내용 (선택 사항).
     * @returns {void}
     */
    public createDocForGuest(name: string, yjsStateBase64?: string, fallbackContent?: string): void {
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
     * Yjs 문서 인스턴스에 update(로컬 변경 피어 브로드캐스트) 및 observe(원격 변경 에디터 반영) 이벤트 핸들러를 바인딩합니다.
     * @param name 대상 파일 이름.
     * @param ydoc 바인딩할 Y.Doc 인스턴스.
     * @param ytext 바인딩할 Y.Text 인스턴스.
     * @returns {void}
     */
    private bindYjsEvents(name: string, ydoc: Y.Doc, ytext: Y.Text): void {
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
     * 로컬 사용자가 VS Code 에디터에서 타이핑하거나 편집한 변경 사항을 Yjs 트랜잭션으로 변환하여 반영합니다.
     * @param fileName 대상 파일 이름.
     * @param contentChanges VS Code 텍스트 문서 변경 이벤트 배열.
     * @returns {void}
     */
    public applyLocalChanges(fileName: string, contentChanges: readonly vscode.TextDocumentContentChangeEvent[]): void {
        const ydoc = this.yDocs.get(fileName);
        const ytext = this.yTexts.get(fileName);
        if (!ydoc || !ytext) return;

        // 뒤쪽 변경사항부터 적용되도록 역순 정렬 (줄 및 문자 위치 오프셋 왜곡 방지)
        const sortedChanges = [...contentChanges].sort((a, b) => {
            if (b.range.start.line !== a.range.start.line) {
                return b.range.start.line - a.range.start.line;
            }
            return b.range.start.character - a.range.start.character;
        });

        ydoc.transact(() => {
            for (const change of sortedChanges) {
                // CRLF 환경에서도 Yjs(LF 기준)와 완벽히 일치하는 시작 인덱스 및 삭제 길이 계산
                const currentContent = ytext.toString();
                const startIndex = this.engine.getIndexFromPosition(currentContent, change.range.start);
                const endIndex = this.engine.getIndexFromPosition(currentContent, change.range.end);
                const deleteLength = Math.max(0, endIndex - startIndex);

                if (deleteLength > 0) {
                    ytext.delete(startIndex, deleteLength);
                }

                // 삽입할 텍스트는 LF로 통일하여 삽입
                const textToInsert = change.text.replace(/\r\n/g, '\n');
                if (textToInsert.length > 0) {
                    ytext.insert(startIndex, textToInsert);
                }
            }
        }, 'local');
    }

    /**
     * 원격 피어로부터 수신된 Yjs 델타 업데이트(YJS_UPDATE) 바이너리를 로컬 Y.Doc에 병합 적용합니다.
     * @param msg 수신된 Yjs 업데이트 메시지 (파일명, Base64 직렬화 바이너리).
     * @returns {Promise<void>}
     */
    public async handleYjsUpdate(msg: any): Promise<void> {
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
     * 원격 변경 사항을 에디터에 순차적으로 반영하기 위한 FIFO 큐입니다.
     * 연속 입력(폭풍 타이핑) 시 에디터 UI 스레드가 마비되지 않도록 30ms 배치 버퍼링을 적용합니다.
     * @param fileName 대상 파일 이름.
     * @returns 에디터 갱신 완료를 나타내는 Promise.
     */
    public queueUpdateEditor(fileName: string): Promise<void> {
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (!file) return Promise.resolve();

        // 기존 대기 중인 렌더링 타이머가 있다면 리셋 (30ms 내 변경사항들을 하나로 배치 압축)
        const existingTimer = this.renderDebounceTimers.get(fileName);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        return new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                this.renderDebounceTimers.delete(fileName);

                const prev = this.editorUpdateQueues.get(fileName) || Promise.resolve();
                const next = prev.then(async () => {
                    await this.applyYjsTextToEditor(fileName, file.path);
                    resolve();
                }).catch(err => {
                    this.engine.logToUI(`queueUpdateEditor error for ${fileName}: ${err}`);
                    resolve();
                });

                this.editorUpdateQueues.set(fileName, next);
            }, 30);

            this.renderDebounceTimers.set(fileName, timer);
        });
    }

    /**
     * Yjs의 최신 텍스트와 VS Code 에디터 버퍼의 텍스트를 비교하여 최소 범위(Surgical Range)만 교체 적용합니다.
     * 에디터가 열려있지 않은 경우 디스크 파일에 직접 기록합니다.
     * @param fileName 대상 파일 이름.
     * @param filePath 로컬 파일 절대 경로.
     * @returns {Promise<void>}
     */
    private async applyYjsTextToEditor(fileName: string, filePath: string): Promise<void> {
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

        // 에코 무한 루프 방지를 위해 원격 변경 적용 플래그 설정
        this.isApplyingRemote.set(fileName, true);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, range, replaceText);
            await vscode.workspace.applyEdit(edit);
        } catch (e) {
            this.engine.logToUI(`applyEdit failed for ${fileName}: ${e}`);
        } finally {
            this.isApplyingRemote.set(fileName, false);
            this.engine.decorationManager.debouncedRecalculateDecorations(fileName, filePath);
            this.engine.cursorManager.refreshAllDecorations();
            this.engine.fileStorageManager.scheduleDebouncedSave(filePath);
        }
    }

    /**
     * 사용자가 타이핑을 멈춘 후 1.5초간 유휴 상태일 때 혹시 모를 에디터와 Yjs 간의 불일치를 자동 검사하여 보정합니다.
     * @param fileName 대상 파일 이름.
     * @param filePath 로컬 파일 절대 경로.
     * @returns {void}
     */
    public triggerSelfCorrection(fileName: string, filePath: string): void {
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
     * 특정 파일의 Y.Doc 및 관련 버퍼링 타이머, 업데이트 큐 자원을 완전히 해제합니다.
     * @param fileName 대상 파일 이름.
     * @returns {void}
     */
    public destroyYjsDoc(fileName: string): void {
        const timer = this.selfCorrectionTimers.get(fileName);
        if (timer) {
            clearTimeout(timer);
            this.selfCorrectionTimers.delete(fileName);
        }
        const renderTimer = this.renderDebounceTimers.get(fileName);
        if (renderTimer) {
            clearTimeout(renderTimer);
            this.renderDebounceTimers.delete(fileName);
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
     * 관리 중인 모든 Yjs 문서와 타이머, 큐 자원을 정리하고 초기화합니다.
     * @returns {void}
     */
    public reset(): void {
        this.selfCorrectionTimers.forEach(t => clearTimeout(t));
        this.selfCorrectionTimers.clear();
        this.renderDebounceTimers.forEach(t => clearTimeout(t));
        this.renderDebounceTimers.clear();
        this.yDocs.forEach(d => d.destroy());
        this.yDocs.clear();
        this.yTexts.clear();
        this.isApplyingRemote.clear();
        this.editorUpdateQueues.clear();
    }
}
