/**
 * @file HubManager.ts
 * @description 숨겨진 Webview 패널을 통해 P2P 연결 허브를 관리합니다.
 * P2P 작업을 위한 시그널링, 데이터 전송 및 연결 상태를 처리합니다.
 */

// Webview 관리를 위한 VS Code API
import * as vscode from 'vscode';
// 엔진 초기화를 위한 UI 템플릿
import { getEngineTemplate } from '../ui/templates';
// 공유 P2P 메시지 타입
import { P2PMessage } from '../types';

/**
 * HubManager 클래스.
 * Webview 내에서 실행되는 P2P 엔진의 생명주기를 관리합니다.
 */
export class HubManager {
    private _hubPanel?: vscode.WebviewPanel;
    public sdpMap: Map<string, string> = new Map(); 
    public onDidReceiveData?: (data: string, peerId: string) => void;
    public onStatusUpdate?: (status: string, peerId: string) => void;
    public onSdpGenerated?: (sdp: string, peerId: string) => void;
    public onRequireInvite?: () => void;
    public onRoomNameSuccess?: () => void;
    public onRoomNameError?: (errorType: string) => void;

    /**
     * HubManager의 새 인스턴스를 생성합니다.
     */
    constructor() {}

    /**
     * P2P 허브 Webview를 초기화합니다.
     * @param initiator 현재 노드가 연결 시작자인지 여부.
     * @param roomName 자동 시그널링에 사용할 방 이름.
     * @param peerId 피어의 고유 식별자.
     */
    public createHub(initiator: boolean, roomName: string = '', peerId: string = 'default') {
        if (!this._hubPanel) {
            // P2P 엔진을 위한 숨겨진 Webview 패널 생성
            this._hubPanel = vscode.window.createWebviewPanel('p2pHub', 'P2P Engine', vscode.ViewColumn.Two, { 
                enableScripts: true, 
                retainContextWhenHidden: true 
            });
            
            // HTML 템플릿 생성 및 로드
            const autoStart = !initiator; 
            this._hubPanel.webview.html = getEngineTemplate(initiator, autoStart, roomName);
            
            // Webview로부터의 메시지 리스너 설정
            this._hubPanel.webview.onDidReceiveMessage(msg => {
                const pid = msg.peerId || 'default';
                if (msg.type === 'sendData') this.onDidReceiveData?.(msg.value, pid);
                else if (msg.type === 'statusUpdate') this.onStatusUpdate?.(msg.value, pid);
                else if (msg.type === 'requireInvite') this.onRequireInvite?.();
                else if (msg.type === 'roomNameSuccess') this.onRoomNameSuccess?.();
                else if (msg.type === 'roomNameError') this.onRoomNameError?.(msg.errorType);
                else if (msg.type === 'sdpGenerated') {
                    // SDP 정보 업데이트
                    this.sdpMap.set(pid, msg.sdp);
                    this.onSdpGenerated?.(msg.sdp, pid);
                }
            });

            // 패널 해제 처리
            this._hubPanel.onDidDispose(() => {
                this._hubPanel = undefined;
                this.sdpMap.clear();
                this.onStatusUpdate?.('Disconnected', 'all');
            });

            if (!initiator) return;
        }

        // 필요한 경우 새 피어 추가
        if (initiator && peerId !== 'none' && peerId !== 'default') {
            this._hubPanel.webview.postMessage({ type: 'addNewPeer', initiator, peerId });
        }
    }

    /**
     * Webview를 통해 엔진으로 메시지를 보냅니다.
     * @param msg 보낼 메시지 객체.
     * @param to 대상 피어 ID.
     */
    public sendToEngine(msg: any, to?: string) {
        this._hubPanel?.webview.postMessage({ ...msg, targetPeerId: to });
    }

    /**
     * 허브 패널을 해제하고 연결을 지웁니다.
     */
    public dispose() {
        this._hubPanel?.dispose();
        this.sdpMap.clear();
    }

    /**
     * 연결에 시그널링 SDP를 적용합니다.
     * @param sdp SDP 객체.
     * @param peerId 대상 피어 ID.
     */
    public applySignal(sdp: any, peerId: string) {
        // 특정 피어를 위해 엔진에 시그널 전송
        this.sendToEngine({ type: 'signal', sdp, peerId }, peerId);
    }
}
