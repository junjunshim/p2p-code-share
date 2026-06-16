/**
 * @file CursorManager.ts
 * @description 원격/로컬 커서 위치 동기화, 사용자별 고유 색상 매핑 및 에디터 렌더링을 처리합니다.
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import { SharedFile } from '../../types';
import { SyncEngine } from '../SyncEngine';

export class CursorManager {
    public cursorFilter: 'host' | 'editable' | 'all' = 'host';
    private remoteCursorDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteSelectionDecorations = new Map<string, vscode.TextEditorDecorationType>();
    private remoteCursorStates = new Map<string, any>();
    private userColorMap = new Map<string, string>();
    private colorPalette = ['#4ec9b0', '#ffeb3b', '#2196f3', '#9c27b0', '#ff9800', '#00bcd4', '#8bc34a'];
    private remoteCursorDecoTypes = new Map<string, { cursorDeco: vscode.TextEditorDecorationType; selectionDeco: vscode.TextEditorDecorationType; key: string }>();

    constructor(private engine: SyncEngine) {
        this.setupSelectionListeners();
    }

    private setupSelectionListeners() {
        vscode.window.onDidChangeTextEditorSelection(e => {
            // [핵심] myId가 정상적으로 할당된 경우에만 전송
            if (!this.engine.myId || this.engine.myId === 'default' || this.engine.myId === '') return;
            this.sendCursorUpdate(e.textEditor);
        });
    }

    public sendCursorUpdate(editor: vscode.TextEditor) {
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
        if (!file) return;

        const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
        const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
        if (!ydoc || !ytext) return;

        const selection = editor.selection;
        const document = editor.document;

        try {
            // 커서 위치 및 드래그 영역의 Yjs 상대 위치 생성
            const startIndex = document.offsetAt(selection.start);
            const endIndex = document.offsetAt(selection.end);
            const activeIndex = document.offsetAt(selection.active);

            const startRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, startIndex));
            const endRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, endIndex));
            const activeRel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, activeIndex));

            this.engine.sendMessage('CURSOR_UPDATE', {
                fileName: file.name,
                userId: this.engine.myId,
                userName: this.engine.myName,
                startRel,
                endRel,
                activeRel
            });
        } catch (err) {
            this.engine.logToUI(`Error creating relative cursor positions: ${err}`);
        }
    }

    /**
     * 원격 피어의 커서 및 선택 영역을 업데이트하고 렌더링합니다.
     * @param msg 커서 업데이트 메시지.
     * @param peerId 피어 ID.
     */
    public updateRemoteCursor(msg: any, peerId: string) {
        const actualPeerId = msg.userId || peerId; 
        
        // 내 자신의 커서 업데이트라면 렌더링하지 않음
        if (actualPeerId === this.engine.myId) return;

        // 마지막 커서 상태 저장 (에디터 재개방 시 복구용)
        this.remoteCursorStates.set(actualPeerId, msg);
        
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) {
            // 파일이 다르거나 없더라도 이전 데코레이션은 무조건 정리 (고스트 커서 방지)
            const cached = this.remoteCursorDecoTypes.get(actualPeerId);
            if (cached) {
                cached.cursorDeco.dispose();
                cached.selectionDeco.dispose();
                this.remoteCursorDecoTypes.delete(actualPeerId);
            }
            const prevCursor = this.remoteCursorDecorations.get(actualPeerId);
            if (prevCursor) prevCursor.dispose();
            const prevSelection = this.remoteSelectionDecorations.get(actualPeerId);
            if (prevSelection) prevSelection.dispose();
            return;
        }

        // 해당 파일의 모든 원격 커서 다시 그리기 (겹침 방지 및 수직 스택 계산)
        this.renderCursorsForFile(file);
    }

    public renderCursorsForFile(file: SharedFile) {
        const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
        const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
        if (!ydoc || !ytext) return;

        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path && !d.isClosed);
        if (!doc) return;

        // 해당 파일에 있는 모든 원격 피어 필터링 (커서 필터 적용)
        const peersInFile = Array.from(this.remoteCursorStates.entries())
            .filter(([id, state]) => {
                if (state.fileName !== file.name || id === this.engine.myId) return false;
                
                // 커서 필터 조건 적용
                if (this.cursorFilter === 'host') {
                    return id === 'host';
                } else if (this.cursorFilter === 'editable') {
                    return this.engine.participantManager.canPeerEdit(id, file.name);
                }
                return true; // 'all'
            });

        // 먼저 각 피어별로 Yjs 상대 좌표로부터 최신 실제 Position을 역산
        const parsedPeers: { peerId: string; state: any; activePos: vscode.Position; startPos: vscode.Position; endPos: vscode.Position }[] = [];
        const yjsText = ytext.toString();
        peersInFile.forEach(([peerId, state]) => {
            if (!state.startRel || !state.endRel || !state.activeRel) return;

            try {
                const startRelPos = Y.createRelativePositionFromJSON(state.startRel);
                const endRelPos = Y.createRelativePositionFromJSON(state.endRel);
                const activeRelPos = Y.createRelativePositionFromJSON(state.activeRel);

                const startAbs = Y.createAbsolutePositionFromRelativePosition(startRelPos, ydoc);
                const endAbs = Y.createAbsolutePositionFromRelativePosition(endRelPos, ydoc);
                const activeAbs = Y.createAbsolutePositionFromRelativePosition(activeRelPos, ydoc);

                if (startAbs && endAbs && activeAbs) {
                    parsedPeers.push({
                        peerId,
                        state,
                        activePos: this.engine.getPositionFromIndex(yjsText, activeAbs.index),
                        startPos: this.engine.getPositionFromIndex(yjsText, startAbs.index),
                        endPos: this.engine.getPositionFromIndex(yjsText, endAbs.index)
                    });
                }
            } catch (e) {}
        });

        // 위치별 피어 그룹화 (겹침 방지 및 수직 스택용)
        const posGroups = new Map<string, string[]>();
        parsedPeers.forEach(p => {
            const key = `${p.activePos.line},${p.activePos.character}`;
            if (!posGroups.has(key)) posGroups.set(key, []);
            posGroups.get(key)!.push(p.peerId);
        });

        // 정렬
        posGroups.forEach(ids => ids.sort());

        // 렌더링 적용
        parsedPeers.forEach(p => {
            const key = `${p.activePos.line},${p.activePos.character}`;
            const group = posGroups.get(key)!;
            const rank = group.indexOf(p.peerId);
            
            this.applyPeerDecorationWithPositions(p.peerId, p.state, file, rank, p.activePos, p.startPos, p.endPos);
        });

        // 필터링 등으로 인해 이제 렌더링 대상이 아닌 피어들의 기존 데코레이션 제거
        const activePeerIds = new Set(parsedPeers.map(p => p.peerId));
        this.remoteCursorDecoTypes.forEach((cached, peerId) => {
            if (!activePeerIds.has(peerId)) {
                cached.cursorDeco.dispose();
                cached.selectionDeco.dispose();
                this.remoteCursorDecoTypes.delete(peerId);
                
                const prevCursor = this.remoteCursorDecorations.get(peerId);
                if (prevCursor) prevCursor.dispose();
                const prevSelection = this.remoteSelectionDecorations.get(peerId);
                if (prevSelection) prevSelection.dispose();
            }
        });
    }

    /**
     * 역산된 에디터 좌표를 기반으로 개별 피어의 데코레이션을 생성하고 적용합니다.
     */
    private applyPeerDecorationWithPositions(peerId: string, state: any, file: SharedFile, rank: number, activePos: vscode.Position, startPos: vscode.Position, endPos: vscode.Position) {
        const editorConfig = vscode.workspace.getConfiguration('editor', vscode.Uri.file(file.path));
        const editorFontSize = editorConfig.get<number>('fontSize') || 14;
        const badgeFontSize = Math.max(9, Math.round(editorFontSize * 0.8));

        const color = this.getUserColor(peerId); 
        const verticalOffset = 1.4 + (rank * 1.5);
        const userName = state.userName || 'Anonymous';

        const cacheKey = `${activePos.line},${activePos.character},${startPos.line},${startPos.character},${endPos.line},${endPos.character},${rank},${badgeFontSize},${color},${userName}`;
        
        const cached = this.remoteCursorDecoTypes.get(peerId);
        if (cached && cached.key === cacheKey) {
            return;
        }

        // 이전 데코레이션 정리
        if (cached) {
            cached.cursorDeco.dispose();
            cached.selectionDeco.dispose();
        } else {
            const prevCursor = this.remoteCursorDecorations.get(peerId);
            if (prevCursor) prevCursor.dispose();
            const prevSelection = this.remoteSelectionDecorations.get(peerId);
            if (prevSelection) prevSelection.dispose();
        }

        // 새 커서 데코레이션 생성
        const cursorDeco = vscode.window.createTextEditorDecorationType({
            borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: color,
            after: {
                contentText: userName, 
                backgroundColor: color, color: 'white', 
                margin: `${verticalOffset}em 0 0 0`, 
                fontWeight: 'bold',
                textDecoration: `none; font-size: ${badgeFontSize}px; padding: 1px 4px; border-radius: 3px; position: absolute; z-index: ${1000 - rank}; white-space: nowrap; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,0.3); text-shadow: -1px -1px 0 rgba(0,0,0,0.8), 1px -1px 0 rgba(0,0,0,0.8), -1px 1px 0 rgba(0,0,0,0.8), 1px 1px 0 rgba(0,0,0,0.8);`
            }
        });
        // 새 선택 영역 데코레이션 생성
        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        
        this.remoteCursorDecorations.set(peerId, cursorDeco);
        this.remoteSelectionDecorations.set(peerId, selectionDeco);
        this.remoteCursorDecoTypes.set(peerId, { cursorDeco, selectionDeco, key: cacheKey });
        
        const cursorRange = [new vscode.Range(activePos, activePos)];
        const selectionRange = [new vscode.Range(startPos, endPos)];

        const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.fsPath === file.path);
        editors.forEach(editor => {
            editor.setDecorations(cursorDeco, cursorRange);
            editor.setDecorations(selectionDeco, selectionRange);
        });
    }

    /**
     * 모든 에디터의 데코레이션을 현재 상태를 기반으로 새로고침합니다.
     */
    public refreshAllDecorations() {
        const processedFiles = new Set<string>();
        vscode.window.visibleTextEditors.forEach(editor => {
            const file = this.engine.fileStorageManager.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file && !processedFiles.has(file.path)) {
                this.renderCursorsForFile(file);
                processedFiles.add(file.path);
            }
        });

        this.engine.decorationManager.refreshDecorationsInEditors();
    }

    /**
     * 피어 ID에 할당된 색상을 가져옵니다.
     */
    public getUserColor(peerId: string): string {
        if (peerId === 'host' || (!this.engine.isHost && peerId === 'default')) return '#f44336';
        if (!this.userColorMap.has(peerId)) {
            const color = this.colorPalette[this.userColorMap.size % this.colorPalette.length];
            this.userColorMap.set(peerId, color);
        }
        return this.userColorMap.get(peerId)!;
    }

    /**
     * 특정 피어에 대해 할당된 커서 자원을 해제합니다.
     */
    public clearPeerCursor(peerId: string) {
        const deco = this.remoteCursorDecorations.get(peerId); 
        if (deco) deco.dispose(); 
        this.remoteCursorDecorations.delete(peerId);
        this.remoteCursorStates.delete(peerId);
        
        const selDeco = this.remoteSelectionDecorations.get(peerId); 
        if (selDeco) selDeco.dispose(); 
        this.remoteSelectionDecorations.delete(peerId);
        
        const cached = this.remoteCursorDecoTypes.get(peerId);
        if (cached) {
            cached.cursorDeco.dispose();
            cached.selectionDeco.dispose();
            this.remoteCursorDecoTypes.delete(peerId);
        }

        this.userColorMap.delete(peerId); 
        this.engine.pushUIUpdate(); 
    }

    /**
     * 커서 필터 방식을 변경하고 화면을 재갱신합니다.
     */
    public setCursorFilter(filter: 'host' | 'editable' | 'all') {
        this.cursorFilter = filter;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const file = this.engine.fileStorageManager.sharedFiles.find(f => f.path === editor.document.uri.fsPath);
            if (file) {
                this.renderCursorsForFile(file);
            }
        }
        this.engine.pushUIUpdate();
    }

    public stopAll() {
        this.remoteCursorDecorations.forEach(d => d.dispose());
        this.remoteCursorDecorations.clear();
        this.remoteSelectionDecorations.forEach(d => d.dispose());
        this.remoteSelectionDecorations.clear();
        this.remoteCursorStates.clear();
        this.userColorMap.clear();
        this.remoteCursorDecoTypes.clear();
    }

    public reset() {
        this.stopAll();
    }
}
