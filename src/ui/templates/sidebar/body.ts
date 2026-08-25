/**
 * @file body.ts
 * @description 사이드바 HTML Body 컴포넌트들을 제공합니다.
 */

export function getSidebarBody(): string {
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

function getLoadingView(): string {
    return `
        <div id="loading" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh; color: var(--vscode-descriptionForeground);">
            <div style="font-size: 24px; margin-bottom: 10px;">📡</div>
            <div style="font-size: 11px; letter-spacing: 1px; text-transform: uppercase; animation: blink 1.5s infinite;">Initializing Engine...</div>
        </div>
        <style>@keyframes blink { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }</style>
    `;
}

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

function getActiveView(): string {
    return `
        <div id="active" class="hidden">
            <div id="roomInfoArea">
                <div class="accordion-header" style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                        <span>Room Info</span>
                    </div>
                    <span id="btnLeaveRoom" class="invite-btn" onclick="leaveRoom()" title="Leave Room" style="font-size: 11px; padding: 2px 6px; background: #d9534f; color: white; border-radius: 3px; font-weight: bold; cursor: pointer; display: inline-flex; align-items: center;">Leave</span>
                </div>
                <div class="accordion-content expanded">
                    <div class="room-info" style="margin-bottom: 8px;">
                        <div class="room-label">Room Name:</div>
                        <div id="dispRoomName" class="room-value"></div>
                    </div>
                    <button id="btnOpenChat" onclick="openChat()" style="margin-bottom: 4px; position: relative; display: flex; align-items: center; justify-content: center; gap: 6px;">
                        <span>💬 Open Chat Room</span>
                        <span id="unreadChatBadge" class="unread-chat-count hidden">0</span>
                    </button>
                </div>
                <div class="accordion-header">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Room Options</span>
                </div>
                <div id="roomOptions" class="accordion-content expanded">
                    <div class="option-item">
                        <div class="option-label">Cursor Filter</div>
                        <select id="cursorFilterSelect" class="option-select" onchange="changeCursorFilter(this.value)">
                            <option value="host">Host Only</option>
                            <option value="editable">Editable Only</option>
                            <option value="all">Show All</option>
                        </select>
                    </div>
                    <div id="followMeOption" class="option-item hidden">
                        <div class="option-label">Follow Me (Live Sync)</div>
                        <label class="switch" title="Toggle Follow Me Mode">
                            <input type="checkbox" id="followMeCheck" onchange="toggleFollowMe(this.checked)">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>

                <div class="accordion-header" style="display: flex; justify-content: space-between; align-items: center;">
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
                <div id="users" class="accordion-content expanded"></div>

                <div class="accordion-header">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Active Snapshots</span>
                </div>
                <div id="files" class="accordion-content expanded"></div>

                <div class="accordion-header">
                    <svg class="arrow-icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"/></svg>
                    <span>Decorations (Reviews)</span>
                </div>
                <div id="decorations" class="accordion-content expanded"></div>
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
