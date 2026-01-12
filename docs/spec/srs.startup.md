# Software Requirements Specification (SRS)
# Claude Web Shell - Startup Phase

**Version**: 1.0.0
**Date**: 2026-01-11
**Status**: Implemented (Pilot)

---

## 1. Introduction

### 1.1 Purpose
본 문서는 Claude Web Shell 프로젝트의 소프트웨어 요구사항 명세서(SRS)입니다. Claude AI가 원격 서버에서 셸 명령을 실행하고 실시간으로 모니터링할 수 있는 웹 기반 셸 인터페이스의 요구사항을 정의합니다.

### 1.2 Scope
- **제품명**: Claude Web Shell
- **목적**: Claude AI 전용 웹 기반 터미널 인터페이스
- **범위**: Startup(파일럿) 단계 - 로컬 개발 환경용

### 1.3 Definitions and Acronyms

| 용어 | 설명 |
|------|------|
| PTY | Pseudo Terminal - 가상 터미널 장치 |
| SSE | Server-Sent Events - 서버→클라이언트 단방향 실시간 통신 |
| ConPTY | Windows Console Pseudo Terminal (Windows 10 1809+) |
| winpty | Windows용 레거시 PTY 라이브러리 |
| xterm.js | 웹 기반 터미널 에뮬레이터 라이브러리 |

### 1.4 References
- [xterm.js Documentation](https://xtermjs.org/)
- [node-pty Documentation](https://github.com/microsoft/node-pty)
- [Server-Sent Events Specification](https://html.spec.whatwg.org/multipage/server-sent-events.html)

---

## 2. Overall Description

### 2.1 Product Perspective

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Port 3000)                     │
│  ┌─────────┐  ┌──────────────────────┐  ┌────────────────┐  │
│  │ Sidebar │  │    Terminal View     │  │   Status Bar   │  │
│  │(Sessions)│  │     (xterm.js)       │  │  (Connection)  │  │
│  └─────────┘  └──────────────────────┘  └────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP/SSE
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Express Server (Port 4242)                  │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │  REST API   │  │  SSE Stream  │  │  SessionManager   │   │
│  │   Routes    │  │   Handler    │  │    (node-pty)     │   │
│  └─────────────┘  └──────────────┘  └───────────────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │ PTY
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Shell Process (PowerShell / Bash)               │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Product Features Summary

| 기능 | 설명 |
|------|------|
| 다중 세션 관리 | 여러 셸 세션을 동시에 생성/관리 |
| 실시간 출력 스트리밍 | SSE를 통한 셸 출력 실시간 전송 |
| 상태 표시 | 실행 중(빨강) / 대기(초록) 상태 표시 |
| 터미널 에뮬레이션 | xterm.js 기반 풀 기능 터미널 |
| 크로스 플랫폼 | Windows(PowerShell), Linux/Mac(Bash) 지원 |

### 2.3 User Classes and Characteristics

| 사용자 유형 | 설명 |
|------------|------|
| Claude AI | 주 사용자. 셸 명령 실행 및 결과 확인 |
| 개발자 | 시스템 관리 및 디버깅 목적 |

### 2.4 Operating Environment

- **Server**: Node.js 18+
- **Client**: Modern browsers (Chrome, Firefox, Edge)
- **OS**: Windows 10+, Linux, macOS
- **Network**: Localhost (개발 환경)

### 2.5 Design and Implementation Constraints

| 제약사항 | 설명 |
|---------|------|
| 인증 없음 | Pilot 단계에서는 인증 미구현 |
| 로컬 전용 | 퍼블릭 네트워크 노출 시 보안 취약 |
| 단일 서버 | 클러스터링 미지원 |

### 2.6 Assumptions and Dependencies

- Node.js 런타임 환경 필요
- 웹 브라우저의 SSE 지원 필요
- Windows의 경우 node-pty 빌드 도구 필요

---

## 3. Functional Requirements

### 3.1 Session Management (FR-100)

#### FR-101: Create Session
- **설명**: 새로운 셸 세션을 생성한다
- **입력**: 세션 이름 (선택적)
- **출력**: 생성된 세션 정보 (id, name, status, timestamps)
- **처리**:
  1. UUID 기반 고유 ID 생성
  2. PTY 프로세스 생성 (PowerShell/Bash)
  3. 세션 메타데이터 저장
  4. 초기 상태를 'idle'로 설정

#### FR-102: List Sessions
- **설명**: 모든 활성 세션 목록을 조회한다
- **출력**: 세션 배열 (SessionDTO[])

#### FR-103: Get Session
- **설명**: 특정 세션의 상세 정보를 조회한다
- **입력**: 세션 ID
- **출력**: 세션 정보 또는 404 에러

#### FR-104: Delete Session
- **설명**: 세션을 종료하고 리소스를 정리한다
- **입력**: 세션 ID
- **처리**:
  1. PTY 프로세스 종료
  2. SSE 클라이언트 연결 해제
  3. 타이머 정리
  4. 세션 데이터 삭제

### 3.2 Shell Execution (FR-200)

#### FR-201: Send Input
- **설명**: 셸에 명령/입력을 전송한다
- **입력**: 세션 ID, 입력 데이터 (string)
- **처리**:
  1. PTY에 데이터 쓰기
  2. lastActiveAt 업데이트
- **특성**: Fire-and-forget (비동기, 응답 대기 없음)

#### FR-202: Resize Terminal
- **설명**: 터미널 크기를 조정한다
- **입력**: 세션 ID, cols (열), rows (행)
- **처리**: PTY resize 호출

#### FR-203: Output Streaming
- **설명**: 셸 출력을 실시간으로 클라이언트에 전송한다
- **처리**:
  1. PTY onData 이벤트 수신
  2. SSE 클라이언트가 있으면 즉시 전송
  3. 클라이언트가 없으면 버퍼에 저장 (최대 64KB)

### 3.3 Real-Time Communication (FR-300)

#### FR-301: SSE Connection
- **설명**: 실시간 출력 스트림 연결을 수립한다
- **입력**: 세션 ID
- **처리**:
  1. SSE 헤더 설정
  2. Nagle 알고리즘 비활성화
  3. 버퍼된 출력 전송
  4. 현재 상태 전송
  5. 클라이언트 등록

#### FR-302: Status Updates
- **설명**: 세션 상태 변경을 클라이언트에 알린다
- **이벤트**: `status`
- **페이로드**: `{ status: 'running' | 'idle' }`

#### FR-303: Error Notifications
- **설명**: 에러 발생 시 클라이언트에 알린다
- **이벤트**: `error`
- **페이로드**: `{ message: string }`

### 3.4 Status Management (FR-400)

#### FR-401: Running Status
- **설명**: 셸 출력이 발생하면 'running' 상태로 전환
- **표시**: 빨간색 인디케이터 (#EF4444)

#### FR-402: Idle Status
- **설명**: 마지막 출력 후 일정 시간(기본 200ms) 경과 시 'idle' 상태로 전환
- **표시**: 초록색 인디케이터 (#22C55E)

### 3.5 Terminal UI (FR-500)

#### FR-501: Terminal Emulation
- **설명**: 완전한 터미널 에뮬레이션 제공
- **기능**:
  - 256색 ANSI 지원
  - 커서 깜빡임
  - 스크롤백 버퍼 (10,000 라인)
  - 선택 및 복사

#### FR-502: Terminal Resize
- **설명**: 브라우저 창 크기에 따라 터미널 크기 자동 조정
- **처리**: ResizeObserver + window resize 이벤트

#### FR-503: Focus Management
- **설명**: 터미널 포커스 자동 관리
- **처리**:
  - 세션 선택 시 자동 포커스
  - 클릭 시 포커스 복구
  - Focus In/Out 시퀀스 필터링

---

## 4. External Interface Requirements

### 4.1 REST API Interface

#### 4.1.1 Sessions Endpoints

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/api/sessions` | - | `Session[]` |
| POST | `/api/sessions` | `{ name?: string }` | `Session` |
| GET | `/api/sessions/:id` | - | `Session` |
| DELETE | `/api/sessions/:id` | - | `204 No Content` |
| POST | `/api/sessions/:id/input` | `{ data: string }` | `204 No Content` |
| POST | `/api/sessions/:id/resize` | `{ cols: number, rows: number }` | `204 No Content` |
| GET | `/api/sessions/:id/stream` | - | `SSE Stream` |

#### 4.1.2 Health Check

| Method | Endpoint | Response |
|--------|----------|----------|
| GET | `/health` | `{ status: 'ok', timestamp: string }` |

### 4.2 Data Models

#### 4.2.1 Session
```typescript
interface Session {
  id: string;                          // UUID v4
  name: string;                        // 표시 이름
  status: 'running' | 'idle';          // 현재 상태
  createdAt: string;                   // ISO 8601 생성 시간
  lastActiveAt: string;                // ISO 8601 마지막 활동 시간
}
```

#### 4.2.2 SSE Events
```typescript
// Output Event
{ event: 'output', data: { data: string } }

// Status Event
{ event: 'status', data: { status: 'running' | 'idle' } }

// Error Event
{ event: 'error', data: { message: string } }
```

### 4.3 Configuration Interface

#### 4.3.1 Server Configuration (config.json5)
```json5
{
  server: {
    port: 4242                    // 서버 포트
  },
  pty: {
    termName: "xterm-256color",   // 터미널 타입
    defaultCols: 80,              // 기본 너비
    defaultRows: 24,              // 기본 높이
    useConpty: false,             // PTY 백엔드 선택
    maxBufferSize: 65536          // 출력 버퍼 크기
  },
  session: {
    idleDelayMs: 200              // Idle 전환 지연 시간
  }
}
```

---

## 5. Non-Functional Requirements

### 5.1 Performance Requirements

| 항목 | 요구사항 |
|------|---------|
| NFR-101 | 출력 스트리밍 지연: < 100ms |
| NFR-102 | 세션 생성 시간: < 500ms |
| NFR-103 | 입력 응답 시간: < 50ms |
| NFR-104 | 동시 세션 수: 최소 10개 |
| NFR-105 | 스크롤백 버퍼: 10,000 라인 |

### 5.2 Reliability Requirements

| 항목 | 요구사항 |
|------|---------|
| NFR-201 | SSE 연결 끊김 시 자동 재연결 |
| NFR-202 | PTY 프로세스 종료 시 클라이언트 알림 |
| NFR-203 | 출력 버퍼링으로 데이터 손실 방지 |

### 5.3 Usability Requirements

| 항목 | 요구사항 |
|------|---------|
| NFR-301 | 직관적인 상태 표시 (색상 코딩) |
| NFR-302 | 반응형 터미널 크기 조정 |
| NFR-303 | 키보드 입력 즉시 반영 |

### 5.4 Security Considerations

| 항목 | 현재 상태 | 비고 |
|------|----------|------|
| 인증 | 미구현 | Pilot 단계 제외 |
| 권한 관리 | 미구현 | 추후 구현 필요 |
| 입력 검증 | 최소한 | 명령어 필터링 없음 |
| CORS | 활성화 | localhost 전용 |

### 5.5 Compatibility Requirements

| 항목 | 요구사항 |
|------|---------|
| NFR-501 | Windows 10+ (PowerShell) |
| NFR-502 | Linux (Bash) |
| NFR-503 | macOS (Bash/Zsh) |
| NFR-504 | Chrome, Firefox, Edge 최신 버전 |

---

## 6. Technology Stack

### 6.1 Backend

| 기술 | 버전 | 용도 |
|------|------|------|
| Node.js | 18+ | 런타임 |
| TypeScript | 5.3+ | 언어 |
| Express.js | 4.18+ | HTTP 프레임워크 |
| node-pty | 1.0+ | PTY 관리 |
| uuid | 9.0+ | ID 생성 |
| json5 | - | 설정 파일 파싱 |
| cors | 2.8+ | CORS 미들웨어 |

### 6.2 Frontend

| 기술 | 버전 | 용도 |
|------|------|------|
| React | 19+ | UI 프레임워크 |
| TypeScript | 5.9+ | 언어 |
| Vite | 7+ | 빌드 도구 |
| xterm.js | 6.0+ | 터미널 에뮬레이터 |
| @xterm/addon-fit | - | 터미널 크기 조정 |

---

## 7. Directory Structure

```
ProjectMaster/
├── docs/
│   ├── PRD.md                    # Product Requirements Document
│   └── spec/
│       └── srs.startup.md        # This document
├── server/
│   ├── config.json5              # Server configuration
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # Entry point
│       ├── routes/
│       │   └── sessionRoutes.ts  # API routes
│       ├── services/
│       │   └── SessionManager.ts # Core session logic
│       ├── types/
│       │   └── index.ts          # Type definitions
│       └── utils/
│           ├── config.ts         # Configuration loader
│           └── sse.ts            # SSE utilities
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── App.tsx               # Main component
        ├── main.tsx              # Entry point
        ├── types/
        │   └── index.ts          # Type definitions
        ├── hooks/
        │   ├── useSession.ts     # Session state hook
        │   └── useSSE.ts         # SSE connection hook
        ├── services/
        │   └── api.ts            # API client
        ├── components/
        │   ├── Header/
        │   ├── Sidebar/
        │   ├── Terminal/
        │   └── StatusBar/
        └── styles/
            └── globals.css
```

---

## 8. Appendix

### A. PTY Backend Comparison

| 항목 | ConPTY | winpty |
|------|--------|--------|
| 도입 | Windows 10 1809 (2018) | 2011 |
| 구현 | Windows 커널 내장 | 별도 라이브러리 |
| ANSI 지원 | 완전 지원 | 부분 지원 |
| 안정성 | 버퍼링 이슈 있음 | 안정적 |
| Claude 호환성 | 문제 있음 | 양호 |
| 권장 | 일반 앱 | Claude Code 사용 시 |

### B. SSE vs WebSocket

| 항목 | SSE | WebSocket |
|------|-----|-----------|
| 방향 | 단방향 (서버→클라이언트) | 양방향 |
| 프로토콜 | HTTP | WS |
| 재연결 | 자동 | 수동 구현 필요 |
| 복잡도 | 낮음 | 높음 |
| 본 프로젝트 선택 | ✅ | - |

선택 이유: 출력 스트리밍은 단방향이고, 입력은 HTTP POST로 충분하므로 SSE가 적합

### C. Color Scheme

```css
/* Status Indicators */
--status-running: #EF4444;  /* Red */
--status-idle: #22C55E;     /* Green */

/* Terminal Theme (VS Code Dark) */
--terminal-bg: #1e1e1e;
--terminal-fg: #d4d4d4;
--terminal-cursor: #d4d4d4;
--terminal-selection: #264f78;
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-11 | Claude | Initial SRS based on implemented system |
