/**
 * @file body.ts
 * @description P2P 엔진 HTML Body 영역을 제공합니다.
 */

export function getEngineBody(): string {
    return `
        <h2 style="color: #569cd6; margin-top: 0;">📡 P2P Engine</h2>
        <div style="margin-bottom: 10px;"><span style="font-weight: bold; color: #9cdcfe;">Status :</span> <span id="st" style="color:#ce9178;">Initializing...</span></div>
        <hr style="border: 0; border-top: 1px solid #444; margin: 15px 0;"><div id="log" style="font-size:12px; color:#858585; font-family: 'Courier New', monospace;"></div>
    `;
}
