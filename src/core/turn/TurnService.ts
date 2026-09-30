/**
 * @file TurnService.ts
 * @description Cloudflare Realtime TURN 서버 연동 및 토큰 브로커 서비스.
 * 
 * - VS Code machineId 기반 HMAC-SHA256 암호화 서명 생성
 * - Role별(Host: 30분, Guest: 3분) 임시 자격 증명(Ephemeral Credential) 획득
 * - Host 토큰 메모리 캐싱 및 만료 2분 전 자동 갱신(Auto-refresh)
 * - Guest 재연결 시 토큰 강제 재발급(Force-refresh)
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as https from 'https';
import { Logger } from '../../utils/Logger';

export interface TurnServerConfig {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface TurnTokenResponse {
    iceServers: TurnServerConfig[] | TurnServerConfig;
    ttl: number;
    role: 'host' | 'guest';
    issuedAt: number;
    expiresAt: number;
}

const WORKER_ENDPOINT = 'https://p2p-turn-broker.shimdj0425.workers.dev';
const APP_SECRET = 'p2p-code-share-junjunshim-secret-variable';
const REQUEST_TIMEOUT_MS = 4000;

export class TurnService {
    private static instance?: TurnService;

    /** Host 전용 캐시된 TURN 설정 (30분 유효) */
    private cachedHostToken?: TurnTokenResponse;

    private constructor() {}

    public static get(): TurnService {
        if (!TurnService.instance) {
            TurnService.instance = new TurnService();
        }
        return TurnService.instance;
    }

    /**
     * Host용 TURN 설정을 가져옵니다.
     * 메모리에 유효한 토큰(만료 2분 이상 남음)이 있으면 Worker 호출 없이 즉시 캐시를 반환합니다.
     */
    public async getHostTurnConfig(): Promise<TurnServerConfig[] | null> {
        const now = Date.now();
        // 만료 2분(120초) 전까지는 캐시된 토큰 재사용 (Worker 호출 0회)
        if (this.cachedHostToken && now < this.cachedHostToken.expiresAt - 120000) {
            const remainingMin = Math.round((this.cachedHostToken.expiresAt - now) / 60000);
            Logger.get().info('TurnService', `Host TURN token reused from cache (expires in ${remainingMin}m, Worker calls: 0)`);
            return Array.isArray(this.cachedHostToken.iceServers) ? this.cachedHostToken.iceServers : [this.cachedHostToken.iceServers];
        }

        Logger.get().info('TurnService', `Requesting fresh 30m Host TURN token from Cloudflare Worker...`);
        const tokenResp = await this.requestTokenFromWorker('host');
        if (tokenResp) {
            this.cachedHostToken = tokenResp;
            Logger.get().info('TurnService', `Successfully issued 30m Host TURN token (cached until ${new Date(tokenResp.expiresAt).toLocaleTimeString()})`);
            return Array.isArray(tokenResp.iceServers) ? tokenResp.iceServers : [tokenResp.iceServers];
        }
        return null;
    }

    /**
     * Guest용 일회용 TURN 설정을 가져옵니다.
     * @param forceRefresh 재연결 시 기존 토큰이 만료되었을 수 있으므로 강제 재발급 여부
     */
    public async getGuestTurnConfig(forceRefresh: boolean = false): Promise<TurnServerConfig[] | null> {
        Logger.get().info('TurnService', `Requesting 3m Guest TURN token from Cloudflare Worker (forceRefresh: ${forceRefresh})...`);
        const tokenResp = await this.requestTokenFromWorker('guest');
        if (tokenResp) {
            Logger.get().info('TurnService', `Successfully issued 3m Guest TURN token (expires in 3 minutes)`);
            return Array.isArray(tokenResp.iceServers) ? tokenResp.iceServers : [tokenResp.iceServers];
        }
        return null;
    }

    /**
     * 현재 캐시된 Host 토큰을 무효화합니다 (방 종료 시 호출).
     */
    public clearCache(): void {
        this.cachedHostToken = undefined;
    }

    /**
     * VS Code 고유 machineId + 타임스탬프 + Role 기반으로 HMAC 서명을 생성하고 Worker를 호출합니다.
     */
    private requestTokenFromWorker(role: 'host' | 'guest'): Promise<TurnTokenResponse | null> {
        return new Promise((resolve) => {
            const machineId = vscode.env.machineId || 'unknown-machine-id';
            const timestamp = Date.now().toString();
            const payload = `${machineId}:${timestamp}:${role}`;

            // HMAC-SHA256 서명 생성
            const signature = crypto
                .createHmac('sha256', APP_SECRET)
                .update(payload)
                .digest('hex');

            const url = new URL(WORKER_ENDPOINT);
            const reqOptions: https.RequestOptions = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'POST',
                timeout: REQUEST_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Machine-Id': machineId,
                    'X-Timestamp': timestamp,
                    'X-Role': role,
                    'X-App-Signature': signature
                }
            };

            const req = https.request(reqOptions, (res) => {
                let responseBody = '';
                res.on('data', (chunk) => {
                    responseBody += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const parsed = JSON.parse(responseBody) as TurnTokenResponse;
                            resolve(parsed);
                        } catch (err: any) {
                            Logger.get().error('TurnService', `Failed to parse Worker response: ${err.message}`);
                            resolve(null);
                        }
                    } else {
                        Logger.get().error('TurnService', `Worker returned error HTTP ${res.statusCode}: ${responseBody}`);
                        resolve(null);
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                Logger.get().error('TurnService', `Cloudflare Worker request timed out (${REQUEST_TIMEOUT_MS}ms)`);
                resolve(null);
            });

            req.on('error', (err) => {
                Logger.get().error('TurnService', `Cloudflare Worker network request failed: ${err.message}`);
                resolve(null);
            });

            req.end();
        });
    }
}
