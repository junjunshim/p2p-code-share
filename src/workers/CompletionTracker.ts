/**
 * @file CompletionTracker.ts
 * @description 워커 스레드 작업의 100% 완료 여부 및 타임아웃을 감시하는 관리자 클래스
 */

import { WorkerResponse } from './workerProtocol';

/** 추적 중인 다중 스레드 작업의 상태 */
interface TrackedJob {
    taskId: string;
    targetPeers: Set<string>;
    completedPeers: Set<string>;
    results: Map<string, WorkerResponse>;
    timeoutTimer: NodeJS.Timeout;
    onCompleted: (results: Map<string, WorkerResponse>) => void;
    onTimeout: (pendingPeers: string[], results: Map<string, WorkerResponse>) => void;
}

export class CompletionTracker {
    private activeJobs = new Map<string, TrackedJob>();

    /**
     * 다중 스레드 작업을 등록하고 타임아웃 타이머를 가동합니다.
     */
    public registerJob(
        taskId: string,
        targetPeers: string[],
        timeoutMs: number,
        onCompleted: (results: Map<string, WorkerResponse>) => void,
        onTimeout: (pendingPeers: string[], results: Map<string, WorkerResponse>) => void
    ): void {
        const job: TrackedJob = {
            taskId,
            targetPeers: new Set(targetPeers),
            completedPeers: new Set<string>(),
            results: new Map<string, WorkerResponse>(),
            timeoutTimer: setTimeout(() => this.handleTimeout(taskId), timeoutMs),
            onCompleted,
            onTimeout
        };
        this.activeJobs.set(taskId, job);
    }

    /**
     * 특정 워커 스레드로부터 작업 완료 응답을 수신했을 때 호출됩니다.
     */
    public reportDone(response: WorkerResponse): void {
        const job = this.activeJobs.get(response.taskId);
        if (!job) return;

        job.completedPeers.add(response.peerId);
        job.results.set(response.peerId, response);

        // 모든 대상 스레드가 작업을 완료했는지 확인
        if (job.completedPeers.size >= job.targetPeers.size) {
            clearTimeout(job.timeoutTimer);
            this.activeJobs.delete(response.taskId);
            job.onCompleted(job.results);
        }
    }

    private handleTimeout(taskId: string): void {
        const job = this.activeJobs.get(taskId);
        if (!job) return;

        const pending = Array.from(job.targetPeers).filter(p => !job.completedPeers.has(p));
        this.activeJobs.delete(taskId);
        job.onTimeout(pending, job.results);
    }

    /**
     * 진행 중인 모든 작업을 취소하고 타이머를 해제합니다.
     */
    public clear(): void {
        this.activeJobs.forEach(job => clearTimeout(job.timeoutTimer));
        this.activeJobs.clear();
    }
}