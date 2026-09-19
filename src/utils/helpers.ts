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
 * @returns {void}
 */
export function ensureDirectory(dir: string): void {
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
    return map[ext] || 'plaintext';
}

/**
 * 두 파일 경로가 동일한 경로를 가리키는지 정규화하여 비교합니다.
 * (운영체제 구분자 및 대소문자 차이를 흡수)
 * @param p1 첫 번째 파일 경로.
 * @param p2 두 번째 파일 경로.
 * @returns 두 경로가 일치하면 true, 그렇지 않거나 하나라도 없으면 false.
 */
export function isPathEqual(p1?: string, p2?: string): boolean {
    if (!p1 || !p2) return false;
    return path.normalize(p1).toLowerCase() === path.normalize(p2).toLowerCase();
}

/**
 * 파일 경로를 표준화하고 소문자로 변환하여 일관된 식별자를 생성합니다.
 * @param p 원본 파일 경로.
 * @returns 정규화된 파일 경로 문자열.
 */
export function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
}

/**
 * 줄바꿈 문자를 LF(\n)로 통일하여 플랫폼/에디터 간 오프셋 불일치를 방지합니다.
 * @param text 원본 텍스트 문자열.
 * @returns CRLF(\r\n)가 LF(\n)로 치환된 텍스트.
 */
export function normalizeEOL(text: string): string {
    return text.replace(/\r\n/g, '\n');
}
