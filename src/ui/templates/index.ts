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
 * 사이드바 웹뷰를 위한 HTML 템플릿을 반환합니다.
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
 * P2P 엔진 웹뷰를 위한 HTML 템플릿을 반환합니다.
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
