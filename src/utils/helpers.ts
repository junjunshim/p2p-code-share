/**
 * @file helpers.ts
 * @description 파일 경로 정리 및 디렉토리 관리를 위한 유틸리티 함수들을 제공합니다.
 */

// VS Code API
import * as vscode from 'vscode';
// Node.js 경로 및 파일 시스템 모듈
import * as path from 'path';
import * as fs from 'fs';

/**
 * 파일 시스템에서 사용하기 안전하도록 경로 문자열을 정리합니다.
 * @param name 원본 이름 또는 경로 문자열.
 * @returns 정리된 경로 문자열.
 */
export function sanitizePath(name: string): string {
    // 잘못된 문자를 밑줄로 바꿉니다
    return name.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 디렉토리가 존재하는지 확인하고, 없다면 생성합니다.
 * @param dir 디렉토리 경로.
 */
export function ensureDirectory(dir: string) {
    // 디렉토리가 존재하지 않으면 재귀적으로 생성합니다
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * 파일 확장자를 기반으로 언어 모드 문자열을 가져옵니다.
 * @param fileName 파일 이름.
 * @returns 언어 모드 문자열.
 */
export function getLanguage(fileName: string): string {
    // 파일 확장자를 언어 모드에 매핑
    const ext = path.extname(fileName).toLowerCase();
    const map: { [key: string]: string } = {
        '.ts': 'typescript',
        '.js': 'javascript',
        '.py': 'python',
        '.html': 'html',
        '.css': 'css',
        '.json': 'json'
    };
    // 언어를 반환하거나 기본값으로 일반 텍스트를 반환합니다
    return map[ext] || 'plaintext';
}
