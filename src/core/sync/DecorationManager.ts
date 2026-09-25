/**
 * @file DecorationManager.ts
 * @description 데코레이션(리뷰/피드백 오타, 문법오류 등) 추가/삭제, 재계산, 에디터 렌더링 및 가기 기능 등을 관리합니다.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as Y from 'yjs';
import { FileDecoration } from '../../types';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual } from '../../utils/helpers';

/**
 * DecorationManager 클래스.
 * 공유 중인 코드 상의 인라인 피드백(오타, 문법 오류, 논리 오류, 기타 메모, 하이라이트 등) 데코레이션을 생성,
 * 삭제, 동기화하며, 문서 내용 변경 시 Yjs 상대 위치를 기반으로 에디터 상의 절대 좌표를 재계산하여 렌더링합니다.
 */
export class DecorationManager {
    /** 현재 등록되어 있는 전체 데코레이션 목록 */
    public decorations: FileDecoration[] = [];

    /** 에디터에 데코레이션을 표시할지 여부 플래그 */
    public showDecorations: boolean = true;

    /** 파일별 좌표 재계산 지연 실행(디바운스)을 위한 타이머 맵 */
    private decorationRecalculateTimers = new Map<string, NodeJS.Timeout>();

    /** Typo(오타) 데코레이션 스타일 정의 (빨간색 물결 밑줄) */
    private typoDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 0, 0, 0.12)',
        textDecoration: 'underline wavy rgba(255, 0, 0, 0.7)'
    });

    /** Grammar(문법 오류) 데코레이션 스타일 정의 (주황색 물결 밑줄) */
    private grammarDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(240, 173, 78, 0.12)',
        textDecoration: 'underline wavy rgba(240, 173, 78, 0.7)'
    });

    /** Logical(논리 오류) 데코레이션 스타일 정의 (다홍색 물결 밑줄) */
    private logicalDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(217, 83, 79, 0.12)',
        textDecoration: 'underline wavy rgba(217, 83, 79, 0.7)'
    });

    /** Other(기타 의견) 데코레이션 스타일 정의 (하늘색 실선 밑줄) */
    private otherDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(91, 192, 222, 0.12)',
        textDecoration: 'underline solid rgba(91, 192, 222, 0.5)'
    });

    /** Highlight(강조) 데코레이션 스타일 정의 (연두색 배경) */
    private highlightDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(92, 184, 92, 0.22)'
    });

    /** 스크롤 시 데코레이션 렌더링 디바운스를 위한 타이머 */
    private scrollDebounceTimer?: NodeJS.Timeout;
    /** 에디터 가시 범위(스크롤) 변경 이벤트 리스너 구독 객체 */
    private visibleRangesDisposable?: vscode.Disposable;

    /**
     * DecorationManager 인스턴스를 생성하고 에디터 스크롤(가시 범위 변경) 리스너를 바인딩합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     */
    constructor(private engine: SyncEngine) {
        this.visibleRangesDisposable = vscode.window.onDidChangeTextEditorVisibleRanges(() => {
            if (this.scrollDebounceTimer) {
                clearTimeout(this.scrollDebounceTimer);
            }
            this.scrollDebounceTimer = setTimeout(() => {
                this.scrollDebounceTimer = undefined;
                this.refreshDecorationsInEditors();
            }, 40);
        });
    }

    /**
     * 빈번한 텍스트 편집 시 데코레이션 위치 재계산 부하를 줄이기 위해 디바운싱(200ms) 처리합니다.
     * @param fileName 대상 파일 이름.
     * @param filePath 로컬 파일 절대 경로.
     * @returns {void}
     */
    public debouncedRecalculateDecorations(fileName: string, filePath: string): void {
        const timer = this.decorationRecalculateTimers.get(fileName);
        if (timer) clearTimeout(timer);

        const newTimer = setTimeout(() => {
            this.recalculateDecorationsPositions(fileName, filePath);
        }, 200); // 200ms 디바운스
        this.decorationRecalculateTimers.set(fileName, newTimer);
    }

    /**
     * Yjs 상대 위치(RelativePosition)를 이용해 문서 변경 후 데코레이션들의 현재 에디터 절대 좌표를 역산하여 갱신합니다.
     * @param fileName 대상 파일 이름.
     * @param filePath 로컬 파일 절대 경로.
     * @returns {void}
     */
    public recalculateDecorationsPositions(fileName: string, filePath: string): void {
        const ydoc = this.engine.documentSyncManager.yDocs.get(fileName);
        const ytext = this.engine.documentSyncManager.yTexts.get(fileName);
        if (!ydoc || !ytext) return;

        const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, filePath) && !d.isClosed);
        if (!doc) return;

        let isModified = false;

        this.decorations.forEach(d => {
            if (d.fileName !== fileName || !d.startRel || !d.endRel) return;

            try {
                const startRelPos = Y.createRelativePositionFromJSON(d.startRel);
                const endRelPos = Y.createRelativePositionFromJSON(d.endRel);

                const startAbs = Y.createAbsolutePositionFromRelativePosition(startRelPos, ydoc);
                const endAbs = Y.createAbsolutePositionFromRelativePosition(endRelPos, ydoc);

                if (startAbs && endAbs) {
                    const yjsText = ytext.toString();
                    const newStartPos = this.engine.getPositionFromIndex(yjsText, startAbs.index);
                    const newEndPos = this.engine.getPositionFromIndex(yjsText, endAbs.index);

                    if (d.startLine !== newStartPos.line || d.startChar !== newStartPos.character ||
                        d.endLine !== newEndPos.line || d.endChar !== newEndPos.character) {
                        
                        d.startLine = newStartPos.line;
                        d.startChar = newStartPos.character;
                        d.endLine = newEndPos.line;
                        d.endChar = newEndPos.character;
                        isModified = true;
                    }
                }
            } catch (e) {
                this.engine.logToUI(`Error recalculating position for decoration ${d.id}: ${e}`);
            }
        });

        // 좌표 보정이 발생한 경우 화면 렌더링을 갱신하고 호스트인 경우 참가자들에게 브로드캐스트
        if (isModified) {
            this.refreshDecorationsInEditors();
            this.engine.pushUIUpdate();
            if (this.engine.isHost) {
                this.broadcastDecorations();
            }
        }
        // 상대방 사용자 커서들도 실시간 역산하여 에디터에 다시 렌더링
        this.engine.cursorManager.refreshAllDecorations();
    }

    /**
     * 현재 열려 있는 에디터 상에 데코레이션 배지 및 호버 툴팁을 렌더링합니다.
     * @returns {void}
     */
    public refreshDecorationsInEditors(): void {
        const visibleEditors = vscode.window.visibleTextEditors;
        visibleEditors.forEach(editor => {
            const document = editor.document;
            const file = this.engine.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, document.uri.fsPath));
            if (!file || !this.showDecorations) {
                // 공유 파일이 아니거나 데코레이션 표시가 비활성화된 경우 모든 데코레이션 제거
                editor.setDecorations(this.typoDecoType, []);
                editor.setDecorations(this.grammarDecoType, []);
                editor.setDecorations(this.logicalDecoType, []);
                editor.setDecorations(this.otherDecoType, []);
                editor.setDecorations(this.highlightDecoType, []);
                return;
            }

            const editorConfig = vscode.workspace.getConfiguration('editor', editor.document.uri);
            const editorFontSize = editorConfig.get<number>('fontSize') || 14;
            const badgeFontSize = Math.max(9, Math.round(editorFontSize * 0.8));

            // 본인이 볼 수 있는 권한의 데코레이션 필터링 (Host 전용인 경우 Host 또는 작성자만 열람 가능)
            const fileDecos = this.decorations.filter(d => d.fileName === file.name);
            const authorizedDecos = fileDecos.filter(d => {
                if (d.visibility === 'host') {
                    return this.engine.isHost || d.creatorId === this.engine.myId;
                }
                return true;
            });

            // 화면 가시 범위(visibleRanges) 기반 최적화:
            // 현재 화면에 보이는 줄 번호에 위아래 50줄 여유 버퍼(Overscan)를 두어,
            // 화면 밖 수천 줄에 있는 불필요한 데코레이션 렌더링 부하를 제거합니다.
            const visibleRanges = editor.visibleRanges;
            const OVERSCAN_LINES = 50;
            const docLineCount = document.lineCount;

            const visibleDecos = authorizedDecos.filter(d => {
                if (!visibleRanges || visibleRanges.length === 0) return true;
                return visibleRanges.some(vr => {
                    const minLine = Math.max(0, vr.start.line - OVERSCAN_LINES);
                    const maxLine = Math.min(docLineCount - 1, vr.end.line + OVERSCAN_LINES);
                    return d.endLine >= minLine && d.startLine <= maxLine;
                });
            });

            const decosByType: { [key: string]: vscode.DecorationOptions[] } = {
                Typo: [],
                Grammar: [],
                Logical: [],
                Other: [],
                Highlight: []
            };

            visibleDecos.forEach(d => {
                const range = new vscode.Range(
                    new vscode.Position(d.startLine, d.startChar),
                    new vscode.Position(d.endLine, d.endChar)
                );

                const hoverMarkdown = new vscode.MarkdownString();
                hoverMarkdown.isTrusted = true;
                const typeName = d.type === 'Typo' ? '오타' :
                                 d.type === 'Grammar' ? '문법 오류' :
                                 d.type === 'Logical' ? '논리 오류' :
                                 d.type === 'Other' ? '기타' : '하이라이트';

                hoverMarkdown.appendMarkdown(`### 🔍 [${typeName}] \n\n`);
                hoverMarkdown.appendMarkdown(`**작성자:** ${d.creatorName} (${d.creatorId === 'host' ? 'Host' : 'Guest'})\n\n`);
                if (d.memo) {
                    hoverMarkdown.appendMarkdown(`**메모:** ${d.memo}\n\n`);
                }

                // 호스트이거나 작성자 본인인 경우 호버 메시지에 인라인 삭제 버튼 제공
                const canDelete = this.engine.isHost || d.creatorId === this.engine.myId;
                if (canDelete) {
                    const deleteCommandUri = vscode.Uri.parse(`command:p2p-code-share.deleteDecoration?${encodeURIComponent(JSON.stringify(d.id))}`);
                    hoverMarkdown.appendMarkdown(`[🗑️ 삭제하기](${deleteCommandUri})`);
                }

                const badgeColor = d.type === 'Typo' ? '#d9534f' :
                                   d.type === 'Grammar' ? '#f0ad4e' :
                                   d.type === 'Logical' ? '#d9534f' :
                                   d.type === 'Other' ? '#5bc0de' : '#5cb85c';

                decosByType[d.type].push({
                    range,
                    hoverMessage: hoverMarkdown,
                    renderOptions: {
                        after: {
                            contentText: `[${typeName}]`,
                            color: 'white',
                            backgroundColor: badgeColor,
                            margin: '1.4em 0 0 0.2ch',
                            fontWeight: 'bold',
                            textDecoration: `none; font-size: ${badgeFontSize}px; padding: 1px 4px; border-radius: 3px; position: absolute; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3); z-index: 999; text-shadow: -1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.8);`
                        }
                    }
                });
            });

            editor.setDecorations(this.typoDecoType, decosByType['Typo']);
            editor.setDecorations(this.grammarDecoType, decosByType['Grammar']);
            editor.setDecorations(this.logicalDecoType, decosByType['Logical']);
            editor.setDecorations(this.otherDecoType, decosByType['Other']);
            editor.setDecorations(this.highlightDecoType, decosByType['Highlight']);
        });
    }

    /**
     * 사용자 에디터 상에서 선택된 영역에 대해 새 데코레이션을 생성하는 대화형 입력 플로우를 수행합니다.
     * @returns {Promise<void>}
     */
    public async addDecorationFlow(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const document = editor.document;
        const file = this.engine.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, document.uri.fsPath));
        if (!file) {
            vscode.window.showWarningMessage("공유 중인 파일에서만 데코레이션을 추가할 수 있습니다.");
            return;
        }

        const selection = editor.selection;

        // 데코레이션 종류 선택
        const typePick = await vscode.window.showQuickPick([
            { label: 'Typo (오타)', value: 'Typo' },
            { label: 'Grammar Error (문법 오류)', value: 'Grammar' },
            { label: 'Logical Error (논리 오류)', value: 'Logical' },
            { label: 'Other (기타)', value: 'Other' },
            { label: 'Highlight (하이라이트)', value: 'Highlight' }
        ], { placeHolder: '데코레이션 종류를 선택하세요' });

        if (!typePick) return;

        // 공개 범위 선택
        const visibilityPick = await vscode.window.showQuickPick([
            { label: 'Everyone (모두에게 보이기)', value: 'everyone' },
            { label: 'Host only (host에게만 보이기)', value: 'host' }
        ], { placeHolder: '공개 범위를 선택하세요' });

        if (!visibilityPick) return;

        // 메모 내용 입력
        const memo = await vscode.window.showInputBox({
            prompt: '메모 내용을 입력하세요',
            placeHolder: '여기에 메모 내용을 입력할 수 있습니다.'
        });

        if (memo === undefined) return;

        const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
        const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
        let startRel: any = undefined;
        let endRel: any = undefined;

        // Yjs 상대 위치 계산 (문서 편집 후에도 위치를 유지하기 위함)
        if (ydoc && ytext) {
            const docLen = ytext.length;
            const startIndex = Math.min(Math.max(0, document.offsetAt(selection.start)), docLen);
            const endIndex = Math.min(Math.max(0, document.offsetAt(selection.end)), docLen);
            startRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, startIndex));
            endRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, endIndex));
        }

        const newDeco: FileDecoration = {
            id: crypto.randomBytes(8).toString('hex'),
            fileName: file.name,
            startLine: selection.start.line,
            startChar: selection.start.character,
            endLine: selection.end.line,
            endChar: selection.end.character,
            type: typePick.value as any,
            visibility: visibilityPick.value as any,
            creatorId: this.engine.myId,
            creatorName: this.engine.myName || 'Anonymous',
            memo: memo || '',
            startRel,
            endRel
        };

        if (this.engine.isHost) {
            this.decorations.push(newDeco);
            this.broadcastDecorations();
        } else {
            // 게스트도 로컬 상태에 즉시 반영하여 화면 전환 반응성을 극대화(낙관적 UI)
            this.decorations.push(newDeco);
            this.engine.sendMessage('ADD_DECORATION', { decoration: newDeco });
        }
        
        this.refreshDecorationsInEditors();
        this.engine.pushUIUpdate();
    }

    /**
     * 특정 ID를 가진 데코레이션을 삭제합니다.
     * 게스트의 경우 자신이 생성한 데코레이션에 대해서만 삭제 요청을 보낼 수 있습니다.
     * @param id 삭제할 데코레이션 고유 ID.
     * @returns {void}
     */
    public deleteDecoration(id: string): void {
        if (this.engine.isHost) {
            this.decorations = this.decorations.filter(d => d.id !== id);
            this.broadcastDecorations();
        } else {
            const deco = this.decorations.find(d => d.id === id);
            if (deco && deco.creatorId === this.engine.myId) {
                this.engine.sendMessage('DELETE_DECORATION', { id, creatorId: this.engine.myId });
                // 게스트는 호스트 응답 전 로컬 상태를 우선 업데이트하여 화면 전환 반응성을 높임
                this.decorations = this.decorations.filter(d => d.id !== id);
                this.refreshDecorationsInEditors();
                this.engine.pushUIUpdate();
            } else {
                vscode.window.showWarningMessage("본인이 작성한 데코레이션만 삭제할 수 있습니다.");
            }
        }
    }

    /**
     * 전체 참가자들에게 권한 필터(공개 범위)를 적용하여 데코레이션 목록을 동기화 전송합니다. (호스트 전용)
     * @returns {void}
     */
    public broadcastDecorations(): void {
        if (!this.engine.isHost) return;
        Object.keys(this.engine.participantManager.participants).forEach(peerId => {
            if (peerId !== 'host') {
                const filtered = this.decorations.filter(d => d.visibility !== 'host' || d.creatorId === peerId);
                this.engine.sendMessageToPeer(peerId, 'SYNC_DECORATIONS', { decorations: filtered });
            }
        });
        this.refreshDecorationsInEditors();
        this.engine.pushUIUpdate();
    }

    /**
     * 사이드바 목록 등에서 클릭 시 해당 데코레이션이 위치한 에디터 라인으로 포커스를 이동합니다.
     * @param fileName 대상 파일 이름.
     * @param line 이동할 대상 라인 번호 (0-based).
     * @param char 이동할 대상 문자 컬럼 위치 (0-based).
     * @returns {void}
     */
    public jumpToDecoration(fileName: string, line: number, char: number): void {
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === fileName);
        if (file) {
            vscode.workspace.openTextDocument(file.path).then(doc => {
                vscode.window.showTextDocument(doc).then(editor => {
                    const pos = new vscode.Position(line, char);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                });
            });
        }
    }

    /**
     * 공유 취소 또는 삭제된 특정 파일의 모든 데코레이션을 제거합니다.
     * @param fileName 대상 파일 이름.
     * @returns {void}
     */
    public removeDecorationsForFile(fileName: string): void {
        this.decorations = this.decorations.filter(d => d.fileName !== fileName);
        this.refreshDecorationsInEditors();
    }

    /**
     * 데코레이션 표시/숨김 여부를 설정하고 에디터 렌더링을 갱신합니다.
     * @param show 데코레이션 표시 여부.
     * @returns {void}
     */
    public setShowDecorations(show: boolean): void {
        this.showDecorations = show;
        this.refreshDecorationsInEditors();
        this.engine.pushUIUpdate();
    }

    /**
     * 세션 종료 또는 방 퇴장 시 데코레이션 상태 및 재계산 타이머를 초기화합니다.
     * @returns {void}
     */
    public reset(): void {
        this.decorations = [];
        this.showDecorations = true;
        if (this.scrollDebounceTimer) {
            clearTimeout(this.scrollDebounceTimer);
            this.scrollDebounceTimer = undefined;
        }
        this.decorationRecalculateTimers.forEach(t => clearTimeout(t));
        this.decorationRecalculateTimers.clear();
        this.refreshDecorationsInEditors();
    }
}
