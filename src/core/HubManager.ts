/**
 * @file HubManager.ts
 * @description 사이드바 Webview를 통해 P2P 연결 허브를 관리합니다.
 * P2P 작업을 위한 시그널링, 데이터 전송 및 연결 상태를 처리합니다.
 */

// Webview 관리를 위한 VS Code API
import * as vscode from 'vscode';
// 공유 P2P 메시지 타입
import { P2PMessage } from '../types';

/**
 * HubManager 클래스.
 * 사이드바 Webview 내에서 실행되는 P2P 엔진과의 연동을 관리합니다.
 */
export class HubManager {
    private _webview?: vscode.Webview;
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
     * P2P 허브에 대응하는 사이드바 웹뷰를 세팅합니다.
     */
    public setWebview(webview: vscode.Webview) {
        this._webview = webview;
    }

    /**
     * P2P 허브 Webview 엔진을 활성화(초기 연결 요청 전송)합니다.
     * @param initiator 현재 노드가 연결 시작자인지 여부.
     * @param roomName 자동 시그널링에 사용할 방 이름.
     * @param peerId 피어의 고유 식별자.
     */
    public createHub(initiator: boolean, roomName: string = '', peerId: string = 'default') {
        const config = vscode.workspace.getConfiguration('p2pCodeShare');
        const turnUrl = config.get<string>('turnUrl') || '';
        const turnUsername = config.get<string>('turnUsername') || '';
        const turnCredential = config.get<string>('turnCredential') || '';
        const turnConfig = turnUrl ? { url: turnUrl, username: turnUsername, credential: turnCredential } : undefined;

        // peerId가 'none'이거나 'default'인 경우에만 엔진을 최초 시작합니다.
        if (peerId === 'none' || peerId === 'default') {
            this.sendToEngine({
                type: 'startEngine',
                initiator,
                autoStart: !initiator,
                roomName,
                turnConfig,
                peerId
            });
        } else {
            // 이미 엔진이 실행 중인 상태에서 새 피어를 추가하는 경우
            if (initiator) {
                this.sendToEngine({ type: 'addNewPeer', initiator, peerId });
            }
        }
    }

    /**
     * Webview를 통해 엔진으로 메시지를 보냅니다.
     * @param msg 보낼 메시지 객체.
     * @param to 대상 피어 ID.
     */
    public sendToEngine(msg: any, to?: string) {
        this._webview?.postMessage({ ...msg, targetPeerId: to });
    }

    /**
     * 엔진에 정지 메시지를 전송하고 상태를 해제합니다.
     */
    public dispose() {
        this.sendToEngine({ type: 'stopEngine' });
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
