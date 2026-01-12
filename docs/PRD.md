# Claude Web Shell - Product Requirements Document

## 1. 프로젝트 개요

### 1.1 프로젝트명
**Claude Web Shell** (코드명: ProjectMaster)

### 1.2 개요
Claude AI 전용 웹 기반 쉘 인터페이스. 웹 브라우저를 통해 Claude가 서버의 쉘 명령을 실행하고, 사용자는 실시간으로 작업 상태를 모니터링할 수 있는 시스템.

### 1.3 목표
- Claude AI가 원격 서버에서 쉘 명령을 실행할 수 있는 웹 인터페이스 제공
- 다중 세션 관리 기능
- 작업 상태 실시간 시각화 (진행 중/대기 중)

---

## 2. 기술 스택

### 2.1 백엔드 (server/)
| 구성요소 | 기술 |
|---------|------|
| Runtime | Node.js |
| Language | TypeScript |
| Framework | Express.js |
| 실시간 통신 | SSE (Server-Sent Events) |
| 쉘 실행 | node-pty |

### 2.2 프론트엔드 (frontend/)
| 구성요소 | 기술 |
|---------|------|
| Framework | React 18+ |
| Language | TypeScript |
| Build Tool | Vite |
| 실시간 통신 | EventSource API (SSE) |
| 터미널 렌더링 | xterm.js |
| 스타일링 | CSS Modules / Tailwind CSS |

---

## 3. 기능 요구사항

### 3.1 세션 관리

#### 3.1.1 세션 생성
- 사용자가 새 세션 버튼을 클릭하여 새로운 쉘 세션 생성
- 세션 생성 시 고유 ID 및 기본 이름 부여 (예: "Session-1", "Session-2")
- 세션명 편집 가능

#### 3.1.2 세션 목록 표시
- 좌측 사이드바에 모든 세션 목록 표시
- 각 세션 항목에 표시되는 정보:
  - 세션 이름
  - 상태 인디케이터 (컬러 공)

#### 3.1.3 세션 상태 인디케이터
| 상태 | 색상 | 의미 |
|------|------|------|
| 🔴 빨간색 | `#EF4444` | 작업 진행 중 (명령 실행 중) |
| 🟢 초록색 | `#22C55E` | 대기 중 (명령 완료, 입력 대기) |

#### 3.1.4 세션 삭제
- 세션 삭제 시 관련 쉘 프로세스 종료
- 삭제 확인 다이얼로그 표시

### 3.2 쉘 기능

#### 3.2.1 명령 실행
- 선택된 세션에서 쉘 명령 실행
- PTY(Pseudo Terminal) 기반으로 대화형 명령 지원
- 실시간 출력 스트리밍

#### 3.2.2 터미널 UI
- xterm.js 기반 터미널 에뮬레이터
- 스크롤백 버퍼 지원
- 컬러 출력 지원 (ANSI escape codes)

### 3.3 실시간 통신
- **SSE (Server-Sent Events)**: 서버 → 클라이언트 단방향 스트리밍
- **HTTP**: 클라이언트 → 서버 요청

#### 통신 흐름
```
┌──────────┐                      ┌──────────┐
│  Client  │                      │  Server  │
└────┬─────┘                      └────┬─────┘
     │                                 │
     │  GET /api/sessions/:id/stream   │
     │ ─────────────────────────────►  │  SSE 연결
     │                                 │
     │  ◄─── event: output ──────────  │  쉘 출력 스트림
     │  ◄─── event: status ──────────  │  상태 변경
     │                                 │
     │  POST /api/sessions/:id/input   │
     │ ─────────────────────────────►  │  명령 입력
     │                                 │
```

#### SSE 이벤트 (Server → Client)
| Event | Data | 설명 |
|-------|------|------|
| `output` | `{ data: string }` | 쉘 출력 스트리밍 |
| `status` | `{ status: 'running' \| 'idle' }` | 상태 변경 |
| `error` | `{ message: string }` | 에러 알림 |

---

## 4. UI/UX 설계

### 4.1 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│                      Header                              │
├──────────────┬──────────────────────────────────────────┤
│              │                                          │
│   Session    │                                          │
│   List       │           Terminal View                  │
│              │                                          │
│ ● Session-1  │  $ ls -la                                │
│ ○ Session-2  │  total 21                                │
│              │  drwxr-xr-x 1 user 197121   0 Jan 11 ... │
│ [+ New]      │  ...                                     │
│              │                                          │
├──────────────┴──────────────────────────────────────────┤
│                      Status Bar                          │
└─────────────────────────────────────────────────────────┘
```

### 4.2 컴포넌트 구조

```
App
├── Header
│   └── Logo / Title
├── Sidebar
│   ├── SessionList
│   │   └── SessionItem (반복)
│   │       ├── StatusIndicator
│   │       └── SessionName
│   └── NewSessionButton
├── MainContent
│   └── TerminalView
│       └── XTerm
└── StatusBar
    └── ConnectionStatus
```

---

## 5. API 설계

### 5.1 REST API (Client → Server)

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/sessions` | 세션 목록 조회 |
| POST | `/api/sessions` | 새 세션 생성 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |
| PATCH | `/api/sessions/:id` | 세션 정보 수정 (이름 등) |
| POST | `/api/sessions/:id/input` | 쉘 명령 입력 |
| POST | `/api/sessions/:id/resize` | 터미널 크기 조정 |

### 5.2 SSE Endpoint (Server → Client)

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/api/sessions/:id/stream` | 세션별 SSE 스트림 연결 |

#### SSE 이벤트 형식
```
event: output
data: {"data": "$ ls -la\n"}

event: status
data: {"status": "running"}

event: error
data: {"message": "Session terminated"}
```

---

## 6. 데이터 모델

### 6.1 Session
```typescript
interface Session {
  id: string;           // UUID
  name: string;         // 세션 표시명
  status: 'running' | 'idle';  // 실행 중 / 대기 중
  createdAt: Date;      // 생성 시간
  lastActiveAt: Date;   // 마지막 활동 시간
}
```

---

## 7. 파일럿 범위 (MVP)

### 7.1 포함 기능
- [x] 세션 생성/삭제
- [x] 세션 목록 표시
- [x] 상태 인디케이터 (빨간/초록)
- [x] 기본 쉘 명령 실행
- [x] 실시간 출력 스트리밍
- [x] 단일 터미널 뷰

### 7.2 제외 기능 (향후 확장)
- [ ] 세션 이름 편집
- [ ] 다중 터미널 탭/분할
- [ ] 명령어 히스토리 저장
- [ ] 세션 영구 저장 (재시작 후 복원)
- [ ] 인증/권한 관리
- [ ] 파일 업로드/다운로드
- [ ] Claude API 직접 연동

---

## 8. 프로젝트 구조

```
ProjectMaster/
├── docs/
│   └── PRD.md              # 본 문서
├── server/
│   ├── src/
│   │   ├── index.ts        # 서버 엔트리포인트
│   │   ├── routes/         # REST API 라우트
│   │   ├── socket/         # WebSocket 핸들러
│   │   ├── services/       # 비즈니스 로직
│   │   └── types/          # TypeScript 타입
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx         # 메인 앱 컴포넌트
│   │   ├── components/     # UI 컴포넌트
│   │   ├── hooks/          # 커스텀 훅
│   │   ├── services/       # API/Socket 서비스
│   │   └── types/          # TypeScript 타입
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

---

## 9. 비기능 요구사항

### 9.1 성능
- 터미널 출력 지연: < 100ms
- 세션 생성 시간: < 500ms

### 9.2 보안 (파일럿 이후 고려)
- 로컬 환경 전용 (localhost)
- 향후: 인증, 명령어 화이트리스트, 샌드박싱

### 9.3 호환성
- 브라우저: Chrome, Firefox, Edge (최신 버전)
- Node.js: 18.x 이상

---

## 10. 마일스톤

### Phase 1: 파일럿 (현재)
- 기본 프로젝트 구조 설정
- 세션 생성/삭제 기능
- 쉘 명령 실행 및 출력
- 상태 인디케이터

### Phase 2: 기능 확장
- 세션 이름 편집
- 명령어 히스토리
- UI/UX 개선

### Phase 3: 고급 기능
- Claude API 연동
- 인증 시스템
- 파일 관리

---

## 문서 정보

| 항목 | 내용 |
|------|------|
| 버전 | 0.1.0 |
| 작성일 | 2025-01-11 |
| 상태 | Draft |
