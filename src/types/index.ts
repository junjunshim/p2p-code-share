/**
 * @file index.ts
 * @description P2P 동기화를 위한 공유 인터페이스와 타입을 정의합니다.
 */

/**
 * 공유 중인 파일을 나타냅니다.
 */
export interface SharedFile {
    // 공유 파일 이름
    name: string;
    // 디스크상의 공유 파일 경로
    path: string;
    // 호스트에서의 원본 파일 경로
    source?: string;
    // [추가] 담당자 피어 ID
    assigneeId?: string;
    // [추가] 담당자 이름
    assigneeName?: string;
}

/**
 * [추가] 참가자의 권한 상태를 나타냅니다.
 */
export interface PeerPermission {
    name: string;
    globalCanEdit: boolean;
    filePermissions: { [fileName: string]: boolean };
}

/**
 * P2P 세션에서 참가자의 상태를 나타냅니다.
 */
export interface ParticipantState {
    // 현재 사용자 이름
    myName: string;
    // 참가자들의 권한 및 상태 정보
    others: { [key: string]: PeerPermission };
    // 현재 세션 방 이름
    roomName: string;
}

/**
 * P2P 네트워크를 통해 전송되는 범용 메시지를 나타냅니다.
 */
export interface P2PMessage {
    // 메시지 유형 표시자
    type: string;
    // 추가 데이터 필드
    [key: string]: any;
}
