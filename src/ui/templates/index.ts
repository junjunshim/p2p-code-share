/**
 * @file index.ts
 * @description 사이드바 UI 및 P2P 엔진을 위한 HTML/JS 템플릿의 진입점입니다.
 */

import { getSidebarStyles } from './sidebar/styles';
import { getSidebarBody } from './sidebar/body';
import { getSidebarScript } from './sidebar/script';
import { getEngineBody } from './engine/body';
import { getEngineScript } from './engine/script';

/**
 * 사이드바 웹뷰를 렌더링하기 위한 완성된 HTML 템플릿 문자열을 생성하여 반환합니다.
 * 스타일(CSS), 본문 마크업(HTML), UI 스크립트(JS) 및 백그라운드 P2P 엔진 스크립트를 포함합니다.
 * 
 * @returns {string} 사이드바 웹뷰 HTML 문서 문자열
 */
export function getSidebarTemplate(): string {
    return `<!DOCTYPE html><html><head>
            <style>
                ${getSidebarStyles()}
            </style>
        </head>
        <body>
            ${getSidebarBody()}
            <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
            <script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
            <script>
                ${getSidebarScript()}
            </script>
            <script>
                ${getEngineScript(false, false, '')}
            </script>
        </body></html>`;
}

/**
 * P2P 엔진 전용 백그라운드 웹뷰를 위한 HTML 템플릿 문자열을 생성하여 반환합니다.
 * SimplePeer 및 PeerJS 라이브러리를 로드하고 WebRTC 시그널링/데이터 채널 통신 스크립트를 초기화합니다.
 * 
 * @param {boolean} initiator WebRTC 연결 주도자(Host) 여부
 * @param {boolean} [autoStart=true] 엔진 로드 즉시 P2P 시그널링 자동 시작 여부
 * @param {string} [roomName=''] 자동 시그널링에 사용될 공유 방 이름
 * @param {{ url: string; username?: string; credential?: string }} [turnConfig] NAT 우회를 위한 TURN 서버 설정 정보
 * @returns {string} P2P 엔진 웹뷰 HTML 문서 문자열
 */
export function getEngineTemplate(
    initiator: boolean,
    autoStart: boolean = true,
    roomName: string = '',
    turnConfig?: { url: string; username?: string; credential?: string }
): string {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:20px; background: #1e1e1e; color: #ccc; line-height: 1.5;">
            ${getEngineBody()}
            <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
            <script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
            <script>
                ${getEngineScript(initiator, autoStart, roomName, turnConfig)}
            </script></body></html>`;
}
