/** 우선순위(TaskPriority) 기반의 고속 작업 큐 구현체 실시간 타자(CRITICAL) 작업이 무거운 스냅샷(NORMAL) 작업보다 항상 먼저 처리되도록 보장합니다. */

import { TaskPriority, WorkerTask } from './workerProtocol';

export class PriorityTaskQueue {
    // 우선순위 레벨(0, 1, 2, 3)별 독립 FIFO 큐 배열
    private queues = new Map<TaskPriority, WorkerTask[]>([
        [TaskPriority.CRITICAL, []],
        [TaskPriority.HIGH, []],
        [TaskPriority.NORMAL, []],
        [TaskPriority.LOW, []]
    ]);

    private _size = 0;

    /** 작업을 우선순위에 맞추어 적절한 큐에 삽입합니다. */
    public enqueue(task: WorkerTask): void {
        const targetQueue = this.queues.get(task.priority) || this.queues.get(TaskPriority.NORMAL)!;
        targetQueue.push(task);
        this._size++;
    }

    /** 가장 높은 우선순위 큐(CRITICAL -> HIGH -> NORMAL -> LOW)에서 작업을 꺼냅니다. */
    public dequeue(): WorkerTask | undefined {
        if (this._size === 0) return undefined;
        for (const priority of [TaskPriority.CRITICAL, TaskPriority.HIGH, TaskPriority.NORMAL, TaskPriority.LOW]) {
            const queue = this.queues.get(priority);
            if (queue && queue.length > 0) {
                this._size--;
                return queue.shift();
            }
        }
        return undefined;
    }

    /** 큐에 대기 중인 총 작업 수 */
    public get size(): number {
        return this._size;
    }

    /** 큐가 비어있는지 여부 */
    public isEmpty(): boolean {
        return this._size === 0;
    }

    /** 특정 피어에 대해 대기 중인 모든 작업을 취소(정리)합니다 (퇴장 시 유용). */
    public cancelTasksForPeer(peerId: string): void {
        this.queues.forEach((queue, priority) => {
            const filtered = queue.filter(task => task.peerId !== peerId);
            this._size -= (queue.length - filtered.length);
            this.queues.set(priority, filtered);
        });
    }

    /** 큐 전체를 초기화합니다. */
    public clear(): void {
        this.queues.forEach(q => q.length = 0);
        this._size = 0;
    }
}