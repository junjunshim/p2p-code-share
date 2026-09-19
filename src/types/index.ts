/**
 * @file index.ts
 * @description P2P 동기화를 위한 공유 인터페이스와 타입을 정의합니다.
 */

/**
 * 공유 중인 파일에 대한 메타데이터 및 경로 정보를 나타냅니다.
 */
export interface SharedFile {
    /** 공유 파일 이름 (확장자 포함) */
    name: string;
    /** 로컬 파일 시스템 상의 임시 복사본 파일 절대 경로 */
    path: string;
    /** 호스트 작업 영역에서의 원본 소스 파일 절대 경로 */
    source?: string;
    /** 파일 전담 편집 권한이 할당된 피어의 고유 ID */
    assigneeId?: string;
    /** 파일 전담 편집 권한이 할당된 참가자의 표시 이름 */
    assigneeName?: string;
}

/**
 * P2P 세션에 참가한 개별 피어의 이름, 읽기/쓰기 권한 및 연결 상태를 나타냅니다.
 */
export interface PeerPermission {
    /** 참가자의 표시 이름 */
    name: string;
    /** 모든 공유 파일에 대한 전역 쓰기/편집 허용 여부 */
    globalCanEdit: boolean;
    /** 특정 파일별 쓰기/편집 허용 여부 매핑 (파일명 -> 편집 허용 여부) */
    filePermissions: { [fileName: string]: boolean };
    /** 피어의 실시간 연결 상태 (정상 연결 또는 재연결 대기 중) */
    connectionStatus?: 'connected' | 'reconnecting';
}

/**
 * P2P 세션에서 참가자 목록 및 방 상태 정보를 나타냅니다.
 */
export interface ParticipantState {
    /** 현재 로컬 사용자의 표시 이름 */
    myName: string;
    /** 세션에 참가한 다른 피어들의 권한 및 연결 상태 매핑 (피어 ID -> 권한 정보) */
    others: { [key: string]: PeerPermission };
    /** 현재 세션이 생성되거나 접속한 방 이름 */
    roomName: string;
}

/**
 * P2P 데이터 채널을 통해 노드 간 교환되는 범용 메시지 규격을 정의합니다.
 */
export interface P2PMessage {
    /** 메시지 유형 식별자 (예: 'FILE_CHANGE', 'CURSOR_UPDATE' 등) */
    type: string;
    /** 메시지 타입별 동적 페이로드 데이터 */
    [key: string]: any;
}

/**
 * 공유 파일 내 코드 특정 위치에 작성된 코드 리뷰/메모 데코레이션 정보를 정의합니다.
 */
export interface FileDecoration {
    /** 데코레이션 고유 식별자 ID */
    id: string;
    /** 데코레이션이 작성된 대상 파일 이름 */
    fileName: string;
    /** 시작 행 번호 (0부터 시작) */
    startLine: number;
    /** 시작 열(문자) 번호 (0부터 시작) */
    startChar: number;
    /** 종료 행 번호 (0부터 시작) */
    endLine: number;
    /** 종료 열(문자) 번호 (0부터 시작) */
    endChar: number;
    /** 데코레이션 유형 카테고리 */
    type: 'Typo' | 'Grammar' | 'Logical' | 'Other' | 'Highlight';
    /** 데코레이션 공개 범위 (호스트 전용 또는 전체 공개) */
    visibility: 'host' | 'everyone';
    /** 데코레이션을 작성한 사용자의 피어 ID */
    creatorId: string;
    /** 데코레이션을 작성한 사용자의 표시 이름 */
    creatorName: string;
    /** 메모/리뷰 상세 내용 */
    memo: string;
    /** Yjs 기반 텍스트 편집 시 위치 보존을 위한 상대적 시작 위치 객체 */
    startRel?: any;
    /** Yjs 기반 텍스트 편집 시 위치 보존을 위한 상대적 종료 위치 객체 */
    endRel?: any;
}

/**
 * 실시간 P2P 채팅 메시지 데이터 포맷을 정의합니다.
 */
export interface ChatMessage {
    /** 채팅 메시지 고유 식별자 ID */
    id: string;
    /** 메시지를 보낸 피어 ID (시스템 메시지인 경우 'system') */
    senderId: string;
    /** 메시지를 보낸 사용자의 표시 이름 */
    senderName: string;
    /** 전송된 채팅 텍스트 내용 */
    text: string;
    /** 메시지 전송 시각 (Unix Epoch Timestamp, 밀리초 단위) */
    timestamp: number;
    /** 시스템 자동 생성 메시지 여부 (입장/퇴장, 이름 변경 알림 등) */
    isSystem?: boolean;
}


