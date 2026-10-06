/** 메인 스레드와 워커 스레드 간의 통신 메시지 규격(DTO) 및 우선순위 정의 */

/** 작업 우선순위. 값이 작을수록 먼저 처리된다. */
export enum TaskPriority {
    /** 실시간 타자(YJS_UPDATE), 하트비트 - 지연 허용 16ms 이하 */
    CRITICAL = 0,
    /** 커서 이동 등 고주파 갱신 - 지연 허용 50ms 이하 */
    HIGH = 1,
    /** 파일 스냅샷 등 대용량 처리 - 지연 허용 300ms 이하 */
    NORMAL = 2,
    /** 채팅(CHAT_MESSAGE), 로그 - 지연 허용 1000ms 이하 */
    LOW = 3
}

/** 워커 스레드가 처리하는 작업 종류 */
export type WorkerTaskType =
    | 'INBOUND_PARSE'
    | 'OUTBOUND_SERIALIZE'
    | 'SNAPSHOT_COMPRESS'
    | 'DIFF_COMPUTE';

/** 메인 스레드에서 워커 스레드로 전달되는 작업 단위 */
export interface WorkerTask {
    /** 작업 고유 식별자 */
    taskId: string;
    /** 작업 종류 */
    type: WorkerTaskType;
    /** 작업을 발생시킨 피어 식별자 (퇴장 시 큐 정리용) */
    peerId: string;
    /** 우선순위 */
    priority: TaskPriority;
    /** 작업별 입력 값 */
    payload: any;
    /** 큐 적재 시각(ms) */
    timestamp: number;
}

/** 워커 스레드에서 메인 스레드로 반환되는 결과 */
export interface WorkerResponse {
    /** 요청한 작업의 식별자 */
    taskId: string;
    /** 작업 종류 */
    type: WorkerTaskType;
    /** 작업을 발생시킨 피어 식별자 */
    peerId: string;
    /** 처리 성공 여부 */
    success: boolean;
    /** 처리 결과 (실패 시 null) */
    result: any;
    /** 실패 사유 */
    error?: string;
    /** 워커 내부 처리 시간(ms) */
    durationMs: number;
}