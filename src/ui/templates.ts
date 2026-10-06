/** 사이드바 Webview HTML 템플릿 로더. media/ 의 정적 HTML/CSS/JS 를 Webview URI 로 연결합니다. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** media/ 의 정적 리소스를 연결한 사이드바 Webview HTML 문서를 생성합니다. */
export function getSidebarTemplate(extensionUri: vscode.Uri, webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar', 'sidebar.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar', 'sidebar.js'));
    const engineScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'engine', 'engine.js'));
    const simplePeerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'libs', 'simplepeer.min.js'));
    const peerJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'libs', 'peerjs.min.js'));

    let bodyHtml = '';
    try {
        bodyHtml = fs.readFileSync(path.join(extensionUri.fsPath, 'media', 'sidebar', 'sidebar.html'), 'utf8');
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
