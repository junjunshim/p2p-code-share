/**
 * @file styles.ts
 * @description 사이드바 전용 CSS 스타일을 제공합니다.
 */

export function getSidebarStyles(): string {
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
            padding: 10px 12px; 
            background: var(--vscode-welcomePage-tileBackground, var(--vscode-sideBar-background)); 
            border: 1px solid var(--vscode-widget-border, var(--vscode-divider));
            border-left: 3px solid var(--vscode-charts-blue); 
            border-radius: 4px; 
        }
        .room-label { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
        .room-value { font-weight: bold; font-size: 18px; color: var(--vscode-foreground); margin-top: 4px; }
        .option-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 10px;
            background: var(--vscode-welcomePage-tileBackground, rgba(255, 255, 255, 0.03));
            border: 1px solid var(--vscode-widget-border, var(--vscode-divider));
            border-radius: 4px;
            margin-bottom: 6px;
        }
        .option-label {
            font-size: 12px;
            color: var(--vscode-foreground);
            font-weight: 500;
        }
        .option-select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 2px;
            padding: 3px 6px;
            outline: none;
            cursor: pointer;
            font-size: 11px;
            transition: border-color 0.15s ease;
        }
        .option-select:focus {
            border-color: var(--vscode-focusBorder);
        }
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
            margin-top: 6px;
            margin-bottom: 8px;
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
        
        .accordion-content {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease, margin-bottom 0.25s ease;
            opacity: 0;
            margin-bottom: 0;
        }
        .accordion-content.expanded {
            max-height: 1000px;
            opacity: 1;
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

        /* 안 읽은 채팅 배지 스타일 */
        .unread-chat-count {
            background-color: #ff3b30; /* 눈에 잘 띄는 빨간색 */
            color: #ffffff;            /* 흰색 텍스트 */
            font-size: 10px;
            font-weight: bold;
            border-radius: 10px;
            padding: 1px 6px;
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        }
    `;
}
