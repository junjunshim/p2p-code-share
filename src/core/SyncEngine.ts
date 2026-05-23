import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HubManager } from './HubManager';
import { SharedFile, ParticipantState, P2PMessage } from '../types';
import { sanitizePath, ensureDirectory } from '../utils/helpers';

export class SyncEngine {
    private isApplyingRemoteChange = false;
    public isHost = false; 
    private storagePath = '';
    private sharedFiles: SharedFile[] = [];
    private myName = '';
    private initialName = '';
    private participants: { [key: string]: string } = {};
    private lastRemoteContentMap = new Map<string, string>();
    private pollingTimer?: NodeJS.Timeout;
    public roomName = ''; 
    private isStorageInitialized = false;
    public isSetupMode = false; 
    public isConnected = false; 

    constructor(private hub: HubManager, private context: vscode.ExtensionContext, private updateUI: (state: any) => void) {
        this.setupHandlers();
        this.setupTextListeners();
    }

    public setupHandlers() {
        this.hub.onDidReceiveData = async (text) => {
            try {
                const msg = JSON.parse(text) as P2PMessage;
                switch (msg.type) {
                    case 'SET_ROLE': this.handleSetRole(msg); break;
                    case 'ON_CONNECTED': 
                        this.isConnected = true;
                        this.isSetupMode = false;
                        if (!this.isHost) this.sendMessage('GUEST_JOIN', { name: this.myName }); 
                        this.pushUIUpdate();
                        break;
                    case 'INIT_SNAPSHOT': 
                        if (!this.isStorageInitialized) this.initializeStorage();
                        await this.handleGuestInit(msg); 
                        break;
                    case 'SYNC_FULL': await this.forceUpdateEditor(msg.fileName, msg.content); break;
                    case 'GUEST_JOIN': this.handleGuestJoin(msg); break;
                    case 'GUEST_RENAME':
                        if (this.isHost) {
                            this.participants['guest'] = msg.newName;
                            this.broadcastUserList();
                        }
                        break;
                    case 'USER_LIST_UPDATE': this.handleUserListUpdate(msg); break;
                    case 'GUEST_EDIT': if (this.isHost) { await this.handleGuestEdit(msg); } break;
                    case 'REQUEST_FULL_SYNC': if (this.isHost) this.broadcastAll(); break;
                    case 'STOP_SHARING': await this.handleRemoteStop(msg.fileName); break;
                }
            } catch (e) {}
        };
    }

    public handleSetRole(msg: any) {
        this.isHost = msg.isHost;
        this.roomName = msg.roomName || 'Untitled Room';
        this.myName = this.isHost ? 'Host' : 'Guest1';
        this.initialName = this.myName;
        this.isSetupMode = true; 
        
        if (this.isHost) { 
            this.initializeStorage(); 
            this.participants['host'] = this.myName; 
        } else { 
            this.startPolling(); 
        }
        this.pushUIUpdate();
    }

    private async handleGuestInit(msg: any) {
        this.isHost = false;
        const snapshotPath = path.join(this.storagePath, msg.fileName + '.shared');
        fs.writeFileSync(snapshotPath, msg.content);
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.addSharedFile(msg.fileName, snapshotPath);
    }

    private handleUserListUpdate(msg: any) {
        this.participants = msg.users;
        if (msg.roomName) this.roomName = msg.roomName;
        
        // [수정] 게스트인 경우 방 이름을 받은 이 시점에 폴더를 생성함
        if (!this.isHost && !this.isStorageInitialized && this.roomName) {
            this.initializeStorage();
        }

        const myKey = this.isHost ? 'host' : 'guest';
        if (this.participants[myKey]) this.myName = this.participants[myKey];
        this.pushUIUpdate();
    }

    private async handleGuestEdit(msg: any) {
        const file = this.sharedFiles.find(f => f.name === msg.fileName);
        if (file) {
            await this.forceUpdateEditor(msg.fileName, msg.content, file.path);
            this.broadcastFullContent(file.name, file.path);
        }
    }

    private handleGuestJoin(msg: any) {
        if (this.isHost) {
            this.participants['guest'] = msg.name;
            this.broadcastUserList();
            this.broadcastAll();
        }
    }

    private setupTextListeners() {
        vscode.workspace.onDidChangeTextDocument(e => {
            if (this.isApplyingRemoteChange) return;
            const file = this.sharedFiles.find(f => f.path === e.document.uri.fsPath);
            if (!file) return;
            const text = e.document.getText();
            if (text === this.lastRemoteContentMap.get(file.name)) return;
            this.sendMessage(this.isHost ? 'SYNC_FULL' : 'GUEST_EDIT', { fileName: file.name, content: text });
        });
        vscode.workspace.onWillSaveTextDocument(e => {
            if (!this.isHost && this.sharedFiles.some(f => f.path === e.document.uri.fsPath)) {
                vscode.window.setStatusBarMessage("P2P: Changes synced to Host.", 3000);
            }
        });
    }

    private initializeStorage() {
        if (this.isStorageInitialized) return;
        this.storagePath = path.join(this.context.globalStorageUri.fsPath, sanitizePath(this.roomName), sanitizePath(this.initialName));
        ensureDirectory(this.storagePath);
        this.isStorageInitialized = true;
    }

    private async forceUpdateEditor(fileName: string, content: string, specificPath?: string) {
        const filePath = specificPath || this.sharedFiles.find(f => f.name === fileName)?.path;
        if (!filePath) return;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (!doc) { fs.writeFileSync(filePath, content); return; }
        if (doc.getText() === content) return;

        this.lastRemoteContentMap.set(fileName, content);
        this.isApplyingRemoteChange = true;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
        await vscode.workspace.applyEdit(edit);
        setTimeout(() => { this.isApplyingRemoteChange = false; }, 50);
    }

    public async shareActiveFile() {
        if (!this.isHost) return;
        this.initializeStorage();
        const editor = vscode.window.activeTextEditor;
        if (!editor || this.sharedFiles.find(f => f.source === editor.document.uri.fsPath)) return;
        const sourcePath = editor.document.uri.fsPath;
        const fileName = path.basename(sourcePath);
        const snapshotPath = path.join(this.storagePath, fileName + '.shared');
        fs.writeFileSync(snapshotPath, editor.document.getText());
        const doc = await vscode.workspace.openTextDocument(snapshotPath);
        await vscode.window.showTextDocument(doc);
        this.sendMessage('INIT_SNAPSHOT', { fileName, content: editor.document.getText() });
        this.addSharedFile(fileName, snapshotPath, sourcePath);
    }

    public changeMyName(newName: string) {
        if (this.isHost) { this.myName = newName; this.participants['host'] = newName; this.broadcastUserList(); }
        else this.sendMessage('GUEST_RENAME', { newName });
    }

    private broadcastUserList() {
        if (this.isHost) this.sendMessage('USER_LIST_UPDATE', { users: this.participants, roomName: this.roomName });
        this.pushUIUpdate();
    }

    private broadcastAll() { this.sharedFiles.forEach(f => this.broadcastFullContent(f.name, f.path)); }

    private broadcastFullContent(fileName: string, filePath: string) {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        const content = doc ? doc.getText() : fs.readFileSync(filePath, 'utf8');
        this.sendMessage('SYNC_FULL', { fileName, content });
    }

    private sendMessage(type: string, data: any) { this.hub.sendToEngine({ type: 'peerData', value: { type, ...data } }); }

    private addSharedFile(name: string, filePath: string, source?: string) {
        if (!this.sharedFiles.find(f => f.path === filePath)) this.sharedFiles.push({ name, path: filePath, source });
        this.pushUIUpdate();
    }

    public async stopSharing() {
        const editor = vscode.window.activeTextEditor;
        const file = this.sharedFiles.find(f => f.path === editor?.document.uri.fsPath);
        if (this.isHost && file?.source) {
            await editor!.document.save();
            fs.writeFileSync(file.source, editor!.document.getText());
            this.sendMessage('STOP_SHARING', { fileName: file.name });
            await this.handleRemoteStop(file.name);
        }
    }

    private async handleRemoteStop(fileName: string) {
        const index = this.sharedFiles.findIndex(f => f.name === fileName);
        if (index === -1) return;
        const file = this.sharedFiles[index];
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === file.path);
        if (doc) {
            if (!this.isHost) await doc.save();
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const targetTab = tabs.find(t => (t.input as any).uri?.fsPath === file.path);
            if (targetTab) await vscode.window.tabGroups.close(targetTab);
        }
        if (fs.existsSync(file.path)) try { fs.unlinkSync(file.path); } catch(e) {}
        this.sharedFiles.splice(index, 1);
        this.lastRemoteContentMap.delete(fileName);
        this.pushUIUpdate();
    }

    public stopAll() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.sharedFiles.forEach(f => this.handleRemoteStop(f.name));
    }

    public reset() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.stopAll();
        this.isHost = false;
        this.isConnected = false;
        this.roomName = '';
        this.myName = '';
        this.initialName = '';
        this.participants = {};
        this.isSetupMode = false;
        this.isStorageInitialized = false;
        this.lastRemoteContentMap.clear();
        this.pushUIUpdate();
    }

    private startPolling() {
        if (this.pollingTimer) clearInterval(this.pollingTimer);
        this.pollingTimer = setInterval(() => { if (!this.isHost && this.sharedFiles.length > 0) this.sendMessage('REQUEST_FULL_SYNC', {}); }, 5000);
    }

    public pushUIUpdate() { 
        this.updateUI({
            type: 'renderParticipants',
            myName: this.myName,
            others: this.participants,
            roomName: this.roomName,
            files: this.sharedFiles,
            isSetupMode: this.isSetupMode,
            isConnected: this.isConnected
        });
    }
}
