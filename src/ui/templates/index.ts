/**
 * @file index.ts
 * @description 사이드바 UI 및 P2P 엔진 웹뷰를 위한 HTML 템플릿 로더입니다.
 * media 디렉터리의 정적 HTML, CSS, JavaScript 리소스를 로드하고 Webview URI로 바인딩합니다.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 사이드바 웹뷰를 렌더링하기 위한 완성된 HTML 템플릿 문자열을 생성하여 반환합니다.
 * media 디렉터리의 정적 CSS, HTML, JS 파일(사이드바 UI 및 P2P 엔진)을 연결합니다.
 * 
 * @param extensionUri 확장 프로그램 루트 URI
 * @param webview VS Code Webview 인스턴스
 * @returns {string} 사이드바 웹뷰 HTML 문서 문자열
 */
export function getSidebarTemplate(extensionUri: vscode.Uri, webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar', 'sidebar.js'));
    const engineScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'engine', 'engine.js'));
    const simplePeerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'libs', 'simplepeer.min.js'));
    const peerJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'libs', 'peerjs.min.js'));

    const htmlPath = path.join(extensionUri.fsPath, 'media', 'sidebar', 'sidebar.html');
    let bodyHtml = '';
    try {
        bodyHtml = fs.readFileSync(htmlPath, 'utf8');
    } catch (e) {
        bodyHtml = `<div>Error loading sidebar template: ${e}</div>`;
    }

    return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval'; connect-src * wss: ws: https: http:; img-src ${webview.cspSource} data: https:;">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    ${bodyHtml}
    <script src="${simplePeerUri}"></script>
    <script src="${peerJsUri}"></script>
    <script src="${scriptUri}"></script>
    <script src="${engineScriptUri}"></script>
</body>
</html>`;
}
