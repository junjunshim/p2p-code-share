/**
 * @file Logger.ts
 * @description 개발 모드(F5) 실행 시 VS Code 표준 OutputChannel에 체계적인 타임스탬프 및 순서 번호와 함께 로그를 출력하는 전용 로거입니다.
 */

import * as vscode from 'vscode';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class Logger {
    private static instance?: Logger;
    private outputChannel?: vscode.OutputChannel;
    private isDevMode: boolean = false;

    private constructor() {}

    public static initialize(context: vscode.ExtensionContext): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
            Logger.instance.isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
            
            // 개발 모드일 때만 VS Code 출력(Output) 패널에 'P2P Code Share' 채널 생성
            if (Logger.instance.isDevMode) {
                Logger.instance.outputChannel = vscode.window.createOutputChannel('P2P Code Share');
                Logger.instance.outputChannel.appendLine(`[${Logger.formatTime()}] [INFO] [System] Logger initialized in Development Mode.`);
            }
        }
        return Logger.instance;
    }

    public static get(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private static formatTime(): string {
        const d = new Date();
        const pad = (n: number, z = 2) => String(n).padStart(z, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }

    /**
     * 일반 정보 로그를 남깁니다.
     * @param category 카테고리 태그 (예: 'Host', 'Guest', 'Sync')
     * @param message 로그 메시지
     */
    public info(category: string, message: string): void {
        this.write('INFO', category, message);
    }

    /**
     * 디버그 상세 로그를 남깁니다.
     */
    public debug(category: string, message: string): void {
        this.write('DEBUG', category, message);
    }

    /**
     * 경고 로그를 남깁니다.
     */
    public warn(category: string, message: string): void {
        this.write('WARN', category, message);
    }

    /**
     * 에러 로그를 남깁니다.
     */
    public error(category: string, message: string, err?: any): void {
        const errMsg = err ? ` | Error: ${err?.stack || err?.message || err}` : '';
        this.write('ERROR', category, `${message}${errMsg}`);
    }

    /**
     * 단계적 시퀀스(방 입장, 재연결 등)가 있는 작업의 진행 상황을 단계 번호와 함께 출력합니다.
     * @param workflow 워크플로우 이름 (예: 'GuestJoin', 'HostApprove', 'Reconnect')
     * @param step 현재 단계 (예: 1, 2, 3...)
     * @param totalSteps 전체 단계 수
     * @param message 단계별 진행 상황 설명
     */
    public step(workflow: string, step: number, totalSteps: number, message: string): void {
        this.write('INFO', workflow, `[Step ${step}/${totalSteps}] ${message}`);
    }

    private write(level: LogLevel, category: string, text: string): void {
        if (!this.isDevMode || !this.outputChannel) return;
        const line = `[${Logger.formatTime()}] [${level}] [${category}] ${text}`;
        this.outputChannel.appendLine(line);
    }

    /**
     * OutputChannel 창을 사용자에게 노출합니다.
     */
    public show(): void {
        if (this.outputChannel) {
            this.outputChannel.show(true);
        }
    }
}
