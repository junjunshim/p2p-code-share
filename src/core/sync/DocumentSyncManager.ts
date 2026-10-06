/** Yjs CRDT 문서 관리, 초기 스냅샷 번들링, 실시간 델타 업데이트 및 에디터 동기화를 전담합니다. */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import * as fs from 'fs';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual, normalizeEOL } from '../../utils/helpers';

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

    /**
     * 확장이 에디터에 반영한 최근 원격 목표 텍스트(줄바꿈 정규화) 목록.
     * VS Code 는 applyEdit 완료 뒤에 문서 변경 이벤트를 전달하므로 불리언 플래그로는 에코를 식별할 수 없다.
     * 따라서 "변경된 내용이 최근에 적용한 원격 내용과 같은가"를 비교하여 에코를 판정한다.
     * 원격 델타가 연속 도착하면 Yjs 가 먼저 전진할 수 있어 마지막 1건만으로는 부족하므로 최근 N건을 보관한다.
     */
    private recentRemoteTargets = new Map<string, string[]>();

    /** 파일별로 기억해 둘 최근 원격 목표 텍스트 개수 */
    private static readonly RECENT_TARGET_LIMIT = 8;

    /**
     * 파일별 최신 Yjs 텍스트(LF) 캐시.
     * Yjs 는 편집이 누적되면 item 이 쪼개져 toString() 이 O(n) 전체 재구성이 되므로,
     * 입력/커서/데코레이션 경로에서 반복 호출하지 않도록 문자열을 재사용한다. ydoc update 마다 무효화한다.
     */
    private yjsTextCache = new Map<string, string>();

    /** 고속 연속 타이핑 시 에디터 UI 스레드 부하를 방지하기 위한 렌더링 디바운스(30ms) 타이머 맵 */
    private renderDebounceTimers = new Map<string, NodeJS.Timeout>();

    /** 원격 변경 사항을 에디터에 순차적으로 적용하기 위한 파일별 FIFO Promise 큐 맵 */
    private editorUpdateQueues = new Map<string, Promise<void>>();

    /** 사용자가 타이핑을 멈춘 후 에디터 버퍼와 Yjs 텍스트 간의 미세한 불일치를 검사하여 자동 동기화하는 자가 보정 타이머 맵 */
    private selfCorrectionTimers = new Map<string, NodeJS.Timeout>();

    /**
     * 스냅샷(INIT_SNAPSHOT)이 도착하기 전에 먼저 도착한 원격 델타를 파일별로 보관하는 대기 큐.
     * 이 시점의 델타를 버리면 Yjs 특성상 해당 편집이 영구 유실되므로, 수신 순서대로 보관했다가
     * 문서 생성(createDocForGuest) 직후 일괄 적용한다.
     */
    private pendingRemoteUpdates = new Map<string, Array<{ msg: any; receivedAt: number }>>();

    /** 대기 큐가 무한히 커지지 않도록 하는 파일별 최대 보관 개수 */
    private static readonly PENDING_UPDATE_LIMIT = 2000;

    /** 대기 큐 항목의 최대 보관 시간(ms). 이 시간을 넘긴 항목은 정합성을 보장할 수 없어 폐기한다. */
    private static readonly PENDING_UPDATE_TTL_MS = 120000;

    /**
     * DocumentSyncManager 인스턴스를 생성합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     */
    constructor(private engine: SyncEngine) {}

    /**
     * 파일의 최신 Yjs 텍스트(LF)를 반환합니다. 캐시가 유효하면 재사용해 toString() 재구성을 줄입니다.
     * @param fileName 대상 파일 이름.
     * @returns 텍스트, 또는 Y.Text 가 없으면 undefined.
     */
    public getYjsText(fileName: string): string | undefined {
        const ytext = this.yTexts.get(fileName);
        if (!ytext) return undefined;
        return this.getYjsTextFor(fileName, ytext);
    }

    /** Y.Text 인스턴스를 이미 보유한 호출자용 캐시 조회. 길이까지 확인해 무효화 누락 시에도 안전하다. */
    private getYjsTextFor(fileName: string, ytext: Y.Text): string {
        const cached = this.yjsTextCache.get(fileName);
        if (cached !== undefined && cached.length === ytext.length) return cached;
        const text = ytext.toString();
        this.yjsTextCache.set(fileName, text);
        return text;
    }

    /** 파일의 Yjs 텍스트 캐시를 무효화합니다. ydoc update 직후 호출합니다. */
    public invalidateYjsText(fileName: string): void {
        this.yjsTextCache.delete(fileName);
    }

    /**
     * 변경 이벤트가 확장이 적용한 원격 내용(에코)인지 판정합니다.
     * VS Code 는 applyEdit 완료 후에 문서 변경 이벤트를 전달하므로 플래그 기반 가드는 신뢰할 수 없습니다.
     * 대신 "에디터 텍스트가 Yjs 와 같아졌는가"를 내용으로 검사하여 에코를 식별하고,
     * 다르면 사용자 편집으로 간주하여 절대 버리지 않습니다(호출측에서 Yjs 에 반영).
     * @param fileName 대상 파일 이름.
     * @param doc 변경이 발생한 VS Code 문서.
     * @returns 에코(원격 반영 결과)이면 true.
     */
    public isRemoteEcho(fileName: string, doc: vscode.TextDocument): boolean {
        const ytext = this.yTexts.get(fileName);
        if (!ytext) return false;

        // Yjs 텍스트 삽입은 CRLF 를 차단하므로 LF 가 보장된다. CR 이 없으면 정규화(정규식 스캔)를 생략한다.
        const yjsText = this.getYjsTextFor(fileName, ytext);
        const yjsNorm = yjsText.includes('\r') ? normalizeEOL(yjsText) : yjsText;

        // 에디터 텍스트도 CR 이 없으면 정규화 결과가 동일하므로 생략한다.
        const rawEditorText = doc.getText();
        const editorText = rawEditorText.includes('\r') ? normalizeEOL(rawEditorText) : rawEditorText;
        if (editorText === yjsNorm) {
            return true;
        }

        // 적용 직후 Yjs 가 더 전진한 경우(원격 델타가 먼저 반영됨)에도 에코로 인식한다.
        const targets = this.recentRemoteTargets.get(fileName);
        if (targets && targets.includes(editorText)) {
            return true;
        }

        return false;
    }

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

        // 스냅샷보다 먼저 도착해 보관해 둔 델타가 있으면 수신 순서대로 적용한다.
        this.flushPendingRemoteUpdates(name);
    }

    /**
     * Yjs 문서 인스턴스에 update(로컬 변경 피어 브로드캐스트) 및 observe(원격 변경 에디터 반영) 이벤트 핸들러를 바인딩합니다.
     * @param name 대상 파일 이름.
     * @param ydoc 바인딩할 Y.Doc 인스턴스.
     * @param ytext 바인딩할 Y.Text 인스턴스.
     */
    private bindYjsEvents(name: string, ydoc: Y.Doc, ytext: Y.Text): void {
        // Yjs 로컬 변경이 발생했을 때 피어들에게 브로드캐스트
        ydoc.on('update', (update, origin) => {
            // 텍스트가 바뀌었으므로 LF 텍스트 캐시를 무효화한다(모든 origin 공통).
            this.invalidateYjsText(name);
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
                const currentContent = this.getYjsTextFor(fileName, ytext);
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

                // 트랜잭션 내부에서는 update 이벤트가 아직 발생하지 않으므로 직접 캐시를 무효화한다.
                this.invalidateYjsText(fileName);
            }
        }, 'local');
    }

    /**
     * 원격 피어로부터 수신된 Yjs 델타 업데이트(YJS_UPDATE) 바이너리를 로컬 Y.Doc에 병합 적용합니다.
     * @param msg 수신된 Yjs 업데이트 메시지 (파일명, Base64 직렬화 바이너리).
     */
    public async handleYjsUpdate(msg: any): Promise<void> {
        const fileName = typeof msg?.fileName === 'string' ? msg.fileName : '';
        const ydoc = fileName ? this.yDocs.get(fileName) : undefined;
        if (!ydoc) {
            // 대용량 스냅샷(INIT_SNAPSHOT)이 아직 도착하지 않았거나 청크를 조립하는 중일 수 있다.
            // 여기서 버리면 해당 편집이 영구 유실되므로 보관했다가 문서 생성 직후 적용한다.
            this.bufferPendingRemoteUpdate(msg, fileName);
            return;
        }

        this.applyRemoteUpdate(fileName, ydoc, msg);
    }

    /**
     * Y.Doc이 아직 준비되지 않은 파일의 원격 델타를 수신 순서대로 보관합니다.
     * 대용량 스냅샷은 청크 조립에 시간이 걸리므로, 그 사이 도착한 델타를 버리지 않고 보관했다가
     * 문서 생성 직후 적용하여 편집 유실을 방지합니다.
     * @param msg 수신된 Yjs 업데이트 메시지.
     * @param fileName 대상 파일 이름.
     */
    private bufferPendingRemoteUpdate(msg: any, fileName: string): void {
        if (!fileName) return;

        const now = Date.now();
        const queue = this.pendingRemoteUpdates.get(fileName) ?? [];

        // TTL이 지난 항목은 최신 스냅샷과의 정합성을 보장할 수 없으므로 폐기하고 로그로 노출한다.
        const fresh = queue.filter(entry => now - entry.receivedAt <= DocumentSyncManager.PENDING_UPDATE_TTL_MS);
        if (fresh.length !== queue.length) {
            this.engine.logToUI('Discarded ' + (queue.length - fresh.length) + ' stale Yjs update(s) for ' + fileName + ' (snapshot not received in time).');
        }

        fresh.push({ msg, receivedAt: now });

        if (fresh.length > DocumentSyncManager.PENDING_UPDATE_LIMIT) {
            const overflow = fresh.length - DocumentSyncManager.PENDING_UPDATE_LIMIT;
            fresh.splice(0, overflow);
            this.engine.logToUI('Yjs update buffer overflow for ' + fileName + ': dropped ' + overflow + ' oldest update(s).');
        }

        this.pendingRemoteUpdates.set(fileName, fresh);
    }

    /**
     * 문서 생성 직후, 보관해 둔 원격 델타를 수신 순서대로 적용합니다.
     * @param fileName 스냅샷 생성이 끝난 파일 이름.
     */
    private flushPendingRemoteUpdates(fileName: string): void {
        const queue = this.pendingRemoteUpdates.get(fileName);
        if (!queue || queue.length === 0) return;

        this.pendingRemoteUpdates.delete(fileName);

        const ydoc = this.yDocs.get(fileName);
        if (!ydoc) return;

        const now = Date.now();
        let applied = 0;
        for (const entry of queue) {
            if (now - entry.receivedAt > DocumentSyncManager.PENDING_UPDATE_TTL_MS) continue;
            this.applyRemoteUpdate(fileName, ydoc, entry.msg);
            applied++;
        }

        this.engine.logToUI('Applied ' + applied + ' buffered Yjs update(s) for ' + fileName + ' after snapshot.');
    }

    /**
     * Base64로 인코딩된 원격 델타를 Y.Doc에 병합 적용합니다.
     * @param fileName 대상 파일 이름.
     * @param ydoc 적용 대상 Y.Doc.
     * @param msg 수신된 Yjs 업데이트 메시지.
     */
    private applyRemoteUpdate(fileName: string, ydoc: Y.Doc, msg: any): void {
        try {
            const updateBinary = Uint8Array.from(Buffer.from(msg.update, 'base64'));
            Y.applyUpdate(ydoc, updateBinary, 'remote');
        } catch (e) {
            this.engine.logToUI('Error applying Yjs update for ' + fileName + ': ' + e);
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
     */
    private async applyYjsTextToEditor(fileName: string, filePath: string): Promise<void> {
        // 이미 공유가 중지되었거나 Yjs 문서가 파기된 경우 즉시 중단
        if (!this.engine.fileStorageManager.sharedFiles.some(f => f.name === fileName)) return;

        const ytext = this.yTexts.get(fileName);
        if (!ytext) return;
        const targetContent = this.getYjsTextFor(fileName, ytext);

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
        // Yjs 텍스트는 항상 LF 로 정규화되어 있으므로, 줄바꿈만 다른 경우는 내용이 같다(불필요한 전체 교체/캐럿 이동 방지).
        const oldTextNorm = normalizeEOL(oldText);
        const targetNorm = normalizeEOL(targetContent);
        if (oldTextNorm === targetNorm) return;

        // 최소 변경 범위 (Surgical Range) 계산 — 줄바꿈을 LF 로 통일한 뒤 비교한다.
        let start = 0;
        while (start < oldTextNorm.length && start < targetNorm.length && oldTextNorm[start] === targetNorm[start]) {
            start++;
        }

        let oldEnd = oldTextNorm.length;
        let newEnd = targetNorm.length;
        while (oldEnd > start && newEnd > start && oldTextNorm[oldEnd - 1] === targetNorm[newEnd - 1]) {
            oldEnd--;
            newEnd--;
        }

        // LF 정규화 오프셋을 원본 문서(CRLF 가능) 오프셋으로 되돌린다.
        const toRawOffset = (normOffset: number): number => {
            if (doc.eol !== vscode.EndOfLine.CRLF) return normOffset;
            let raw = 0;
            for (let i = 0; i < normOffset; i++) {
                raw += (oldText.charCodeAt(raw) === 13 && oldText.charCodeAt(raw + 1) === 10) ? 2 : 1;
            }
            return raw;
        };

        const range = new vscode.Range(doc.positionAt(toRawOffset(start)), doc.positionAt(toRawOffset(oldEnd)));
        // 문서의 줄바꿈 규칙을 유지하여 개행이 섞이지 않게 한다(혼합 개행은 이후 diff 를 계속 어긋나게 만든다).
        const replaceText = doc.eol === vscode.EndOfLine.CRLF
            ? targetNorm.slice(start, newEnd).replace(/\n/g, '\r\n')
            : targetNorm.slice(start, newEnd);

        // 에코 판정은 플래그가 아니라 내용 비교로 수행하므로, 적용한 목표 텍스트를 최근 목록에 기록해 둔다.
        const targets = this.recentRemoteTargets.get(fileName) ?? [];
        targets.push(normalizeEOL(targetContent));
        if (targets.length > DocumentSyncManager.RECENT_TARGET_LIMIT) {
            targets.splice(0, targets.length - DocumentSyncManager.RECENT_TARGET_LIMIT);
        }
        this.recentRemoteTargets.set(fileName, targets);
        try {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, range, replaceText);
            await vscode.workspace.applyEdit(edit);
        } catch (e) {
            this.engine.logToUI(`applyEdit failed for ${fileName}: ${e}`);
        } finally {
            this.engine.decorationManager.debouncedRecalculateDecorations(fileName, filePath);
            this.engine.cursorManager.refreshAllDecorations();
            this.engine.fileStorageManager.scheduleDebouncedSave(filePath);
        }
    }

    /**
     * 사용자가 타이핑을 멈춘 후 1.5초간 유휴 상태일 때 혹시 모를 에디터와 Yjs 간의 불일치를 자동 검사하여 보정합니다.
     * @param fileName 대상 파일 이름.
     * @param filePath 로컬 파일 절대 경로.
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
                const yjsText = this.getYjsTextFor(fileName, ytext);
                // 줄바꿈 차이만 있는 경우는 동기화된 것으로 본다(불필요한 재적용/캐럿 이동 방지).
                if (normalizeEOL(editorText) !== normalizeEOL(yjsText)) {
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
        this.recentRemoteTargets.delete(fileName);
        this.editorUpdateQueues.delete(fileName);
        this.yjsTextCache.delete(fileName);
    }

    /**
     * 관리 중인 모든 Yjs 문서와 타이머, 큐 자원을 정리하고 초기화합니다.
     */
    public reset(): void {
        this.selfCorrectionTimers.forEach(t => clearTimeout(t));
        this.selfCorrectionTimers.clear();
        this.renderDebounceTimers.forEach(t => clearTimeout(t));
        this.renderDebounceTimers.clear();
        this.yDocs.forEach(d => d.destroy());
        this.yDocs.clear();
        this.yTexts.clear();
        this.recentRemoteTargets.clear();
        this.editorUpdateQueues.clear();
        this.pendingRemoteUpdates.clear();
        this.yjsTextCache.clear();
    }
}
