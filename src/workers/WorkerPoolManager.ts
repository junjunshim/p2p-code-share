/**
 * @file WorkerPoolManager.ts
 * @description CPU 코어 수 기반의 고정 크기 Worker Thread Pool 관리자
 * 작업 큐(PriorityTaskQueue)와 완료 관리자(CompletionTracker)를 조정하여
 * 백그라운드 연산을 디스패치하고 결과를 메인 스레드로 수신합니다.
 */

import { Worker } from 'worker_threads';
import * as os from 'os';
import * as path from 'path';
import { PriorityTaskQueue } from './PriorityTaskQueue';
import { CompletionTracker } from './CompletionTracker';
import { WorkerTask, WorkerResponse, WorkerTaskType, TaskPriority } from './workerProtocol';

export class WorkerPoolManager {
    /** 작업 응답 대기 상한(ms). 워커가 응답 없이 멈춰도 호출측 프라미스가 영구 대기하지 않도록 한다. */
    private static readonly TASK_TIMEOUT_MS = 15000;

    /**
     * 페이로드 1MB 당 추가로 허용하는 시간(ms).
     * 대용량 패킷이 워커에서 늦게 처리되어 타임아웃으로 떨어지면 호출측이 메인 스레드에서
     * JSON.parse 로 폴백해 확장 호스트가 길게 멈추므로, 크기에 비례해 여유를 둡니다.
     */
    private static readonly TASK_TIMEOUT_PER_MB_MS = 6000;

    /** 크기 보정을 포함한 워치독 상한(ms) */
    private static readonly TASK_TIMEOUT_MAX_MS = 60000;

    private workers: Worker[] = [];
    private workerBusyMap = new Map<Worker, boolean>();
    /** 각 워커가 현재 실행 중인 작업 (크래시 시 해당 작업을 즉시 실패 처리하기 위함) */
    private workerTaskMap = new Map<Worker, WorkerTask>();
    /** error → exit 이벤트 중복 발생 시 재스폰이 두 번 일어나지 않도록 하는 가드 */
    private deadWorkers = new Set<Worker>();
    private pendingCallbacks = new Map<string, (response: WorkerResponse) => void>();
    private taskQueue = new PriorityTaskQueue();
    private tracker = new CompletionTracker();
    private isDisposed = false;
    private maxWorkers: number;
    private workerScriptPath: string;
    private extensionPath: string;

    /**
     * @param extensionPath 확장 프로그램의 루트 경로 (context.extensionPath)
     */
    constructor(extensionPath: string) {
        this.extensionPath = extensionPath;

        // 호스트 머신의 CPU 코어 수에 맞추어 2~4개의 고정 워커 풀 생성
        const cpuCount = os.cpus()?.length || 4;
        this.maxWorkers = Math.min(4, Math.max(2, cpuCount - 1));
        this.workerScriptPath = path.join(this.extensionPath, 'out', 'workers', 'jobWorker.js');

        this.initPool();
    }

    private initPool(): void {
        for (let i = 0; i < this.maxWorkers; i++) {
            this.spawnWorker(i);
        }
    }

    private spawnWorker(index: number): Worker {
        const worker = new Worker(this.workerScriptPath);
        this.workerBusyMap.set(worker, false);

        worker.on('message', (response: WorkerResponse) => {
            this.workerBusyMap.set(worker, false);
            this.workerTaskMap.delete(worker);

            // 1. 단일 작업 콜백 실행
            const callback = this.pendingCallbacks.get(response.taskId);
            if (callback) {
                this.pendingCallbacks.delete(response.taskId);
                callback(response);
            }

            // 2. 다중 완료 추적기(CompletionTracker)에 통보
            this.tracker.reportDone(response);

            // 3. 대기 큐에서 다음 작업 디스패치
            this.dispatchNext();
        });

        worker.on('error', (err) => {
            if (this.deadWorkers.has(worker)) return;
            console.error('[WorkerPool] Worker ' + index + ' error:', err);
            this.handleWorkerCrash(worker, index);
        });

        worker.on('exit', (code) => {
            // 정상 dispose 시의 종료(또는 이미 처리된 크래시)는 재스폰 대상이 아니다.
            if (this.isDisposed || code === 0 || this.deadWorkers.has(worker)) return;
            this.handleWorkerCrash(worker, index);
        });

        this.workers[index] = worker;
        return worker;
    }

    private handleWorkerCrash(deadWorker: Worker, index: number): void {
        // 'error' 직후 'exit'이 연달아 발생해도 재스폰은 1회만 수행한다.
        if (this.deadWorkers.has(deadWorker)) return;
        this.deadWorkers.add(deadWorker);
        console.warn('[WorkerPool] 워커 ' + index + '번이 비정상 종료되어 재스폰합니다.');

        const inFlight = this.workerTaskMap.get(deadWorker);
        this.workerTaskMap.delete(deadWorker);
        this.workerBusyMap.delete(deadWorker);

        try { deadWorker.terminate(); } catch (e) {}

        // 실행 중이던 작업을 즉시 실패 응답으로 반환한다.
        // 그렇지 않으면 executeTask 프라미스가 영원히 대기하여 호출측 순서 보장 체인까지 함께 멈춘다.
        if (inFlight) {
            const callback = this.pendingCallbacks.get(inFlight.taskId);
            if (callback) {
                this.pendingCallbacks.delete(inFlight.taskId);
                callback({
                    taskId: inFlight.taskId,
                    type: inFlight.type,
                    peerId: inFlight.peerId,
                    success: false,
                    result: null,
                    error: 'Worker crashed while executing task',
                    durationMs: 0
                });
            }
        }

        if (!this.isDisposed) {
            this.spawnWorker(index);
            this.dispatchNext();
        }
    }

    /** 대기 중인 작업을 유휴(Idle) 워커에 디스패치합니다. */
    private dispatchNext(): void {
        if (this.isDisposed || this.taskQueue.isEmpty()) return;

        const idleWorker = this.workers.find(w => !this.workerBusyMap.get(w));
        if (!idleWorker) return;

        const task = this.taskQueue.dequeue();
        if (!task) return;

        this.workerBusyMap.set(idleWorker, true);
        this.workerTaskMap.set(idleWorker, task);
        idleWorker.postMessage(task);
    }

    /** 작업을 큐에 추가하고 실행 완료 프로미스를 반환합니다. */
    public executeTask(type: WorkerTaskType, peerId: string, priority: TaskPriority, payload: any): Promise<WorkerResponse> {
        if (this.isDisposed) {
            return Promise.reject(new Error('WorkerPool is disposed'));
        }

        const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const task: WorkerTask = {
            taskId,
            type,
            peerId,
            priority,
            payload,
            timestamp: Date.now()
        };

        const startedAt = Date.now();
        // 대용량 문자열 페이로드는 워커에서도 파싱 시간이 길어지므로 크기에 비례해 감시 시간을 늘린다.
        const payloadLength = typeof payload === 'string' ? payload.length : 0;
        const timeoutMs = Math.min(
            WorkerPoolManager.TASK_TIMEOUT_MAX_MS,
            WorkerPoolManager.TASK_TIMEOUT_MS
                + Math.ceil(payloadLength / (1024 * 1024)) * WorkerPoolManager.TASK_TIMEOUT_PER_MB_MS
        );
        return new Promise((resolve) => {
            // 워커가 응답 없이 멈춰도 호출측이 영구 대기하지 않도록 감시 타이머를 둔다.
            const watchdog = setTimeout(() => {
                if (this.pendingCallbacks.delete(taskId)) {
                    resolve({
                        taskId,
                        type,
                        peerId,
                        success: false,
                        result: null,
                        error: 'Worker task timeout',
                        durationMs: Date.now() - startedAt
                    });
                }
            }, timeoutMs);

            this.pendingCallbacks.set(taskId, (response) => {
                clearTimeout(watchdog);
                resolve(response);
            });
            this.taskQueue.enqueue(task);
            this.dispatchNext();
        });
    }

    /** 특정 피어가 퇴장했을 때 대기 큐에서 해당 피어의 작업을 정리합니다. */
    public cancelTasksForPeer(peerId: string): void {
        this.taskQueue.cancelTasksForPeer(peerId);
    }

    /** 모든 워커 스레드와 리소스를 안전하게 종료합니다. */
    public dispose(): void {
        this.isDisposed = true;
        this.taskQueue.clear();
        this.tracker.clear();
        this.pendingCallbacks.clear();
        this.workers.forEach(w => {
            try { w.terminate(); } catch (e) {}
        });
        this.workers = [];
        this.workerBusyMap.clear();
        this.workerTaskMap.clear();
        this.deadWorkers.clear();
    }
}