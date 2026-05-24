# P2P Code Share Extension

이 프로젝트는 별도의 서버 없이 WebRTC를 사용하여 VS Code 인스턴스 간에 실시간으로 코드를 공유하고 편집할 수 있는 P2P 기반 협업 도구입니다.

## 🚀 주요 기능
*   **서버리스 P2P 연결**: WebRTC(SimplePeer)를 사용하여 중앙 서버를 거치지 않고 직접 연결합니다.
*   **실시간 코드 동기화**: 문서 변경 사항을 즉시 공유하며, 협업 편집이 가능합니다.
*   **사용자 관리**: 고유 Peer ID를 기반으로 참가자를 관리하며, 이름 변경 및 실시간 커서 위치 동기화 기능을 제공합니다.
*   **파일 공유 시스템**: 호스트의 파일을 게스트가 열람하고 함께 편집할 수 있는 스냅샷 기반 공유 모델을 지원합니다.

## 📂 디렉터리 구조
```text
src/
├── core/          # P2P 동기화 엔진 및 피어 관리 로직
│   ├── HubManager.ts  # Webview(엔진)와의 통신 인터페이스
│   └── SyncEngine.ts  # 실시간 편집 및 상태 동기화 핵심 엔진
├── ui/            # UI 및 뷰 프로바이더
│   ├── SidebarProvider.ts
│   └── templates.ts   # Webview 내부의 PeerJS 통신 로직 및 UI 템플릿
├── types/         # 타입 정의
└── utils/         # 헬퍼 함수
```

## 🛠 핵심 기술: 실시간 동기화 아키텍처

본 프로젝트는 VS Code 확장 프로그램 환경에서 별도의 중계 서버 없이 실시간 협업을 구현하기 위해 다음과 같은 기술 스택과 아키텍처를 채택했습니다.

### 1. P2P 통신 및 WebRTC Signaling (`SimplePeer`)
*   **WebRTC 기반 직접 연결**: `SimplePeer` 라이브러리를 사용하여 브라우저(WebView) 간 데이터를 교환합니다. ICE Candidate 설정을 통해 방화벽을 우회하며, 직접 데이터를 주고받음으로써 서버 비용 없이 통신합니다.
*   **자동 신호 처리 (Signaling)**: SDP 핸드셰이크를 통해 각 게스트를 식별하고 연결을 확립합니다. 각 연결은 고유 ID를 통해 Webview 내 `peers` 객체에서 독립적으로 관리됩니다.

### 2. VS Code WebView 엔진 및 메신저 패턴
*   **WebView 기반 Engine**: 에디터 내에서 실행되는 Webview를 독립적인 P2P 엔진으로 사용합니다. 이는 에디터의 메인 프로세스와 통신을 분리하여 성능 영향을 최소화합니다.
*   **메시지 라우팅 (`HubManager`)**: 메인 스레드(Extension Host)와 Webview(Engine) 사이의 통신 브릿지 역할을 수행합니다. `targetPeerId`를 활용하여 브로드캐스트가 아닌 특정 피어를 대상으로 하는 라우팅을 지원합니다.

### 3. 실시간 코드 동기화 (`SyncEngine`)
*   **스냅샷 기반 전송**: 현재는 파일 전체의 텍스트를 `SYNC_FULL` 및 `GUEST_EDIT` 메시지로 전송하여 동기화하는 방식(Snapshot-based Sync)을 사용하고 있습니다. 
*   **루프 방지 알고리즘**: `onDidChangeTextDocument`를 통한 로컬 입력 감지와 `WorkspaceEdit`를 통한 원격 동기화가 무한 루프를 형성하지 않도록 `isApplyingRemoteChange` 플래그와 `contentChanges`를 이용한 2단계 가드 시스템을 운영합니다.
*   **데코레이션 기반 커서 렌더링**: `createTextEditorDecorationType`을 사용하여 각 게스트의 커서와 선택 영역을 실시간으로 시각화합니다. 실시간 전송된 `cursorPos`와 `selectionRange`를 기반으로, 메시지에 포함된 고유 `userId`를 통해 각 사용자의 색상을 구분하여 매 프레임 업데이트합니다.

### 4. 독립적인 세션 및 파일 관리
*   **Dynamic Storage**: 각 게스트는 고유한 `peerId`를 할당받는 즉시, `globalStorageUri` 하위에 고유 폴더(`방이름/peerId/`)를 생성하여 인스턴스 간 파일 충돌을 방지합니다.
*   **참고 (Yjs 사용)**: 현재 프로젝트 의존성에는 `Yjs` 및 `y-protocols`가 포함되어 있으나, 현재 구현된 동기화 엔진은 커스텀 스냅샷/이벤트 기반 동기화 로직을 따르고 있습니다. 향후 대규모 병합 및 충돌 해결을 위해 `Yjs`로의 전환을 고려할 수 있습니다.


## ⚙️ 설정 방법
1. 프로젝트 루트에서 의존성을 설치합니다:
   ```bash
   npm install
   ```
2. 개발 모드(코드 변경 시 자동 빌드):
   ```bash
   npm run watch
   ```
3. 프로덕션 빌드(최종 컴파일):
   ```bash
   npm run compile
   ```
4. VS Code에서 `F5`를 눌러 Extension Development Host 창을 실행합니다.
5. 호스트 창에서 "Create Sharing Room"을 선택하고, 게스트 창에서 "Join Sharing Room"을 선택하여 연결을 진행합니다.

## 📄 License
이 프로젝트는 MIT 라이선스를 따릅니다.
