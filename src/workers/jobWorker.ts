/** Node.js Worker Thread 엔트리 포인트 메인 스레드로부터 작업을 수신하여 무거운 연산(JSON 파싱, 직렬화, 바이너리 검증 등)을 독립 실행합니다. */

import { parentPort } from 'worker_threads';
import { safeParseJson, validateAndDecodeYjsUpdate, encodeInitialYjsState, computeTextDiffSummary } from './pureCalculations';
import { WorkerTask, WorkerResponse } from './workerProtocol';

if (parentPort) {
    const port = parentPort;
    port.on('message', (task: WorkerTask) => {
        const startTime = Date.now();
        let success = true;
        let result: any = null;
        let error: string | undefined = undefined;

        try {
            switch (task.type) {
                case 'INBOUND_PARSE': {
                    const parseResult = safeParseJson(task.payload);
                    if (parseResult.success) {
                        result = parseResult.data;
                        // YJS_UPDATE 패킷인 경우 바이너리 디코딩까지 워커에서 선제 수행
                        if (result && result.type === 'YJS_UPDATE' && typeof result.update === 'string') {
                            const decoded = validateAndDecodeYjsUpdate(result.update);
                            if (decoded) {
                                result.decodedBinary = decoded;
                            }
                        }
                    } else {
                        success = false;
                        error = parseResult.error;
                    }
                    break;
                }
                case 'OUTBOUND_SERIALIZE': {
                    result = JSON.stringify(task.payload);
                    break;
                }
                case 'SNAPSHOT_COMPRESS': {
                    // payload: { fileName: string, content: string }
                    const { fileName, content } = task.payload || {};
                    if (typeof content !== 'string') {
                        success = false;
                        error = 'Invalid content for SNAPSHOT_COMPRESS';
                    } else {
                        const yjsState = encodeInitialYjsState(content);
                        result = {
                            fileName,
                            content,
                            yjsState
                        };
                    }
                    break;
                }
                case 'DIFF_COMPUTE': {
                    // payload: { original: string, current: string }
                    const { original, current } = task.payload || {};
                    if (typeof original !== 'string' || typeof current !== 'string') {
                        success = false;
                        error = 'Invalid text inputs for DIFF_COMPUTE';
                    } else {
                        result = computeTextDiffSummary(original, current);
                    }
                    break;
                }
                default:
                    success = false;
                    error = 'Unknown task type: ' + (task as any).type;
                    break;
            }
        } catch (e: any) {
            success = false;
            error = e?.message || 'Worker execution error';
        }

        const response: WorkerResponse = {
            taskId: task.taskId,
            type: task.type,
            peerId: task.peerId,
            success,
            result,
            error,
            durationMs: Date.now() - startTime
        };

        // 결과 바이너리가 포함된 경우 Zero-copy Transferable 처리
        if (result && result.decodedBinary && result.decodedBinary.buffer instanceof ArrayBuffer) {
            port.postMessage(response, [result.decodedBinary.buffer]);
        } else {
            port.postMessage(response);
        }
    });
}