/**
 * @file DecorationManager.ts
 * @description 데코레이션(리뷰/피드백 오타, 문법오류 등) 추가/삭제, 재계산, 에디터 렌더링 및 가기 기능 등을 관리합니다.
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as Y from 'yjs';
import { FileDecoration } from '../../types';
import { SyncEngine } from '../SyncEngine';

export class DecorationManager {
    public decorations: FileDecoration[] = [];
    private decorationRecalculateTimers = new Map<string, NodeJS.Timeout>();

    private typoDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 0, 0, 0.12)',
        textDecoration: 'underline wavy rgba(255, 0, 0, 0.7)'
    });
    private grammarDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(240, 173, 78, 0.12)',
        textDecoration: 'underline wavy rgba(240, 173, 78, 0.7)'
    });
    private logicalDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(217, 83, 79, 0.12)',
        textDecoration: 'underline wavy rgba(217, 83, 79, 0.7)'
    });
    private otherDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(91, 192, 222, 0.12)',
        textDecoration: 'underline solid rgba(91, 192, 222, 0.5)'
    });
    private highlightDecoType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(92, 184, 92, 0.22)'
    });

    constructor(private engine: SyncEngine) {}

    /**
     * 데코레이션 위치 재계산을 디바운싱 처리합니다.
     */
    public debouncedRecalculateDecorations(fileName: string, filePath: string) {
        const timer = this.decorationRecalculateTimers.get(fileName);
        if (timer) clearTimeout(timer);

        const newTimer = setTimeout(() => {
            this.recalculateDecorationsPositions(fileName, filePath);
        }, 200); // 200ms debounce
        this.decorationRecalculateTimers.set(fileName, newTimer);
    }

    /**
     * Yjs 상대 위치를 이용해 데코레이션(리뷰)들의 현재 절대 에디터 좌표를 역산하여 갱신합니다.
     */
    public recalculateDecorationsPositions(fileName: string, filePath: string) {
        const ydoc = this.engine.documentSyncManager.yDocs.get(fileName);
        const ytext = this.engine.documentSyncManager.yTexts.get(fileName);
        if (!ydoc || !ytext) return;

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath && !d.isClosed);
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

        if (isModified) {
            this.refreshDecorationsInEditors();
            this.engine.pushUIUpdate();
            if (this.engine.isHost) {
                this.broadcastDecorations();
            }
        }
        this.engine.cursorManager.refreshAllDecorations(); // 데코레이션 보정 여부와 관계없이 상대방 사용자 커서들도 실시간 역산하여 새로 칠함
    }

    /**
     * 에디터에 데코레이션을 렌더링합니다.
     */
    public refreshDecorationsInEditors() {
        const visibleEditors = vscode.window.visibleTextEditors;
        visibleEditors.forEach(editor => {
            const document = editor.document;
            const file = this.engine.fileStorageManager.sharedFiles.find(f => f.path === document.uri.fsPath);
            if (!file) {
                // 공유 파일이 아닌 경우 데코레이션 제거
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

            // 본인에게 보이는 데코레이션 필터링
            const fileDecos = this.decorations.filter(d => d.fileName === file.name);
            const visibleDecos = fileDecos.filter(d => {
                if (d.visibility === 'host') {
                    return this.engine.isHost || d.creatorId === this.engine.myId;
                }
                return true;
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

                // 삭제 권한이 있는 경우 툴팁에 삭제 버튼 추가
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
     * 우클릭 메뉴를 통해 데코레이션을 추가하는 플로우입니다.
     */
    public async addDecorationFlow() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const document = editor.document;
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.path === document.uri.fsPath);
        if (!file) {
            vscode.window.showWarningMessage("공유 중인 파일에서만 데코레이션을 추가할 수 있습니다.");
            return;
        }

        const selection = editor.selection;

        const typePick = await vscode.window.showQuickPick([
            { label: 'Typo (오타)', value: 'Typo' },
            { label: 'Grammar Error (문법 오류)', value: 'Grammar' },
            { label: 'Logical Error (논리 오류)', value: 'Logical' },
            { label: 'Other (기타)', value: 'Other' },
            { label: 'Highlight (하이라이트)', value: 'Highlight' }
        ], { placeHolder: '데코레이션 종류를 선택하세요' });

        if (!typePick) return;

        const visibilityPick = await vscode.window.showQuickPick([
            { label: 'Everyone (모두에게 보이기)', value: 'everyone' },
            { label: 'Host only (host에게만 보이기)', value: 'host' }
        ], { placeHolder: '공개 범위를 선택하세요' });

        if (!visibilityPick) return;

        const memo = await vscode.window.showInputBox({
            prompt: '메모 내용을 입력하세요',
            placeHolder: '여기에 메모 내용을 입력할 수 있습니다.'
        });

        if (memo === undefined) return;

        const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
        const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
        let startRel: any = undefined;
        let endRel: any = undefined;

        if (ydoc && ytext) {
            const startIndex = document.offsetAt(selection.start);
            const endIndex = document.offsetAt(selection.end);
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
            this.engine.sendMessage('ADD_DECORATION', { decoration: newDeco });
        }
        
        this.refreshDecorationsInEditors();
        this.engine.pushUIUpdate();
    }

    /**
     * 지정된 ID의 데코레이션을 삭제합니다.
     */
    public deleteDecoration(id: string) {
        if (this.engine.isHost) {
            this.decorations = this.decorations.filter(d => d.id !== id);
            this.broadcastDecorations();
        } else {
            const deco = this.decorations.find(d => d.id === id);
            if (deco && deco.creatorId === this.engine.myId) {
                this.engine.sendMessage('DELETE_DECORATION', { id });
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
     * 데코레이션 목록을 참가자들에게 공유합니다. (호스트 전용)
     */
    public broadcastDecorations() {
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
     * 해당 데코레이션이 작성된 파일과 라인 위치로 이동합니다.
     */
    public jumpToDecoration(fileName: string, line: number, char: number) {
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

    public removeDecorationsForFile(fileName: string) {
        this.decorations = this.decorations.filter(d => d.fileName !== fileName);
        this.refreshDecorationsInEditors();
    }

    public reset() {
        this.decorations = [];
        this.decorationRecalculateTimers.forEach(t => clearTimeout(t));
        this.decorationRecalculateTimers.clear();
        this.refreshDecorationsInEditors();
    }
}
