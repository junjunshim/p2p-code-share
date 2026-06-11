/**
 * @file templates.ts
 * @description 사이드바 UI 및 P2P 엔진을 위한 HTML/JS 템플릿을 제공합니다.
 */

/**
 * 사이드바 웹뷰를 위한 HTML 템플릿을 반환합니다.
 */
export function getSidebarTemplate() {
    return `<!DOCTYPE html><html><head>
            <style>
                ${getSidebarStyles()}
            </style>
        </head>
        <body>
            ${getSidebarBody()}
            <script>
                ${getSidebarScript()}
            </script>
        </body></html>`;
}

/**
 * P2P 엔진 웹뷰를 위한 HTML 템플릿을 반환합니다.
 */
export function getEngineTemplate(initiator: boolean, autoStart: boolean = true, roomName: string = '', turnConfig?: { url: string, username?: string, credential?: string }) {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif; padding:20px; background: #1e1e1e; color: #ccc; line-height: 1.5;">
            ${getEngineBody()}
            <script src="https://cdnjs.cloudflare.com/ajax/libs/simple-peer/9.11.1/simplepeer.min.js"></script>
            <script src="https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js"></script>
            <script>
                ${getEngineScript(initiator, autoStart, roomName, turnConfig)}
            </script></body></html>`;
}

// ==========================================
// 사이드바 서브 컴포넌트 & 스타일
// ==========================================

/**
 * 사이드바 전용 CSS 스타일을 반환합니다.
 */
function getSidebarStyles(): string {
    return `
        * { box-sizing: border-box; }
        body { background-color: transparent; font-family: sans-serif; padding: 15px; color: var(--vscode-foreground); line-height: 1.4; }
        .hidden { display: none !important; }
        button { width: 100%; margin-bottom: 10px; padding: 12px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-weight: 600; font-size: 13px; transition: background 0.2s; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        .secondary-button { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-background); margin-top: 5px; opacity: 0.8; width: 100%; padding: 10px; cursor: pointer; border-radius: 4px; }
        .secondary-button:disabled { opacity: 0.4; cursor: not-allowed; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        textarea { width: 100%; height: 80px; margin-bottom: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; font-family: monospace; font-size: 11px; }
        input { width: 100%; padding: 10px; margin-bottom: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
        .badge { 
            width: 100%;
            justify-content: center;
            padding: 8px 16px; 
            border-radius: 20px; 
            font-size: 11px; 
            font-weight: 600; 
            background: rgba(30, 30, 30, 0.4); 
            color: #cccccc; 
            text-transform: uppercase; 
            margin-bottom: 20px; 
            display: inline-flex; 
            align-items: center; 
            gap: 8px; 
            border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));
            letter-spacing: 0.5px;
        }
        .online { 
            background: rgba(46, 60, 71, 0.7); 
            color: #ffffff;
        }
        .online::after {
            content: '';
            display: inline-block;
            width: 8px;
            height: 8px;
            background-color: #3fb950;
            border-radius: 50%;
            animation: pulse-green 2s infinite;
            box-shadow: 0 0 8px rgba(63, 185, 80, 0.8);
        }
        @keyframes pulse-green {
            0% {
                transform: scale(0.9);
                box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.7);
            }
            70% {
                transform: scale(1.1);
                box-shadow: 0 0 0 5px rgba(63, 185, 80, 0);
            }
            100% {
                transform: scale(0.9);
                box-shadow: 0 0 0 0 rgba(63, 185, 80, 0);
            }
        }
        .room-info { 
            margin: 10px 0 20px 0; 
            padding: 10px 12px; 
            background: var(--vscode-welcomePage-tileBackground, var(--vscode-sideBar-background)); 
            border: 1px solid var(--vscode-widget-border, var(--vscode-divider));
            border-left: 3px solid var(--vscode-charts-blue); 
            border-radius: 4px; 
        }
        .room-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
        .room-value { font-weight: bold; font-size: 18px; color: var(--vscode-foreground); margin-top: 4px; }
        .user-item { 
            padding: 8px 10px; 
            border-radius: 4px; 
            background: transparent; 
            border: 1px solid transparent; 
            margin-bottom: 3px; 
            font-size: 14px; 
            display: flex; 
            align-items: center; 
            gap: 10px; 
            transition: background 0.15s ease, border-color 0.15s ease;
        }
        .user-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
            border-color: var(--vscode-list-hoverBorder, transparent);
        }
        .user-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); display: flex; align-items: center; }
        .user-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: var(--vscode-badge-background, #3a3d41);
            color: var(--vscode-badge-foreground, #cccccc);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            font-weight: bold;
            text-transform: uppercase;
            flex-shrink: 0;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .badge-area { display: flex; justify-content: center; flex-shrink: 0; }
        .action-area { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .me-badge { background: #2ea043; color: white; padding: 2px 5px; border-radius: 3px; font-size: 8px; font-weight: bold; text-transform: uppercase; }
        .host-badge { background: var(--vscode-badge-background, #3a3d41); color: var(--vscode-badge-foreground, #cccccc); padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 600; margin-left: 6px; }
        .edit-name-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            margin-left: 6px;
            opacity: 0;
            transition: opacity 0.15s ease, color 0.15s ease;
            vertical-align: middle;
        }
        .user-item:hover .edit-name-btn {
            opacity: 1;
        }
        .edit-name-btn:hover {
            color: var(--vscode-textLink-foreground);
        }
        .user-action-btn {
            background-color: rgba(255, 255, 255, 0.08) !important;
            color: var(--vscode-foreground, #cccccc) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            padding: 4px !important;
            margin: 0 !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: 22px !important;
            height: 22px !important;
            transition: background 0.15s ease, border-color 0.15s ease;
        }
        .user-action-btn:hover {
            background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.15));
            border-color: var(--vscode-focusBorder, transparent);
        }
        .user-action-btn.kick-btn:hover {
            background: #b31d28 !important;
            color: white !important;
            border-color: transparent;
        }
        .file-item { 
            padding: 6px 10px 6px 20px; 
            cursor: pointer; 
            border-radius: 4px; 
            background: transparent; 
            border: 1px solid transparent; 
            margin-bottom: 2px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            font-size: 12px;
            transition: background 0.15s ease;
        }
        .file-item:hover { 
            background: var(--vscode-list-hoverBackground); 
        }
        .file-name-container {
            display: flex;
            align-items: center;
            gap: 6px;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-icon {
            color: var(--vscode-symbolIcon-fileForeground, #858585);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 20px;
            height: 20px;
            flex-shrink: 0;
        }
        .file-icon svg {
            width: 20px;
            height: 20px;
            display: block;
        }
        .file-assignee-badge {
            font-size: 11px;
            color: #cbcbcb;
            margin-left: 8px;
            padding: 2px 6px;
            border-radius: 2px;
            background:rgba(67,67,67,0.94);
            border: 1px solid rgba(255,255,255,0.05);
            flex-shrink: 0;
        }
        .file-assignee-badge.owner {
            color: var(--vscode-button-foreground, white);
            border-color: transparent;
            font-weight: 600;
        }
        .stop-btn { 
            width: auto !important; 
            margin: 0 0 0 8px !important; 
            background: #d73a49; 
            color: white; 
            border: none;
            padding: 4px 8px; 
            border-radius: 4px; 
            font-size: 10px; 
            cursor: pointer; 
            font-weight: 600; 
            transition: background 0.15s ease, color 0.15s ease; 
            flex-shrink: 0;
        }
        .stop-btn:hover { 
            background: #b31d28; 
            color: white; 
            border-color: transparent;
        }
        
        /* 데코레이션 목록 스타일 */
        .deco-item {
            padding: 8px 10px;
            border-radius: 4px;
            background: var(--vscode-welcomePage-tileBackground, var(--vscode-sideBar-background));
            border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.05));
            margin-bottom: 6px;
            font-size: 12px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease;
        }
        .deco-item:hover {
            background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
            border-color: var(--vscode-focusBorder, rgba(255,255,255,0.15));
        }
        .deco-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
        }
        .deco-title {
            display: flex;
            align-items: center;
            gap: 4px;
            font-weight: bold;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .deco-badge {
            font-size: 9px;
            padding: 1px 4px;
            border-radius: 3px;
            color: white;
            font-weight: normal;
        }
        .deco-badge.Typo { background-color: #d9534f; }
        .deco-badge.Grammar { background-color: #f0ad4e; }
        .deco-badge.Logical { background-color: #d9534f; }
        .deco-badge.Other { background-color: #5bc0de; }
        .deco-badge.Highlight { background-color: #5cb85c; }
        
        .deco-meta {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .deco-memo {
            font-size: 11px;
            color: var(--vscode-foreground);
            padding: 2px 4px;
            background: rgba(0,0,0,0.15);
            border-radius: 3px;
            word-break: break-all;
        }
        .deco-delete-btn {
            background: transparent !important;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 2px 4px !important;
            margin: 0 !important;
            border-radius: 3px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: auto !important;
            opacity: 0.7;
        }
        .deco-delete-btn:hover {
            color: #d73a49;
            opacity: 1;
            background: rgba(215, 58, 73, 0.1) !important;
        }
        
        
        .accordion-header {
            display: flex;
            align-items: center;
            gap: 6px;
            background: var(--vscode-sideBarSectionHeader-background, #252526);
            color: var(--vscode-sideBarSectionHeader-foreground, #cccccc);
            border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
            padding: 6px 8px;
            font-size: 11px;
            font-weight: bold;
            text-transform: uppercase;
            margin-top: 15px;
            margin-bottom: 10px;
            border-left: 1px solid transparent;
            border-right: 1px solid transparent;
            cursor: pointer;
            user-select: none;
        }
        .accordion-header .arrow-icon {
            transition: transform 0.15s ease;
        }
        .accordion-header.collapsed .arrow-icon {
            transform: rotate(-90deg);
        }
        
        .invite-btn { color: var(--vscode-charts-blue); cursor: pointer; font-size: 18px; font-weight: bold; padding: 0 5px; }
        .invite-btn:hover { opacity: 0.7; }
        #hostForm { background: var(--vscode-sideBar-background); padding: 15px; border-radius: 6px; border: 1px solid var(--vscode-divider); margin-top: 10px; }
        
        /* 승인 시스템 스타일 */
        .request-item { 
            padding: 10px 12px; 
            border-radius: 5px; 
            background: var(--vscode-welcomePage-tileBackground, var(--vscode-sideBar-background)); 
            border: 1px solid #393939;
            margin-bottom: 10px; 
            font-size: 13px; 
        }
        .request-header { 
            display: flex; 
            align-items: center; 
            gap: 6px; 
            margin-bottom: 8px; 
        }
        .request-name { 
            font-weight: 600; 
            color: var(--vscode-symbolIcon-keyForeground, var(--vscode-charts-blue)); 
        }
        .request-desc { 
            font-size: 11px; 
            color: var(--vscode-descriptionForeground); 
            background: var(--vscode-editor-background); 
            padding: 8px 10px; 
            border-left: 3px solid var(--vscode-charts-blue);
            border-radius: 0 4px 4px 0; 
            margin-bottom: 10px; 
            white-space: pre-wrap; 
            word-break: break-all; 
            line-height: 1.4;
        }
        .request-actions { 
            display: flex; 
            gap: 6px; 
        }
        .approve-btn { 
            flex: 1; 
            background: #76b381;
            color: var(--vscode-button-secondaryForeground, #c9d1d9); 
            border: none; 
            padding: 6px 12px; 
            border-radius: 3px; 
            cursor: pointer; 
            font-weight: 600; 
            font-size: 11px;
            transition: background 0.15s ease;
        }
        .approve-btn:hover {
            background: #3fb950;
        }
        .reject-btn { 
            flex: 1; 
            background: #434343;
            color: var(--vscode-button-secondaryForeground, #c9d1d9); 
            border: 1px solid var(--vscode-button-secondaryBorder, transparent); 
            padding: 6px 12px; 
            border-radius: 3px; 
            cursor: pointer; 
            font-weight: 600; 
            font-size: 11px;
            transition: background 0.15s ease;
        }
        .reject-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, #8b949e);
        }
        .request-count { 
            background: var(--vscode-badge-background, #d73a49); 
            color: var(--vscode-badge-foreground, white); 
            font-size: 9px; 
            font-weight: 700;
            padding: 1px 5px; 
            border-radius: 10px; 
            margin-left: 4px; 
            vertical-align: middle; 
        }

        /* 토글 스위치 스타일 */
        .switch { position: relative; display: inline-flex; align-items: center; width: 28px; height: 16px; margin-right: 4px; vertical-align: middle; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: var(--vscode-settings-checkboxBackground); border: 1px solid var(--vscode-settings-checkboxBorder); transition: .2s; border-radius: 16px; }
        .slider:before { position: absolute; content: ""; height: 10px; width: 10px; left: 2px; bottom: 2px; background-color: var(--vscode-settings-checkboxForeground); transition: .2s; border-radius: 50%; }
        input:checked + .slider { background-color: #28a745; border-color: #28a745; }
        input:checked + .slider:before { transform: translateX(12px); background-color: white; }
    `;
}

/**
 * 사이드바 HTML Body 전체 영역을 조합하여 반환합니다.
 */
function getSidebarBody(): string {
    return `
        ${getLoadingView()}
        <div id="mainContent" class="hidden">
            <div id="badge" class="badge">OFFLINE</div>
            ${getSetupView()}
            ${getConnAreaView()}
            ${getActiveView()}
        </div>
    `;
}

/**
 * 엔진 초기화 대기 화면 HTML을 반환합니다.
 */
function getLoadingView(): string {
    return `
        <div id="loading" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh; color: var(--vscode-descriptionForeground);">
            <div style="font-size: 24px; margin-bottom: 10px;">📡</div>
            <div style="font-size: 11px; letter-spacing: 1px; text-transform: uppercase; animation: blink 1.5s infinite;">Initializing Engine...</div>
        </div>
        <style>@keyframes blink { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }</style>
    `;
}

/**
 * 초기 설정 화면(방 개설 및 참가 버튼) HTML을 반환합니다.
 */
function getSetupView(): string {
    return `
        <div id="setup">
            <div id="roleSelection" class="hidden">
                <div id="startButtons">
                    <button id="btnHost" onclick="showHostForm()">Create Sharing Room</button>
                    <button id="btnGuest" onclick="showGuestForm()">Join Sharing Room</button>
                </div>
                <div id="hostForm" class="hidden">
                    <p class="room-label">Set Room Name (for easy P2P)</p>
                    <input type="text" id="setupRoomName" placeholder="e.g. My Project Room">
                    <button id="btnStartHost" onclick="init(true)" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">START ENGINE</button>
                    <div id="hostLoading" class="hidden" style="text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                        <span style="display: inline-block; animation: blink 1s infinite;">📡</span> Connecting to server...
                    </div>
                    <button id="btnCancelHost" onclick="goBack()" class="secondary-button">Cancel</button>
                </div>
                <div id="guestForm" class="hidden">
                    <p class="room-label">Enter Room Name (to join automatically)</p>
                    <input type="text" id="joinRoomName" placeholder="Enter Host's Room Name">
                    <p class="room-label">Purpose of Join (Description for Host)</p>
                    <textarea id="joinDescription" placeholder="Hi! I want to help with the UI debugging..."></textarea>
                    <button id="btnJoinAuto" onclick="init(false)" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">JOIN AUTOMATICALLY</button>
                    <div id="guestLoading" class="hidden" style="text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 10px;">
                        <span style="display: inline-block; animation: blink 1s infinite;">📡 Waiting for Approval </span> <span id="joiningRoomText"></span>
                    </div>
                    <button id="btnJoinManual" onclick="initManualGuest()" class="secondary-button">Manual Connection (SDP)</button>
                    <button id="btnCancelGuest" onclick="goBack()" class="secondary-button">Cancel</button>
                </div>
            </div>
        </div>
    `;
}

/**
 * 수동 연결 정보 영역 HTML을 반환합니다.
 */
function getConnAreaView(): string {
    return `
        <div id="connArea" class="hidden">
            <input type="hidden" id="activePeerId" value="">
            <p id="roleTextDisp" style="font-weight:bold; color:var(--vscode-charts-blue)"></p>
            <p>Connection ID (Share this):</p><textarea id="lsdp" readonly></textarea>
            <p>Partner's Reply (Paste here):</p><textarea id="rsdp" placeholder="Paste here..."></textarea>
            <button onclick="conn()" style="background: var(--vscode-statusBarItem-remoteBackground); color: white;">ESTABLISH CONNECTION</button>
            <button id="btnCancelInvite" onclick="goBack()" class="secondary-button">← Back</button>
        </div>
    `;
}

/**
 * 연결이 성공한 상태의 활성화 영역 HTML을 반환합니다.
 */
function getActiveView(): string {
    return `
        <div id="active" class="hidden">
            <div id="roomInfoArea">
                <div class="accordion-header">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Room Info</span>
                </div>
                <div class="room-info" style="margin: 0 0 15px 0;">
                    <div class="room-label">Room Name:</div>
                    <div id="dispRoomName" class="room-value"></div>
                </div>

                <div class="accordion-header" style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                        <span>Connected Users</span>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <span id="btnShowRequests" class="invite-btn hidden" onclick="toggleRequests()" title="Join Requests" style="display: inline-flex; align-items: center;">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;">
                                <path d="M8 16a2 2 0 0 0 1.99-2H6a2 2 0 0 0 2 2zm6-5V7.5a6.03 6.03 0 0 0-5-5.91V1a1 1 0 0 0-2 0v.59A6.03 6.03 0 0 0 2 7.5V11l-1.33 1.33A1 1 0 0 0 1 14h14a1 1 0 0 0 .67-1.67L14 11z"/>
                            </svg>
                            <span id="reqCount" class="request-count">0</span>
                        </span>
                        <span id="btnAddUser" class="invite-btn" onclick="invite()">+</span>
                    </div>
                </div>
                <div id="users" style="margin-bottom: 15px;"></div>

                <div class="accordion-header" style="margin-top: 10px;">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Active Snapshots</span>
                </div>
                <div id="files" style="margin-bottom: 15px;"></div>

                <div class="accordion-header" style="margin-top: 10px;">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Decorations (Reviews)</span>
                </div>
                <div id="decorations" style="max-height: 250px; overflow-y: auto;"></div>
            </div>
            <div id="requestsArea" class="hidden">
                <div class="accordion-header">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Join Requests</span>
                    <span onclick="toggleRequests()" style="margin-left: auto;cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-weight: bold; color: var(--vscode-textLink-foreground);">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
                        </svg>
                        Back
                    </span>
                </div>
                <div id="requestsList"></div>
            </div>
        </div>
    `;
}

/**
 * 사이드바에서 사용하는 JS 스크립트 코드를 반환합니다.
 */
function getSidebarScript(): string {
    return `
        const vscode = acquireVsCodeApi();
        let showingRequests = false;

        /**
         * 요청 창의 표시 상태를 토글합니다.
         */
        function toggleRequests() {
            showingRequests = !showingRequests;
            const ria = document.getElementById('roomInfoArea');
            const ra = document.getElementById('requestsArea');
            if (ria) ria.classList.toggle('hidden', showingRequests);
            if (ra) ra.classList.toggle('hidden', !showingRequests);
        }

        /**
         * 게스트의 참가 요청을 승인합니다.
         */
        function approve(peerId) { vscode.postMessage({ type: 'approveRequest', peerId }); }
        /**
         * 게스트의 참가 요청을 거절합니다.
         */
        function reject(peerId) { vscode.postMessage({ type: 'rejectRequest', peerId }); }

        /**
         * 방 생성 폼을 보여주고 시작 버튼을 숨깁니다.
         */
        function showHostForm() { 
            const hf = document.getElementById('hostForm');
            const sb = document.getElementById('startButtons');
            if (hf) hf.classList.remove('hidden'); 
            if (sb) sb.classList.add('hidden'); 
        }
        /**
         * DOM 요소의 표시/숨김 상태를 토글하는 헬퍼 함수입니다.
         */
        function setVisible(id, visible) {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('hidden', !visible);
        }

        /**
         * 버튼 요소의 활성/비활성 상태를 제어하는 헬퍼 함수입니다.
         */
        function setDisabled(id, disabled) {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        }

        /**
         * 요청 창의 표시 상태를 토글합니다.
         */
        function toggleRequests() {
            showingRequests = !showingRequests;
            setVisible('roomInfoArea', !showingRequests);
            setVisible('requestsArea', showingRequests);
        }

        /**
         * 게스트의 참가 요청을 승인합니다.
         */
        function approve(peerId) { vscode.postMessage({ type: 'approveRequest', peerId }); }
        /**
         * 게스트의 참가 요청을 거절합니다.
         */
        function reject(peerId) { vscode.postMessage({ type: 'rejectRequest', peerId }); }

        /**
         * 방 생성 폼을 보여주고 시작 버튼을 숨깁니다.
         */
        function showHostForm() { 
            setVisible('hostForm', true);
            setVisible('startButtons', false);
        }
        /**
         * 방 참가 폼을 보여주고 시작 버튼을 숨깁니다.
         */
        function showGuestForm() { 
            setVisible('guestForm', true);
            setVisible('startButtons', false);
        }
        /**
         * 입력 폼들과 진행 상태를 기본 상태로 되돌립니다.
         */
        function resetForms() {
            setVisible('hostForm', false);
            setVisible('guestForm', false);
            setVisible('startButtons', true);
            
            ['btnStartHost', 'btnJoinAuto', 'btnJoinManual', 'btnCancelHost', 'btnCancelGuest'].forEach(id => setDisabled(id, false));
            ['hostLoading', 'guestLoading'].forEach(id => setVisible(id, false));
        }

        /**
         * 호스트 또는 게스트로서 초기 연결을 초기화합니다.
         */
        function init(i) { 
            try {
                let rn = '';
                let desc = '';
                if(i) {
                    const rnEl = document.getElementById('setupRoomName');
                    rn = rnEl ? rnEl.value.trim() : '';
                    if (!rn) { alert('Please enter a room name first!'); return; }
                    setDisabled('btnStartHost', true);
                    setDisabled('btnCancelHost', true);
                    setVisible('hostLoading', true);
                } else {
                    const rnEl = document.getElementById('joinRoomName');
                    const descEl = document.getElementById('joinDescription');
                    rn = rnEl ? rnEl.value.trim() : '';
                    desc = descEl ? descEl.value.trim() : '';
                    if (!rn) { alert('Please enter the host room name!'); return; }
                    setDisabled('btnJoinAuto', true);
                    setDisabled('btnJoinManual', true);
                    const jrt = document.getElementById('joiningRoomText');
                    if (jrt) jrt.innerText = '"' + rn + '"';
                    setVisible('guestLoading', true);
                    vscode.postMessage({ type: 'joinRoom', roomName: rn, description: desc });
                    return; 
                }
                const apid = document.getElementById('activePeerId');
                const lsdp = document.getElementById('lsdp');
                const rsdp = document.getElementById('rsdp');
                if (apid) apid.value = i ? 'none' : 'default';
                if (lsdp) lsdp.value = ''; 
                if (rsdp) rsdp.value = '';
                vscode.postMessage({ type: 'initPeer', initiator: i, roomName: rn }); 
            } catch (e) { console.error(e); }
        }

        /**
         * 수동으로 게스트 연결을 위한 준비를 설정합니다.
         */
        function initManualGuest() {
            const apid = document.getElementById('activePeerId');
            const lsdp = document.getElementById('lsdp');
            const rsdp = document.getElementById('rsdp');
            if (apid) apid.value = 'default';
            if (lsdp) lsdp.value = ''; 
            if (rsdp) rsdp.value = '';
            vscode.postMessage({ type: 'initPeer', initiator: false, roomName: '' }); 
        }

        /**
         * 게스트를 초대하기 위해 초대 연결 정보 생성을 시작합니다.
         */
        function invite() { 
            const lsdp = document.getElementById('lsdp');
            const rsdp = document.getElementById('rsdp');
            if (lsdp) lsdp.value = 'Generating...'; 
            if (rsdp) rsdp.value = '';
            vscode.postMessage({ type: 'inviteGuest' }); 
        }

        /**
         * 제공된 SDP 값을 사용하여 상대방과 연결을 설정합니다.
         */
        function conn() { 
            const rsdp = document.getElementById('rsdp');
            const apid = document.getElementById('activePeerId');
            const sdpText = rsdp ? rsdp.value : '';
            const peerId = apid ? apid.value : '';
            if (!peerId || peerId === 'none') { alert('Error: Target Peer ID not identified.'); return; }
            try {
                const sdp = JSON.parse(sdpText);
                vscode.postMessage({ type: 'signal', sdp: sdp, peerId: peerId }); 
            } catch(e) { alert('Invalid Connection ID format!'); }
        }

        /**
         * 연결 설정 상태나 로딩 상태에서 뒤로 가기를 처리합니다.
         */
        function goBack() { 
            const b = document.getElementById('badge');
            const isInv = b && b.innerText === 'CONNECTED';
            vscode.postMessage({ type: 'cancel', isInviting: isInv }); 
        }
        /**
         * 자신의 이름을 변경 요청을 보냅니다.
         */
        function rename() { vscode.postMessage({ type: 'rename' }); }
        /**
         * 특정 피어를 세션에서 강퇴합니다.
         */
        function kick(peerId) { vscode.postMessage({ type: 'kick', peerId }); }

        /**
         * 특정 피어에 대해 파일 편집 권한을 지정합니다.
         */
        function togglePermission(peerId, name, canEdit) {
            vscode.postMessage({ 
                type: 'setPermission', 
                peerId: peerId, 
                permission: { 
                    name: name, 
                    globalCanEdit: canEdit, 
                    filePermissions: {} 
                } 
            });
        }

        window.addEventListener('message', e => {
            try {
                const m = e.data;
                
                if (m.type === 'sdpGenerated') { 
                    const lsdp = document.getElementById('lsdp');
                    const apid = document.getElementById('activePeerId');
                    if (lsdp) lsdp.value = m.sdp; 
                    if (apid) apid.value = m.peerId || 'default';
                }

                if (m.type === 'renderState' || m.type === 'renderParticipants') {
                    renderUI(m);
                }
            } catch (err) { console.error("Webview Error:", err); }
        });

        /**
         * 연결 상태 배지를 업데이트합니다.
         */
        function updateBadge(m) {
            const b = document.getElementById('badge');
            if (b) {
                if (m.isConnected) {
                    const isMeHost = m.participants && m.participants.myId === 'host';
                    b.innerText = (!isMeHost && m.connectionType === 'TURN') ? 'CONNECTED (TURN)' : 'CONNECTED';
                } else {
                    b.innerText = 'OFFLINE';
                }
                b.className = 'badge ' + (m.isConnected ? 'online' : '');
            }
        }

        /**
         * 대기 중인 참여 요청 목록을 화면에 렌더링합니다.
         */
        function renderRequests(m) {
            const btnShowRequests = document.getElementById('btnShowRequests');
            const reqCountDisp = document.getElementById('reqCount');
            const isMeHost = m.participants.myId === 'host';
            if (isMeHost && m.participants.joinRequests && m.participants.joinRequests.length > 0) {
                setVisible('btnShowRequests', true);
                if (reqCountDisp) reqCountDisp.innerText = m.participants.joinRequests.length;
                const rl = document.getElementById('requestsList');
                if (rl) {
                    rl.innerHTML = '';
                    m.participants.joinRequests.forEach(req => {
                        const item = document.createElement('div');
                        item.className = 'request-item';
                        item.innerHTML = '<div class="request-header">' +
                                            '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="color: var(--vscode-descriptionForeground);">' +
                                                '<path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm2-3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm4 11H2v-.5A2.5 2.5 0 0 1 4.5 13h7a2.5 2.5 0 0 1 2.5 2.5v.5zM3.062 15h9.876A1.5 1.5 0 0 0 11.5 14h-7a1.5 1.5 0 0 0-1.438 1z"/>' +
                                            '</svg>' +
                                            '<span class="request-name">' + req.name + '</span>' +
                                         '</div>' +
                                         '<div class="request-desc">' + (req.description || '(No description)') + '</div>' +
                                         '<div class="request-actions">' +
                                            '<button class="approve-btn" onclick="approve(\\\'' + req.peerId + '\\\')">Approve</button>' +
                                            '<button class="reject-btn" onclick="reject(\\\'' + req.peerId + '\\\')">Reject</button>' +
                                         '</div>';
                        rl.appendChild(item);
                    });
                }
            } else {
                setVisible('btnShowRequests', false);
                if (showingRequests) toggleRequests();
            }
        }

        /**
         * 접속해 있는 참여자 목록을 화면에 렌더링합니다.
         */
        function renderUsers(m) {
            const udiv = document.getElementById('users');
            if (!udiv) return;
            udiv.innerHTML = '';
            const myId = m.participants.myId;
            const isMeHost = myId === 'host';
            Object.entries(m.participants.others).forEach(([id, data]) => {
                const isMe = (id === myId || (id === 'default' && myId !== 'host'));
                const isHost = (id === 'host');
                
                const name = data.name;
                const canEdit = data.globalCanEdit;

                const initials = name ? name.substring(0, 2) : '??';
                const avatarHTML = '<div class="user-avatar">' + initials + '</div>';

                // 본인의 경우 이름 오른쪽에 연필 아이콘
                let editBtnHTML = '';
                if (isMe) {
                    editBtnHTML = '<span class="edit-name-btn" onclick="rename()" title="Rename">' +
                        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">' +
                            '<path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>' +
                        '</svg>' +
                    '</span>';
                }

                const nHTML = isMe ? '<b>' + name + '</b> &nbsp;(Me)' + editBtnHTML : name + (isHost ? ' <span class="host-badge">Host</span>' : '');
                
                // 쓰기 권한 토글 (호스트인 경우에만 게스트들을 대상으로 표시)
                let pHTML = '';
                if (isMeHost && !isMe && !isHost) {
                    pHTML = '<label class="switch" title="Toggle Write Permission"><input type="checkbox" ' + (canEdit ? 'checked' : '') + ' onchange="togglePermission(\\\'' + id + '\\\', \\\'' + name + '\\\', this.checked)"><span class="slider"></span></label>';
                }

                // 기여/손들기 버튼 및 강퇴 버튼
                let controlButtonsHTML = '';
                if (!isHost) {
                    // 게스트 및 내 화면
                    if (!isMe) {
                        if (isMeHost) {
                            controlButtonsHTML += pHTML;
                            // 손 모양 아이콘 버튼
                            controlButtonsHTML += '<button class="user-action-btn" title="Edit Permission Status" style="margin-left: 6px;">' +
                                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M14 6.5a2.5 2.5 0 0 0-5 0v3.08l-.83-.44a1.5 1.5 0 0 0-2 2.05l2.45 3.39A2.5 2.5 0 0 0 10.64 16h2.24a3 3 0 0 0 3-3V9a2.5 2.5 0 0 0-2.5-2.5zM8 4a2 2 0 1 1 4 0v2.5H8V4z"/></svg>' +
                            '</button>';
                            
                            // 강퇴 버튼 (마이너스 원형 아이콘)
                            controlButtonsHTML += '<button class="user-action-btn kick-btn" onclick="kick(\\\'' + id + '\\\')" title="Kick" style="margin-left: 6px;">' +
                                '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8z"/></svg>' +
                            '</button>';
                        }
                    }
                }

                udiv.innerHTML += '<div class="user-item">' + 
                                    avatarHTML +
                                    '<div class="user-name">' + nHTML + '</div>' + 
                                    '<div class="action-area">' + controlButtonsHTML + '</div>' + 
                                 '</div>';
            });
        }

        /**
         * 현재 상태에 맞춰 화면 레이아웃을 업데이트합니다.
         */
        function updateModeLayout(m) {
            const lsdp = document.getElementById('lsdp');
            const dispRoom = document.getElementById('dispRoomName');

            if (m.isSetupMode) {
                // 1. 설정 모드 (SDP 교환 중)
                setVisible('roleSelection', false);
                setVisible('connArea', true);
                setVisible('active', false);
                if (lsdp && m.invitingSdp) lsdp.value = m.invitingSdp;
                const isOffer = lsdp && lsdp.value && (lsdp.value.includes('offer') || lsdp.value === 'Generating...');
                const roleDisp = document.getElementById('roleTextDisp');
                if (roleDisp) roleDisp.innerText = isOffer ? 'INVITING NEW GUEST' : 'JOINING ROOM';
            } else if (m.isConnected) {
                // 2. 연결 완료 모드 (참가자 및 파일 목록)
                setVisible('roleSelection', false);
                setVisible('connArea', false);
                setVisible('active', true);
                if (dispRoom) dispRoom.innerText = m.roomName || 'Untitled Room';

                const isMeHost = m.participants.myId === 'host';
                setVisible('btnAddUser', isMeHost);

                renderRequests(m);
                renderUsers(m);
            } else if (m.participants.myId === 'host' && m.roomName && m.roomName !== 'Untitled Room') {
                // 3. 호스트 생성/연결 중 모드
                setVisible('roleSelection', true);
                setVisible('connArea', false);
                setVisible('active', false);
                setVisible('startButtons', false);
                setVisible('hostForm', true);
                setVisible('hostLoading', true);
                setDisabled('btnStartHost', true);
                setDisabled('btnCancelHost', true);
            } else if (m.roomName && m.roomName !== 'Untitled Room' && m.participants.myId !== 'host') {
                // 4. 게스트 승인 대기 모드
                setVisible('roleSelection', true);
                setVisible('connArea', false);
                setVisible('active', false);
                setVisible('startButtons', false);
                setVisible('guestForm', true);
                setVisible('guestLoading', true);
                setDisabled('btnJoinAuto', true);
                setDisabled('btnJoinManual', true);
                const jrt = document.getElementById('joiningRoomText');
                if (jrt) jrt.innerText = '"' + m.roomName + '"';
            } else {
                // 5. 초기 모드 (방 생성/참여 선택)
                setVisible('roleSelection', true);
                setVisible('connArea', false);
                setVisible('active', false);
                resetForms();
            }
        }

        /**
         * 공유 중인 파일 목록을 화면에 렌더링합니다.
         */
        function getFileIconSvg(fileName) {
            if (!fileName) {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#858585" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/></svg>';
            }
            
            let base = fileName;
            
            if (base.endsWith('.part_shared')) {
                base = base.substring(0, base.length - 12);
            } else if (base.endsWith('.shared')) {
                base = base.substring(0, base.length - 7);
            }
            
            base = base.replace(new RegExp('_[0-9]+$'), '');
            base = base.replace(new RegExp('_part_[0-9]+-[0-9]+$'), '');

            const lowerBase = base.toLowerCase();
            if (lowerBase === 'license') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm-3 3a3 3 0 0 1 5.1-2.1L12.5 8.3c.4.4.4 1 0 1.4l-.8.8a1 1 0 0 1-1.4 0L9.1 9.3 8.3 10.1A3 3 0 0 1 3 6z" fill="#cbcb41"/><path d="M9.5 7.5l1.5 1.5M10.5 6.5l1.5 1.5" stroke="#cbcb41" stroke-width="1.5"/></svg>';
            }
            if (lowerBase === '.gitignore') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 3.5C5 4.3 4.3 5 3.5 5S2 4.3 2 3.5 2.7 2 3.5 2 5 2.7 5 3.5zM14 12.5C14 13.3 13.3 14 12.5 14S11 13.3 11 12.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5zm-5.5-3.5c0-.8-.7-1.5-1.5-1.5S5.5 8.2 5.5 9s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5z" fill="#415a6b"/><path d="M3.5 5v6M12.5 11V7.5c0-1.4-1.1-2.5-2.5-2.5H7" stroke="#415a6b" stroke-width="1.5"/></svg>';
            }
            if (lowerBase === 'makefile') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#cbcb41" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#cbcb41" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="2" stroke="#cbcb41" stroke-width="1"/></svg>';
            }

            const extIdx = base.lastIndexOf('.');
            let ext = '';
            if (extIdx !== -1) {
                ext = base.substring(extIdx + 1).toLowerCase();
            }

            if (lowerBase === 'dockerfile') {
                return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 7.5h12v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4z" fill="#519aba"/><rect x="3" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="6" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="9" y="4" width="2" height="2" rx="0.5" fill="#519aba"/><rect x="6" y="1" width="2" height="2" rx="0.5" fill="#519aba"/></svg>';
            }

            switch (ext) {
                case 'ts':
                case 'tsx':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#519aba" text-anchor="middle">TS</text></svg>';
                case 'js':
                case 'jsx':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#cbcb41" text-anchor="middle">JS</text></svg>';
                case 'c':
                case 'h':
                case 'hpp':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#519aba" text-anchor="middle">C</text></svg>';
                case 'cpp':
                case 'cc':
                case 'cxx':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="9" font-weight="900" fill="#f34b7d" text-anchor="middle">C++</text></svg>';
                case 'py':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M7.5 0.5C5.8 0.5 4.5 1.8 4.5 3.5V5.5H8.5V6H3C1.9 6 1 6.9 1 8C1 9.1 1.9 10 3 10H4.5V8.5C4.5 6.8 5.8 5.5 7.5 5.5H11.5V3.5C11.5 1.8 10.2 0.5 8.5 0.5H7.5Z" fill="#3572A5"/><path d="M8.5 15.5C10.2 15.5 11.5 14.2 11.5 12.5V10.5H7.5V10H13C14.1 10 15 9.1 15 8C15 6.9 14.1 6 13 6H11.5V7.5C11.5 9.2 10.2 10.5 8.5 10.5H4.5V12.5C4.5 14.2 5.8 15.5 7.5 15.5H8.5Z" fill="#F1E05A"/></svg>';
                case 'json':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="13" font-weight="bold" fill="#cbcb41" text-anchor="middle">{}</text></svg>';
                case 'html':
                case 'htm':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M5 4L1 8L5 12M11 4L15 8L11 12" stroke="#e34c26" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                case 'css':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="15" font-family="sans-serif" font-size="14" font-weight="900" fill="#519aba" text-anchor="middle">#</text></svg>';
                case 'md':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14" font-family="sans-serif" font-size="12" font-weight="bold" fill="#519aba" text-anchor="middle">M</text></svg>';
                case 'java':
                case 'class':
                case 'jar':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 5h9v6a3 3 0 01-3 3H5a3 3 0 01-3-3V5zm9 2h1.5a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H11" stroke="#cc3e44" stroke-width="1.5"/><path d="M4 1v2M7 1v2M10 1v2" stroke="#cc3e44" stroke-width="1.2" stroke-linecap="round"/></svg>';
                case 'go':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#00acd7" text-anchor="middle">GO</text></svg>';
                case 'rs':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#dea584" text-anchor="middle">RS</text></svg>';
                case 'yaml':
                case 'yml':
                case 'xml':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="11" font-weight="900" fill="#cbcb41" text-anchor="middle">⚙</text></svg>';
                case 'sh':
                case 'bash':
                case 'zsh':
                case 'ps1':
                case 'bat':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M3 3l6 5-6 5M9 13h5" stroke="#415a6b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                case 'sql':
                case 'db':
                case 'sqlite':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 4c0-1.7 2.7-3 6-3s6 1.3 6 3v8c0 1.7-2.7 3-6 3s-6-1.3-6-3V4z" fill="#f34b7d" fill-opacity="0.1" stroke="#f34b7d" stroke-width="1.5"/><path d="M2 4c0 1.7 2.7 3 6 3s6-1.3 6-3M2 8c0 1.7 2.7 3 6 3s6-1.3 6-3" stroke="#f34b7d" stroke-width="1.5"/></svg>';
                case 'php':
                    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><text x="10" y="14.5" font-family="sans-serif" font-size="9" font-weight="900" fill="#519aba" text-anchor="middle">PHP</text></svg>';
                case 'rb':
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M4 2h8l3 4-7 8-7-8 3-4z" fill="#cc3e44" stroke="#cc3e44" stroke-width="1.5" stroke-linejoin="round"/></svg>';
                default:
                    return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#858585" stroke-width="1.5"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="8" x2="11" y2="8" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="#858585" stroke-width="1.5" stroke-linecap="round"/></svg>';
            }
        }

        /**
         * 공유 중인 파일 목록을 화면에 렌더링합니다.
         */
        function renderFiles(m) {
            const fdiv = document.getElementById('files');
            if (fdiv) {
                fdiv.innerHTML = '';
                const isFinalHost = m.participants.myId === 'host';
                m.files.forEach(f => {
                    const item = document.createElement('div'); 
                    item.className = 'file-item';
                    
                    const infoContainer = document.createElement('div');
                    infoContainer.style.display = 'flex';
                    infoContainer.style.flexDirection = 'column';
                    infoContainer.style.alignItems = 'flex-start';
                    infoContainer.style.gap = '4px';
                    infoContainer.style.flex = '1';
                    infoContainer.style.overflow = 'hidden';
                    
                    const nameContainer = document.createElement('div');
                    nameContainer.className = 'file-name-container';
                    nameContainer.style.width = '100%';
                    nameContainer.onclick = () => vscode.postMessage({ type: 'openFile', path: f.path });
                    
                    const fileIcon = document.createElement('span');
                    fileIcon.className = 'file-icon';
                    fileIcon.innerHTML = getFileIconSvg(f.name);
                    
                    const nameSpan = document.createElement('span');
                    nameSpan.style.fontSize = '13px';
                    nameSpan.innerText = f.name;
                    
                    nameContainer.appendChild(fileIcon);
                    nameContainer.appendChild(nameSpan);
                    infoContainer.appendChild(nameContainer);
                    
                    if (isFinalHost) {
                        const select = document.createElement('select');
                        select.style.marginLeft = '26px';
                        select.style.fontSize = '12px';
                        select.style.background = 'var(--vscode-dropdown-background)';
                        select.style.color = 'var(--vscode-dropdown-foreground)';
                        select.style.border = '1px solid var(--vscode-dropdown-border)';
                        select.style.borderRadius = '2px';
                        select.style.padding = '2px 4px';
                        select.style.maxWidth = '180px';
                        
                        const optDefault = document.createElement('option');
                        optDefault.value = '';
                        optDefault.innerText = 'Anyone';
                        select.appendChild(optDefault);
                        
                        Object.entries(m.participants.others).forEach(([id, data]) => {
                            const opt = document.createElement('option');
                            opt.value = id;
                            opt.innerText = id === 'host' ? data.name + ' (Host)' : data.name;
                            if (f.assigneeId === id) {
                                opt.selected = true;
                            }
                            select.appendChild(opt);
                        });
                        
                        select.onchange = (e) => {
                            vscode.postMessage({
                                type: 'assignFileOwner',
                                fileName: f.name,
                                assigneeId: e.target.value
                            });
                        };
                        select.onclick = (e) => { e.stopPropagation(); };
                        infoContainer.appendChild(select);
                        
                        item.appendChild(infoContainer);

                        const stopBtn = document.createElement('button'); 
                        stopBtn.className = 'stop-btn'; 
                        stopBtn.innerText = 'Stop';
                        stopBtn.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'stopFileSharing', fileName: f.name }); };
                        item.appendChild(stopBtn);
                    } else {
                        const assigneeSpan = document.createElement('span');
                        assigneeSpan.className = 'file-assignee-badge';
                        assigneeSpan.style.marginLeft = '26px';
                        
                        if (f.assigneeId) {
                            if (f.assigneeId === m.participants.myId) {
                                assigneeSpan.innerText = 'Me (Owner)';
                                assigneeSpan.classList.add('owner');
                            } else {
                                assigneeSpan.innerText = f.assigneeName || f.assigneeId;
                            }
                        } else {
                            assigneeSpan.innerText = 'Anyone';
                        }
                        infoContainer.appendChild(assigneeSpan);
                        item.appendChild(infoContainer);
                    }
                    fdiv.appendChild(item);
                });
            }
        }

        /**
         * 데코레이션 목록을 화면에 렌더링합니다.
         */
        function renderDecorations(m) {
            const decodiv = document.getElementById('decorations');
            if (!decodiv) return;
            decodiv.innerHTML = '';
            
            const decos = m.decorations || [];
            if (decos.length === 0) {
                return;
            }

            const myId = m.participants.myId;
            const isMeHost = myId === 'host';

            decos.forEach(d => {
                const item = document.createElement('div');
                item.className = 'deco-item';
                // 클릭 시 해당 위치로 이동
                item.onclick = () => {
                    vscode.postMessage({
                        type: 'jumpToDecoration',
                        fileName: d.fileName,
                        line: d.startLine,
                        char: d.startChar
                    });
                };

                const header = document.createElement('div');
                header.className = 'deco-header';

                const title = document.createElement('div');
                title.className = 'deco-title';

                // 배지 표시
                const typeName = d.type === 'Typo' ? '오타' :
                                 d.type === 'Grammar' ? '문법 오류' :
                                 d.type === 'Logical' ? '논리 오류' :
                                 d.type === 'Other' ? '기타' : '하이라이트';
                
                const badge = document.createElement('span');
                badge.className = 'deco-badge ' + d.type;
                badge.innerText = typeName;
                title.appendChild(badge);

                // 파일명 및 라인
                const fileSpan = document.createElement('span');
                fileSpan.innerText = d.fileName.split('_')[0] + ' (L.' + (d.startLine + 1) + ')';
                title.appendChild(fileSpan);

                header.appendChild(title);

                // 삭제 버튼 (호스트이거나 본인이 작성한 데코레이션인 경우에만 표시)
                const canDelete = isMeHost || d.creatorId === myId;
                if (canDelete) {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'deco-delete-btn';
                    deleteBtn.title = 'Delete review';
                    deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2.5 1a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1H3v9a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V4h.5a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H10a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1H2.5zm3 4a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zM8 5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7A.5.5 0 0 1 8 5zm3 .5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 1 0z"/></svg>';
                    deleteBtn.onclick = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({ type: 'deleteDecoration', id: d.id });
                    };
                    header.appendChild(deleteBtn);
                }

                item.appendChild(header);

                // 메모
                if (d.memo) {
                    const memo = document.createElement('div');
                    memo.className = 'deco-memo';
                    memo.innerText = d.memo;
                    item.appendChild(memo);
                }

                // 메타 데이터 (작성자 및 가시성)
                const meta = document.createElement('div');
                meta.className = 'deco-meta';
                
                const creator = document.createElement('span');
                creator.innerText = 'By: ' + d.creatorName;
                meta.appendChild(creator);

                const visibility = document.createElement('span');
                visibility.style.fontSize = '9px';
                visibility.style.opacity = '0.7';
                visibility.innerText = d.visibility === 'host' ? '🔒 Host Only' : '👥 Everyone';
                meta.appendChild(visibility);

                item.appendChild(meta);

                decodiv.appendChild(item);
            });
        }

        /**
         * UI의 상태 업데이트에 따른 렌더링을 일괄 수행합니다.
         */
        function renderUI(m) {
            if (m.type === 'refresh' || !m.participants) return;

            // 1. 레이아웃 상태 및 데이터를 먼저 다 채워 놓습니다.
            updateBadge(m);
            updateModeLayout(m);
            renderFiles(m);
            renderDecorations(m);

            // 2. 렌더링 준비가 완료된 후, 로딩 창을 끄고 메인 컨텐츠를 보여줍니다.
            // (동일한 렌더 프레임 내에서 한 번에 그려지므로 초기 화면 깜빡임이 사라집니다)
            setVisible('loading', false);
            setVisible('mainContent', true);
        }

        // 아코디언 헤더 접기/펼치기 이벤트 바인딩
        document.querySelectorAll('#roomInfoArea .accordion-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // 초청(+) 이나 요청 알림(종) 버튼 클릭 시 아코디언이 접히는 것을 방지
                if (e.target.closest('.invite-btn')) return;
                
                header.classList.toggle('collapsed');
                const content = header.nextElementSibling;
                if (content) {
                    content.classList.toggle('hidden');
                }
            });
        });

        vscode.postMessage({ type: 'ready' });
    `;
}

// ==========================================
// P2P 엔진 서브 컴포넌트
// ==========================================

/**
 * P2P 엔진 HTML Body 영역을 반환합니다.
 */
function getEngineBody(): string {
    return `
        <h2 style="color: #569cd6; margin-top: 0;">📡 P2P Engine</h2>
        <div style="margin-bottom: 10px;"><span style="font-weight: bold; color: #9cdcfe;">Status :</span> <span id="st" style="color:#ce9178;">Initializing...</span></div>
        <hr style="border: 0; border-top: 1px solid #444; margin: 15px 0;"><div id="log" style="font-size:12px; color:#858585; font-family: 'Courier New', monospace;"></div>
    `;
}

/**
 * P2P 엔진에서 사용하는 JS 스크립트 코드를 반환합니다.
 * @param initiator 호스트 여부
 * @param autoStart 자동 시작 여부
 * @param roomName 방 이름
 * @param turnConfig TURN 서버 설정 정보
 */
function getEngineScript(initiator: boolean, autoStart: boolean, roomName: string, turnConfig?: { url: string, username?: string, credential?: string }): string {
    const turnConfigSerialized = turnConfig && turnConfig.url ? JSON.stringify({
        urls: turnConfig.url,
        username: turnConfig.username,
        credential: turnConfig.credential
    }) : 'null';

    return `
        const vscode = acquireVsCodeApi();
        const st = document.getElementById('st');
        const logDiv = document.getElementById('log');
        const peers = {};
        const pendingSdpMap = {}; 
        const remotePeerIdMap = {};
        let peerServer = null;
        let activeSignalingConn = null;

        /**
         * 화면에 로그 메시지를 출력합니다.
         */
        function log(m) { 
            const entry = document.createElement('div');
            entry.innerText = '> ' + new Date().toLocaleTimeString() + ' - ' + m;
            logDiv.prepend(entry);
        }

        /**
         * ICE 서버 설정을 구성하여 반환합니다.
         */
        function setupIceServers() {
            const servers = [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ];
            const turnConfigVal = ${turnConfigSerialized};
            if (turnConfigVal && turnConfigVal.urls) {
                servers.push(turnConfigVal);
            }
            return servers;
        }
        const iceServers = setupIceServers();

        /**
         * PeerJS 신호(Signaling) 서버 연결을 설정합니다.
         */
        function setupPeerJS(rName) {
            /**
             * 방 이름을 PeerJS 연결에 안전한 ID 형태로 변환합니다.
             */
            const toSafeId = (n) => 'p2p_room_' + Array.from(n).map(c => c.charCodeAt(0).toString(16)).join('');
            const pjsId = ${initiator} ? toSafeId(rName) : null;
            
            log('Connecting to PeerJS signaling server...');
            peerServer = new Peer(pjsId, {
                debug: 3,
                config: { 
                    iceServers: iceServers 
                }
            });
            peerServer.on('open', (id) => {
                log('Successfully connected to PeerJS signaling server.');
                if (${initiator}) {
                    log('Created room: "' + rName + '". Waiting for guest connection...');
                    vscode.postMessage({ type: 'roomNameSuccess' });
                }
                if (!${initiator}) {
                    log('Connecting to room host for room: "' + rName + '"...');
                    const conn = peerServer.connect(toSafeId(rName));
                    handleSignalingConn(conn);
                }
            });
            peerServer.on('connection', (conn) => { 
                log('Received connection request from guest signaling client.');
                handleSignalingConn(conn); 
            });
            peerServer.on('error', (err) => {
                log('PeerJS Connection Error: ' + err.type);
                if (!${initiator} && err.type === 'peer-unavailable') {
                    log('Error: Room "' + rName + '" does not exist or the host is offline.');
                }
                if (err.type === 'server-error' || err.type === 'network') {
                    log('Error: Failed to connect to PeerJS signaling server (network/server issue).');
                }
                if (${initiator}) {
                    let errorType = 'unknown';
                    if (err.type === 'unavailable-id') errorType = 'duplicate';
                    else if (err.type === 'server-error' || err.type === 'network') errorType = 'server';
                    vscode.postMessage({ type: 'roomNameError', errorType: errorType });
                }
            });
        }

        if ("${roomName}") {
            setupPeerJS("${roomName}");
        }

        /**
         * 신호 서버와의 연결 채널을 처리합니다.
         */
        function handleSignalingConn(conn) {
            activeSignalingConn = conn;
            conn.on('open', () => { 
                log('Signaling channel established.');
                if (!${initiator}) {
                    log('Requesting SDP offer from host...');
                    conn.send({ type: 'REQ_OFFER' }); 
                }
            });
            conn.on('data', (data) => {
                if (data.type === 'REQ_OFFER') {
                    const targetId = Object.keys(peers).find(id => !peers[id].connected && peers[id].initiator);
                    if (targetId && pendingSdpMap[targetId]) {
                        log('Sending SDP offer to guest...');
                        conn.send({ type: 'SDP', sdp: pendingSdpMap[targetId], peerId: targetId });
                    } else {
                        vscode.postMessage({ type: 'requireInvite' });
                    }
                } else if (data.type === 'SDP') {
                    const targetId = ${initiator} ? data.peerId : 'default';
                    if (peers[targetId] && peers[targetId].connected) return;
                    if (!${initiator}) remotePeerIdMap['default'] = data.peerId;
                    log('Received SDP exchange signal from ' + (${initiator} ? 'guest' : 'host') + '. Applying signal...');
                    window.dispatchEvent(new MessageEvent('message', { data: { type: 'signal', sdp: data.sdp, peerId: targetId } }));
                }
            });
            conn.on('close', () => { 
                log('Signaling channel connection closed.');
                if (activeSignalingConn === conn) activeSignalingConn = null; 
            });
            conn.on('error', (err) => {
                log('Signaling channel error: ' + err.message);
            });
        }

        /**
         * WebRTC 피어 연결 및 데이터 채널을 설정합니다.
         */
        function setupWebRTCPeer(peerId, p) {
            const rawPc = p._pc;
            if (rawPc) {
                rawPc.addEventListener('icegatheringstatechange', () => {
                    log('ICE Gathering State: ' + rawPc.iceGatheringState);
                });
                rawPc.addEventListener('iceconnectionstatechange', () => {
                    log('ICE Connection State: ' + rawPc.iceConnectionState);
                    if (rawPc.iceConnectionState === 'failed') {
                        log('Direct connection failed or timed out. Checking TURN relay backup...');
                    }
                });
            }

            p.on('signal', data => { 
                const sdpStr = JSON.stringify(data);
                pendingSdpMap[peerId] = sdpStr;
                vscode.postMessage({ type: 'sdpGenerated', sdp: sdpStr, peerId }); 
                if (activeSignalingConn && activeSignalingConn.open) {
                    log('SDP generated. Sending SDP message to ' + (${initiator} ? 'guest' : 'host') + ' via signaling channel.');
                    activeSignalingConn.send({ type: 'SDP', sdp: sdpStr, peerId: remotePeerIdMap[peerId] || peerId });
                }
            });
            p.on('connect', () => { 
                log('SDP exchange success. WebRTC P2P channel connected.');
                let connType = 'Direct';
                /**
                 * 피어와의 연결 방식(TURN/직접 연결)을 감지하고 상태를 업데이트합니다.
                 */
                const updateStatus = () => {
                    const statusStr = connType === 'TURN' ? 'Connected (via TURN)' : 'Connected';
                    log('Successfully connected to peer (' + connType + ' connection established).');
                    st.innerText = statusStr; st.style.color = '#4ec9b0';
                    vscode.postMessage({ type: 'statusUpdate', value: statusStr, peerId }); 
                };

                if (p.getStats) {
                    setTimeout(() => {
                        p.getStats((err, stats) => {
                            if (!err && stats) {
                                let activePair = null;
                                stats.forEach(report => {
                                    if (report.type === 'candidate-pair' && (report.selected || report.nominated || report.state === 'succeeded')) {
                                        activePair = report;
                                    }
                                });
                                if (activePair) {
                                    if (activePair.remoteCandidateType === 'relay' || activePair.localCandidateType === 'relay') {
                                        connType = 'TURN';
                                    } else {
                                        const remoteCandId = activePair.remoteCandidateId;
                                        const localCandId = activePair.localCandidateId;
                                        const remoteCand = (stats.get && remoteCandId) ? stats.get(remoteCandId) : null;
                                        const localCand = (stats.get && localCandId) ? stats.get(localCandId) : null;
                                        
                                        if ((remoteCand && remoteCand.candidateType === 'relay') || 
                                            (localCand && localCand.candidateType === 'relay')) {
                                            connType = 'TURN';
                                        } else {
                                            stats.forEach(report => {
                                                if (report.id && (
                                                    report.id === remoteCandId || 
                                                    report.id === localCandId ||
                                                    (remoteCandId && report.id.includes(remoteCandId)) ||
                                                    (localCandId && report.id.includes(localCandId)) ||
                                                    (remoteCandId && remoteCandId.includes(report.id)) ||
                                                    (localCandId && localCandId.includes(report.id))
                                                )) {
                                                    if (report.candidateType === 'relay') {
                                                        connType = 'TURN';
                                                    }
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                            updateStatus();
                        });
                    }, 500);
                } else {
                    updateStatus();
                }
                if (activeSignalingConn) { activeSignalingConn.close(); activeSignalingConn = null; }
            });
            p.on('data', data => {
                const raw = new Uint8Array(data);
                if (raw.length !== 1 || raw[0] !== 255) {
                    vscode.postMessage({ type: 'sendData', value: new TextDecoder().decode(raw), peerId });
                }
            });
            p.on('error', err => { 
                log('P2P connection error: ' + err.message);
                delete peers[peerId];
                if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
            });
            p.on('close', () => {
                log('P2P connection closed.');
                delete peers[peerId];
                if (Object.keys(peers).length === 0) st.innerText = 'DISCONNECTED';
                vscode.postMessage({ type: 'statusUpdate', value: 'Disconnected', peerId });
            });
        }

        /**
         * 새로운 피어 연결 객체를 생성하고 관리 목록에 추가합니다.
         */
        function addPeer(peerId, isInitiator) {
            if (peers[peerId]) return;
            try {
                log('Initializing WebRTC peer connection (isInitiator: ' + isInitiator + ')...');
                const p = new SimplePeer({ 
                    initiator: isInitiator, trickle: false, 
                    config: { iceServers: iceServers } 
                });
                
                setupWebRTCPeer(peerId, p);
                peers[peerId] = p;
            } catch(e) { log('Error: ' + e.message); }
        }

        if (${autoStart}) addPeer('default', ${initiator}); 

        window.addEventListener('message', e => {
            const m = e.data;
            
            if (m.type === 'status') {
                st.innerText = m.status;
                if (m.status === 'Connected') st.style.color = '#4ec9b0';
                else if (m.status === 'Unconnected!') st.style.color = '#f44336';
                else st.style.color = '#ce9178';
                return;
            }
            
            if (m.type === 'log') { log(m.message); return; }
            
            const targetId = m.peerId || 'default';
            if (m.type === 'updatePeerId' && peers[m.oldId]) {
                peers[m.newId] = peers[m.oldId];
                pendingSdpMap[m.newId] = pendingSdpMap[m.oldId];
                delete peers[m.oldId]; delete pendingSdpMap[m.oldId];
            }
            if (m.type === 'addNewPeer') addPeer(m.peerId, m.initiator); 
            if (m.type === 'signal' && peers[targetId]) peers[targetId].signal(m.sdp); 
            if (m.type === 'peerData') {
                const data = new TextEncoder().encode(JSON.stringify(m.value));
                if (m.targetPeerId) {
                    if (peers[m.targetPeerId] && peers[m.targetPeerId].connected) peers[m.targetPeerId].send(data);
                } else {
                    Object.values(peers).forEach(p => { if (p.connected) p.send(data); });
                }
            }
        });
        setInterval(() => { Object.values(peers).forEach(p => { if (p.connected) p.send(new Uint8Array([255])); }); }, 5000);
    `;
}
