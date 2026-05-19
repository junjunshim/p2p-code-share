"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const sidebar_1 = require("./sidebar");
const sync_manager_1 = require("./sync-manager");
function activate(context) {
    console.log('P2P Code Share extension is now active');
    vscode.window.showInformationMessage('P2P Extension Activated!');
    const sidebarProvider = new sidebar_1.P2PCodeShareSidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('p2p-code-share-sidebar', sidebarProvider));
    const syncManager = new sync_manager_1.SyncManager(sidebarProvider);
    // syncManager가 메모리에서 해제되지 않도록 구독 리스트에 추가 (dispose 메서드 필요 시 추가)
    context.subscriptions.push({ dispose: () => { } });
    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.setViewer', () => {
        syncManager.setPermissions(0x000001);
        vscode.window.showInformationMessage('Permission set to Viewer');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('p2p-code-share.setEditor', () => {
        syncManager.setPermissions(0x000002);
        vscode.window.showInformationMessage('Permission set to Editor');
    }));
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map