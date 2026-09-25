/**
 * @file HubManager.ts
 * @description 사이드바 Webview를 통해 P2P 연결 허브를 관리합니다.
 * P2P 작업을 위한 시그널링, 데이터 전송 및 연결 상태를 처리합니다.
 */

// Webview 관리를 위한 VS Code API
import * as vscode from 'vscode';
// 공유 P2P 메시지 타입
import { P2PMessage } from '../types';
// WebView(Chromium) 대신 Node에서 STUN 서버 주소를 미리 해석하기 위한 모듈
import * as dns from 'dns';

/**
 * WebView(Chromium)의 STUN 호스트 조회 실패(ICE error 701)를 피하기 위해
 * 확장 호스트(Node)에서 미리 IP로 해석해 전달하는 STUN 서버 목록입니다.
 */
const STUN_SERVER_ENDPOINTS: ReadonlyArray<{ host: string; port: number }> = [
    { host: 'stun.l.google.com', port: 19302 },
    { host: 'stun.cloudflare.com', port: 3478 },
    { host: 'stun.nextcloud.com', port: 443 }
];

/** STUN 서버 호스트 이름 해석 제한 시간(ms) */
const STUN_LOOKUP_TIMEOUT_MS = 1500;

/**
 * HubManager 클래스.
 * VS Code 확장 백엔드와 사이드바 Webview 내에서 구동되는 WebRTC P2P 엔진 간의
 * 시그널링, 데이터 송수신 및 생명주기 통신을 중계하는 역할을 담당합니다.
 */
export class HubManager {
    /** 사이드바 Webview 인스턴스 참조 (메시지 포스팅용) */
    private _webview?: vscode.Webview;

    /** Webview가 준비되기 전 전송 요청된 메시지 대기열 */
    private _pendingMessageQueue: Array<{ msg: any; to?: string }> = [];

    /** 피어 ID별 최신 SDP 문자열을 보관하는 맵 */
    public sdpMap: Map<string, string> = new Map();

    /** 피어로부터 데이터 채널을 통해 원시 데이터를 수신했을 때 호출되는 콜백 */
    public onDidReceiveData?: (data: string, peerId: string) => void;

    /** 특정 피어와의 연결 상태(connecting, connected, disconnected 등)가 변경되었을 때 호출되는 콜백 */
    public onStatusUpdate?: (status: string, peerId: string) => void;

    /** WebRTC 시그널링 오퍼/앤서 SDP가 생성되었을 때 호출되는 콜백 */
    public onSdpGenerated?: (sdp: string, peerId: string) => void;

    /** 방 입장을 위해 초대 코드가 필요할 때 호출되는 콜백 */
    public onRequireInvite?: () => void;

    /** 방 이름 설정/검증이 성공했을 때 호출되는 콜백 */
    public onRoomNameSuccess?: () => void;

    /** 방 이름 중복 등의 오류가 발생했을 때 호출되는 콜백 */
    public onRoomNameError?: (errorType: string) => void;

    /** WebRTC ICE 연결 실패가 감지되었을 때 호출되는 콜백 */
    public onIceFailed?: (peerId: string) => void;

    /**
     * HubManager의 새 인스턴스를 생성합니다.
     */
    constructor() {}

    /** Node에서 IP로 해석된 STUN 서버 URL 캐시 */
    private _stunServerUrls: string[] | null = null;

    /** STUN 서버 URL 해석 진행 중 프로미스 (중복 해석 방지) */
    private _stunServerResolving: Promise<string[]> | null = null;

    /**
     * STUN 서버 주소를 Node의 DNS로 미리 IP 리터럴로 해석합니다.
     * WebView에서 호스트 이름 조회가 실패(ICE error 701)하면 srflx(공인 IP) 후보를 받을 수 없으므로,
     * 확장 호스트에서 해석한 IP를 WebView 엔진에 전달합니다. 해석에 실패한 항목은 호스트 이름을 그대로 사용합니다.
     */
    private resolveStunServers(): Promise<string[]> {
        if (this._stunServerUrls) {
            return Promise.resolve(this._stunServerUrls);
        }
        if (!this._stunServerResolving) {
            this._stunServerResolving = Promise.all(STUN_SERVER_ENDPOINTS.map(async endpoint => {
                try {
                    const address = await Promise.race([
                        dns.promises.lookup(endpoint.host, { family: 4 }).then(result => result.address),
                        new Promise<string | undefined>(resolve => setTimeout(() => resolve(undefined), STUN_LOOKUP_TIMEOUT_MS))
                    ]);
                    if (address) {
                        return `stun:${address}:${endpoint.port}`;
                    }
                } catch {
                    // 해석 실패 시 아래에서 호스트 이름을 그대로 사용합니다.
                }
                return `stun:${endpoint.host}:${endpoint.port}`;
            })).then(urls => {
                // 서로 다른 호스트가 같은 IP로 해석되면 중복 STUN 서버는 효과가 없으므로 제거합니다.
                const uniqueUrls = urls.filter((url, index) => urls.indexOf(url) === index);
                this._stunServerUrls = uniqueUrls;
                this._stunServerResolving = null;
                return uniqueUrls;
            });
        }
        return this._stunServerResolving;
    }

    /**
     * P2P 허브에 대응하는 사이드바 Webview 인스턴스를 설정합니다.
     * @param webview VS Code Webview 인스턴스.
     * @returns {void}
     */
    public setWebview(webview: vscode.Webview): void {
        this._webview = webview;
        // 대기열에 쌓인 메시지가 있다면 순서대로 전송
        while (this._pendingMessageQueue.length > 0) {
            const item = this._pendingMessageQueue.shift();
            if (item) {
                this.sendToEngine(item.msg, item.to);
            }
        }
    }

    /**
     * P2P 허브 Webview 엔진을 활성화(초기 연결 요청 전송)합니다.
     * VS Code 설정에서 TURN 서버 구성을 읽어와 엔진 초기화에 전달합니다.
     * @param initiator 현재 노드가 연결 시작자(Host)인지 여부.
     * @param roomName 자동 시그널링에 사용할 방 이름 (기본값: 빈 문자열).
     * @param peerId 피어의 고유 식별자 (기본값: 'default').
     * @returns {void}
     */
    public createHub(initiator: boolean, roomName: string = '', peerId: string = 'default'): void {
        // VS Code 설정에서 TURN 서버 연결 정보 로드
        const config = vscode.workspace.getConfiguration('p2pCodeShare');
        const turnUrl = config.get<string>('turnUrl') || '';
        const turnUsername = config.get<string>('turnUsername') || '';
        const turnCredential = config.get<string>('turnCredential') || '';
        const turnConfig = turnUrl ? { url: turnUrl, username: turnUsername, credential: turnCredential } : undefined;

        // peerId가 'none'이거나 'default'인 경우에만 WebRTC 엔진을 최초로 시작합니다.
        if (peerId === 'none' || peerId === 'default') {
            // STUN 서버 주소를 미리 IP로 해석해 전달하여 WebView의 STUN 호스트 조회 실패(701)를 방지합니다.
            void this.resolveStunServers().then(stunServers => {
                this.sendToEngine({
                    type: 'startEngine',
                    initiator,
                    autoStart: !initiator,
                    roomName,
                    turnConfig,
                    peerId,
                    stunServers
                });
            });
        } else {
            // 이미 엔진이 실행 중인 상태에서 새로운 게스트 피어를 추가하는 경우
            if (initiator) {
                this.sendToEngine({ type: 'addNewPeer', initiator, peerId });
            }
        }
    }

    /**
     * Webview를 통해 P2P 엔진으로 메시지를 전달합니다.
     * @param msg Webview 엔진으로 보낼 메시지 객체.
     * @param to 특정 피어를 대상으로 할 경우 지정하는 피어 ID.
     * @returns {void}
     */
    public sendToEngine(msg: any, to?: string): void {
        if (!this._webview) {
            this._pendingMessageQueue.push({ msg, to });
            return;
        }
        this._webview.postMessage({ ...msg, targetPeerId: to });
    }

    /**
     * WebRTC 엔진에 정지 메시지를 전송하고 보관 중이던 SDP 정보를 모두 해제합니다.
     * @returns {void}
     */
    public dispose(): void {
        this.sendToEngine({ type: 'stopEngine' });
        this.sdpMap.clear();
    }

    /**
     * 특정 피어와의 WebRTC 연결을 해제하도록 Webview 엔진에 요청합니다.
     * @param peerId 연결을 종료할 피어 ID.
     * @returns {void}
     */
    public disconnectPeer(peerId: string): void {
        this.sendToEngine({ type: 'disconnectPeer', peerId });
    }

    /**
     * 수신된 WebRTC 시그널링 SDP/ICE Candidate를 엔진에 전달하여 적용합니다.
     * @param sdp 수신된 SDP 객체 또는 ICE Candidate 데이터.
     * @param peerId 대상 피어 ID.
     * @returns {void}
     */
    public applySignal(sdp: any, peerId: string): void {
        // 특정 피어를 위해 Webview 엔진에 시그널 전송
        this.sendToEngine({ type: 'signal', sdp, peerId }, peerId);
    }
}
