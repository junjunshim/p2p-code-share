import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function sanitizePath(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_');
}

export function ensureDirectory(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function getLanguage(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const map: { [key: string]: string } = {
        '.ts': 'typescript',
        '.js': 'javascript',
        '.py': 'python',
        '.html': 'html',
        '.css': 'css',
        '.json': 'json'
    };
    return map[ext] || 'plaintext';
}
