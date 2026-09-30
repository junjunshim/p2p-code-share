/**
 * @file pureCalculations.ts
 * @description VS Code API(vscode.*) 종속성이 전혀 없는 순수 연산 함수 모음
 * 메인 스레드 또는 워커 스레드 어디에서든 안전하게 실행 가능합니다.
 */

import * as Y from 'yjs';

/** 치환해야 할 최소 텍스트 범위 */
export interface SurgicalRange {
    /** 변경이 시작되는 인덱스 */
    start: number;
    /** 기존 텍스트에서 변경이 끝나는 인덱스 */
    oldEnd: number;
    /** 새 텍스트에서 변경이 끝나는 인덱스 */
    newEnd: number;
    /** 새로 치환할 텍스트 */
    replaceText: string;
}

/** 텍스트 변경 요약 결과 */
export interface TextDiffSummary {
    hasChanges: boolean;
    originalLength: number;
    currentLength: number;
    surgicalRange: SurgicalRange | null;
}

/**
 * 텍스트 변경의 최소 범위(Surgical Range)를 계산합니다.
 * @param oldText 기존 전체 텍스트
 * @param targetContent 새로운 전체 텍스트
 * @returns 시작 인덱스, 기존 끝 인덱스, 새 끝 인덱스, 치환할 텍스트
 */
export function computeSurgicalRange(oldText: string, targetContent: string): SurgicalRange | null {
    if (oldText === targetContent) return null;

    let start = 0;
    while (start < oldText.length && start < targetContent.length && oldText[start] === targetContent[start]) {
        start++;
    }

    let oldEnd = oldText.length;
    let newEnd = targetContent.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === targetContent[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }

    return {
        start,
        oldEnd,
        newEnd,
        replaceText: targetContent.slice(start, newEnd)
    };
}

/**
 * 게스트로부터 수신된 Base64 인코딩된 Yjs Update의 유효성을 검증하고 Uint8Array로 변환합니다.
 */
export function validateAndDecodeYjsUpdate(base64Update: string): Uint8Array | null {
    try {
        if (!base64Update || typeof base64Update !== 'string') return null;
        const binary = Uint8Array.from(Buffer.from(base64Update, 'base64'));
        if (binary.byteLength === 0) return null;
        return binary;
    } catch {
        return null;
    }
}

/**
 * 원시 텍스트로부터 초기 Yjs 상태 벡터를 Base64로 인코딩하여 반환합니다.
 */
export function encodeInitialYjsState(content: string): string {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('codetext');
    ytext.insert(0, content);
    const update = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();
    return Buffer.from(update).toString('base64');
}

/**
 * 수신된 원시 JSON 문자열을 안전하게 파싱하고 유효한 객체인지 검사합니다.
 */
export function safeParseJson(rawText: string): { success: boolean; data?: any; error?: string } {
    try {
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object') {
            return { success: false, error: 'Parsed result is not an object' };
        }
        return { success: true, data: parsed };
    } catch (e: any) {
        return { success: false, error: e?.message || 'JSON parse error' };
    }
}

/**
 * 두 텍스트 간의 변경점 요약 및 범위를 계산합니다.
 */
export function computeTextDiffSummary(original: string, current: string): TextDiffSummary {
    const hasChanges = original !== current;
    return {
        hasChanges,
        originalLength: original.length,
        currentLength: current.length,
        surgicalRange: hasChanges ? computeSurgicalRange(original, current) : null
    };
}