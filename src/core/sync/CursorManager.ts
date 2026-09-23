/**
 * @file CursorManager.ts
 * @description 원격/로컬 커서 위치 동기화, 사용자별 고유 색상 매핑 및 에디터 렌더링을 처리합니다.
 */

import * as vscode from 'vscode';
import * as Y from 'yjs';
import { SharedFile } from '../../types';
import { SyncEngine } from '../SyncEngine';
import { isPathEqual } from '../../utils/helpers';

/**
 * CursorManager 클래스.
 * 실시간 P2P 협업 중 로컬 사용자의 커서/선택 영역 변경을 감지하여 원격 피어로 브로드캐스트하고,
 * 원격 피어들의 커서 및 선택 영역 상태를 수신하여 VS Code 에디터 상에 색상별 배지와 함께 렌더링합니다.
 */
export class CursorManager {
    /** 렌더링할 커서 대상 필터링 모드 ('host': 호스트만, 'editable': 편집 권한 보유자만, 'all': 모든 참가자) */
    public cursorFilter: 'host' | 'editable' | 'all' = 'editable';

    /** 피어 ID별 활성화된 커서 데코레이션 객체 맵 */
    private remoteCursorDecorations = new Map<string, vscode.TextEditorDecorationType>();

    /** 피어 ID별 활성화된 텍스트 선택 영역 데코레이션 객체 맵 */
    private remoteSelectionDecorations = new Map<string, vscode.TextEditorDecorationType>();

    /** 피어 ID별 가장 최근에 수신된 원시 커서 상태(메시지) 맵 */
    private remoteCursorStates = new Map<string, any>();

    /** 피어 ID별로 할당된 16진수 색상 코드 맵 */
    private userColorMap = new Map<string, string>();

    /** 새 피어 접속 시 순차적으로 할당할 테마 색상 팔레트 목록 */
    private colorPalette = ['#4ec9b0', '#ffeb3b', '#2196f3', '#9c27b0', '#ff9800', '#00bcd4', '#8bc34a'];

    /** 불필요한 데코레이션 재생성을 방지하기 위한 피어별 데코레이션 캐시 정보 */
    private remoteCursorDecoTypes = new Map<string, { cursorDeco: vscode.TextEditorDecorationType; selectionDeco: vscode.TextEditorDecorationType; key: string }>();

    /** 커서 업데이트 전송 과부하 방지를 위한 쓰로틀 타이머 */
    private sendThrottleTimer?: NodeJS.Timeout;
    private pendingEditor?: vscode.TextEditor;

    /**
     * CursorManager 인스턴스를 생성하고 에디터 선택 이벤트 리스너를 바인딩합니다.
     * @param engine SyncEngine 메인 오케스트레이터 인스턴스.
     */
    constructor(private engine: SyncEngine) {
        this.setupSelectionListeners();
    }

    /**
     * VS Code 에디터의 커서/선택 영역 이동 이벤트를 감지하는 리스너를 설정합니다.
     * @returns {void}
     */
    private setupSelectionListeners(): void {
        vscode.window.onDidChangeTextEditorSelection(e => {
            // 자신의 ID가 정상적으로 할당된 경우에만 커서 업데이트를 전송
            if (!this.engine.myId || this.engine.myId === 'default' || this.engine.myId === '') return;
            
            // 30명 동시 환경에서 커서 패킷 폭증을 방지하기 위해 60ms 쓰로틀링 적용
            this.pendingEditor = e.textEditor;
            if (!this.sendThrottleTimer) {
                this.sendThrottleTimer = setTimeout(() => {
                    this.sendThrottleTimer = undefined;
                    if (this.pendingEditor) {
                        this.sendCursorUpdate(this.pendingEditor);
                    }
                }, 60);
            }
        });
    }

    /**
     * 현재 에디터의 커서 및 드래그 선택 영역을 Yjs 상대 좌표(RelativePosition)로 변환하여 피어들에게 브로드캐스트합니다.
     * @param editor 대상 VS Code 텍스트 에디터.
     * @returns {void}
     */
    public sendCursorUpdate(editor: vscode.TextEditor): void {
        const file = this.engine.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
        if (!file) return;

        const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
        const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
        if (!ydoc || !ytext) return;

        const selection = editor.selection;
        const document = editor.document;

        try {
            // 커서 위치 및 드래그 영역의 Yjs 상대 위치 생성 (LF 기준 정확한 오프셋 인덱스 산출)
            const yjsContent = ytext.toString();
            const docLen = ytext.length;
            const startIndex = Math.min(Math.max(0, this.engine.getIndexFromPosition(yjsContent, selection.start)), docLen);
            const endIndex = Math.min(Math.max(0, this.engine.getIndexFromPosition(yjsContent, selection.end)), docLen);
            const activeIndex = Math.min(Math.max(0, this.engine.getIndexFromPosition(yjsContent, selection.active)), docLen);

            // 다른 피어의 문서 변경 시에도 위치가 자동 추적되도록 상대 좌표로 직렬화
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
     * 원격 피어로부터 수신된 커서 및 선택 영역 상태를 저장하고 에디터 상에 렌더링합니다.
     * @param msg 수신된 커서 업데이트 메시지 객체.
     * @param peerId 메시지를 보낸 피어 ID.
     * @returns {void}
     */
    public updateRemoteCursor(msg: any, peerId: string): void {
        const actualPeerId = msg.userId || peerId; 
        
        // 로컬 자신의 커서 업데이트인 경우 중복 렌더링 방지
        if (actualPeerId === this.engine.myId) return;

        // 마지막 커서 상태 캐싱 (탭 재개방 또는 필터 변경 시 복구용)
        this.remoteCursorStates.set(actualPeerId, msg);
        
        const file = this.engine.fileStorageManager.sharedFiles.find(f => f.name === msg.fileName);
        if (!file) {
            // 파일이 다르거나 열려있지 않은 경우 잔여 데코레이션을 제거하여 고스트 커서 방지
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

        // 해당 파일에 존재하는 모든 원격 피어의 커서를 다시 계산하여 렌더링 (동일 위치 겹침 방지)
        this.renderCursorsForFile(file);
    }

    /**
     * 특정 공유 파일에 대해 수신된 원격 커서들을 상대 위치로부터 실제 문서 좌표로 복원하고 렌더링합니다.
     * 동일 좌표에 여러 커서가 존재할 경우 배지가 겹치지 않도록 수직 스택(Rank)을 계산합니다.
     * @param file 커서를 렌더링할 대상 공유 파일 객체.
     * @returns {void}
     */
    public renderCursorsForFile(file: SharedFile): void {
        const ydoc = this.engine.documentSyncManager.yDocs.get(file.name);
        const ytext = this.engine.documentSyncManager.yTexts.get(file.name);
        if (!ydoc || !ytext) return;

        const doc = vscode.workspace.textDocuments.find(d => isPathEqual(d.uri.fsPath, file.path) && !d.isClosed);
        if (!doc) return;

        // 해당 파일에 위치한 원격 피어들을 현재 커서 필터 조건에 맞게 추출
        const peersInFile = Array.from(this.remoteCursorStates.entries())
            .filter(([id, state]) => {
                if (state.fileName !== file.name || id === this.engine.myId) return false;
                
                // 설정된 커서 필터 모드 적용
                if (this.cursorFilter === 'host') {
                    return id === 'host';
                } else if (this.cursorFilter === 'editable') {
                    return this.engine.participantManager.canPeerEdit(id, file.name);
                }
                return true; // 'all' 모드
            });

        // Yjs 상대 좌표(RelativePosition)로부터 최신 실제 텍스트 오프셋 및 에디터 Position 계산
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

        // 동일 좌표에 커서가 위치할 경우 이름표 배지 겹침 방지를 위해 위치별 그룹화
        const posGroups = new Map<string, string[]>();
        parsedPeers.forEach(p => {
            const key = `${p.activePos.line},${p.activePos.character}`;
            if (!posGroups.has(key)) posGroups.set(key, []);
            posGroups.get(key)!.push(p.peerId);
        });

        // 결정론적 렌더링 순서를 위해 피어 ID 기준 정렬
        posGroups.forEach(ids => ids.sort());

        // 각 피어별 데코레이션 생성 및 에디터 적용
        parsedPeers.forEach(p => {
            const key = `${p.activePos.line},${p.activePos.character}`;
            const group = posGroups.get(key)!;
            const rank = group.indexOf(p.peerId);
            
            this.applyPeerDecorationWithPositions(p.peerId, p.state, file, rank, p.activePos, p.startPos, p.endPos);
        });

        // 필터링 등으로 인해 렌더링 대상에서 제외된 피어들의 기존 데코레이션 정리
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
     * 계산된 에디터 좌표와 스택 순위를 바탕으로 개별 피어의 커서 막대와 이름 배지를 렌더링합니다.
     * @param peerId 대상 피어 ID.
     * @param state 피어의 커서 상태 정보.
     * @param file 대상 공유 파일.
     * @param rank 동일 좌표 내 수직 적층 순위 (0부터 시작).
     * @param activePos 커서 활성 위치 (캐럿 위치).
     * @param startPos 선택 영역 시작 위치.
     * @param endPos 선택 영역 종료 위치.
     * @returns {void}
     */
    private applyPeerDecorationWithPositions(peerId: string, state: any, file: SharedFile, rank: number, activePos: vscode.Position, startPos: vscode.Position, endPos: vscode.Position): void {
        const editorConfig = vscode.workspace.getConfiguration('editor', vscode.Uri.file(file.path));
        const editorFontSize = editorConfig.get<number>('fontSize') || 14;
        const badgeFontSize = Math.max(9, Math.round(editorFontSize * 0.8));

        const color = this.getUserColor(peerId); 
        const verticalOffset = 1.4 + (rank * 1.5);
        const userName = state.userName || 'Anonymous';

        // 이전 렌더링 결과와 정확히 동일한 경우 재생성 생략 (성능 최적화)
        const cacheKey = `${activePos.line},${activePos.character},${startPos.line},${startPos.character},${endPos.line},${endPos.character},${rank},${badgeFontSize},${color},${userName}`;
        
        const cached = this.remoteCursorDecoTypes.get(peerId);
        if (cached && cached.key === cacheKey) {
            return;
        }

        // 이전 데코레이션 해제
        if (cached) {
            cached.cursorDeco.dispose();
            cached.selectionDeco.dispose();
        } else {
            const prevCursor = this.remoteCursorDecorations.get(peerId);
            if (prevCursor) prevCursor.dispose();
            const prevSelection = this.remoteSelectionDecorations.get(peerId);
            if (prevSelection) prevSelection.dispose();
        }

        // 2px 두께의 수직선 및 사용자 이름 배지 스타일 정의
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
        // 반투명 배경색의 텍스트 드래그 선택 영역 스타일 정의
        const selectionDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: color + '4D' });
        
        this.remoteCursorDecorations.set(peerId, cursorDeco);
        this.remoteSelectionDecorations.set(peerId, selectionDeco);
        this.remoteCursorDecoTypes.set(peerId, { cursorDeco, selectionDeco, key: cacheKey });
        
        const cursorRange = [new vscode.Range(activePos, activePos)];
        const selectionRange = [new vscode.Range(startPos, endPos)];

        // 현재 보이는 모든 해당 파일의 에디터에 데코레이션 적용
        const editors = vscode.window.visibleTextEditors.filter(e => isPathEqual(e.document.uri.fsPath, file.path));
        editors.forEach(editor => {
            editor.setDecorations(cursorDeco, cursorRange);
            editor.setDecorations(selectionDeco, selectionRange);
        });
    }

    /**
     * 현재 열려 있는 모든 화면 에디터의 커서 데코레이션을 현재 상태를 기반으로 다시 렌더링합니다.
     * @returns {void}
     */
    public refreshAllDecorations(): void {
        const processedFiles = new Set<string>();
        vscode.window.visibleTextEditors.forEach(editor => {
            const file = this.engine.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
            if (file && !processedFiles.has(file.path)) {
                this.renderCursorsForFile(file);
                processedFiles.add(file.path);
            }
        });

        this.engine.decorationManager.refreshDecorationsInEditors();
    }

    /**
     * 특정 파일에 등록되어 있는 모든 원격 커서 데코레이션을 제거합니다.
     * @param fileName 대상 파일 이름.
     * @returns {void}
     */
    public clearCursorsForFile(fileName: string): void {
        this.remoteCursorStates.forEach((state, peerId) => {
            if (state.fileName === fileName) {
                this.clearCursorForPeer(peerId);
            }
        });
    }

    /**
     * 특정 피어에 대해 등록된 커서 및 선택 영역 데코레이션 자원을 해제합니다.
     * @param peerId 대상 피어 ID.
     * @returns {void}
     */
    public clearCursorForPeer(peerId: string): void {
        const cursorDeco = this.remoteCursorDecorations.get(peerId);
        if (cursorDeco) {
            cursorDeco.dispose();
            this.remoteCursorDecorations.delete(peerId);
        }
        const selectionDeco = this.remoteSelectionDecorations.get(peerId);
        if (selectionDeco) {
            selectionDeco.dispose();
            this.remoteSelectionDecorations.delete(peerId);
        }
        this.remoteCursorStates.delete(peerId);
        this.remoteCursorDecoTypes.delete(peerId);
    }

    /**
     * 피어 ID에 매핑된 테마 색상을 반환합니다. 할당된 색상이 없으면 팔레트에서 새로 할당합니다.
     * Host 피어의 경우 붉은색(#f44336)으로 고정됩니다.
     * @param peerId 대상 피어 ID.
     * @returns 16진수 색상 코드 문자열.
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
     * 특정 피어가 방을 퇴장할 때 해당 피어의 모든 커서 자원 및 색상 매핑을 완전히 제거합니다.
     * @param peerId 퇴장한 피어 ID.
     * @returns {void}
     */
    public clearPeerCursor(peerId: string): void {
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
     * 커서 필터 모드를 변경하고 현재 활성 에디터의 커서 표시를 갱신합니다.
     * @param filter 새로운 커서 필터 모드 ('host' | 'editable' | 'all').
     * @returns {void}
     */
    public setCursorFilter(filter: 'host' | 'editable' | 'all'): void {
        this.cursorFilter = filter;
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const file = this.engine.fileStorageManager.sharedFiles.find(f => isPathEqual(f.path, editor.document.uri.fsPath));
            if (file) {
                this.renderCursorsForFile(file);
            }
        }
        this.engine.pushUIUpdate();
    }

    /**
     * 모든 원격 커서 및 선택 영역 데코레이션을 파기하고 캐시를 초기화합니다.
     * @returns {void}
     */
    public stopAll(): void {
        this.remoteCursorDecorations.forEach(d => d.dispose());
        this.remoteCursorDecorations.clear();
        this.remoteSelectionDecorations.forEach(d => d.dispose());
        this.remoteSelectionDecorations.clear();
        this.remoteCursorStates.clear();
        this.userColorMap.clear();
        this.remoteCursorDecoTypes.clear();
    }

    /**
     * CursorManager의 모든 상태를 초기 상태로 리셋합니다.
     * @returns {void}
     */
    public reset(): void {
        this.stopAll();
    }
}
