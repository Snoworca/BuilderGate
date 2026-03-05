# BuilderGate — PRD

## 1. What It Is

원격에서 코딩 에이전트를 병렬 운용하기 위한 **웹 기반 통합 개발 환경(IDE-lite)**.
브라우저 하나로 다수의 셸 세션을 관리하고, 파일을 탐색/편집하며, 에이전트 간 명령을 중계한다.

---

## 2. Current State (Implemented)

### 2.1 Core Terminal
| 기능 | 설명 |
|------|------|
| PTY 세션 관리 | 생성, 삭제, 이름 변경, 정렬 |
| 실시간 스트리밍 | SSE(서버→클라이언트), HTTP POST(클라이언트→서버) |
| 멀티 터미널 탭 | 세션당 N개 서브 터미널, 드래그 재정렬, 우클릭 컨텍스트 메뉴 |
| 셸 선택 | PowerShell, WSL/Bash, 자동 감지 |
| xterm.js 렌더링 | 핀치 줌, 폰트 크기 저장, 리사이즈 자동 추적 |

### 2.2 File Manager (Mdir-style)
| 기능 | 설명 |
|------|------|
| 듀얼 패널 | 와이드 모드에서 좌우 2패널, 모바일에서 싱글 |
| 파일 작업 | 복사, 이동, 삭제, 디렉토리 생성 |
| 키보드 네비게이션 | 방향키, Enter, Backspace |
| 크로스탭 작업 | 탭 간 복사/이동 (pendingOp 큐) |

### 2.3 Viewer
| 기능 | 설명 |
|------|------|
| Markdown Viewer | .md/.mdx 렌더링 |
| Code Viewer | 구문 강조 코드 뷰어 |

### 2.4 Security
| 계층 | 구현 |
|------|------|
| Transport | HTTPS (TLS 1.2-1.3), 자동 자체서명 인증서 |
| Auth | 단일 비밀번호 + JWT (HS256, 30분) |
| 2FA (선택) | 이메일 OTP (6자리, SMTP) |
| File Security | 경로 탈출 방지, 차단 확장자/경로, 파일 크기 제한 |
| Crypto | AES-256-GCM (머신 기반 마스터 키, PBKDF2) |

### 2.5 UX
| 기능 | 설명 |
|------|------|
| 모바일 반응형 | 768px 브레이크포인트, 사이드바 오버레이 |
| 탭 상태 저장 | localStorage 기반 세션별 탭 레이아웃 유지 |
| CWD 추적 | 5초 폴링, 헤더에 현재 경로 표시 |
| 하트비트 | 15분 간격 JWT 자동 갱신 |

---

## 3. Roadmap (Planned)

### Phase A — Task Manager
| 항목 | 설명 |
|------|------|
| 목표 | 세션/에이전트 단위 작업 추적 및 관리 |
| 기능 | 태스크 CRUD, 상태 관리 (pending/running/done), 의존성 그래프 |
| UI | 탭 또는 사이드패널로 태스크 보드 제공 |

### Phase B — MCP Integration
| 항목 | 설명 |
|------|------|
| 목표 | MCP(Model Context Protocol) 서버 연동 |
| 기능 | MCP 서버 등록/관리, 도구 호출 UI, 결과 표시 |
| 활용 | 마크다운 뷰어 MCP, 외부 도구 MCP 등 플러그인 확장 |

### Phase C — Agent Orchestration (Core Vision)
| 항목 | 설명 |
|------|------|
| 목표 | 세션 간 에이전트 명령 중계 — 원격 병렬 코딩 |
| 기능 | 세션 A의 에이전트가 세션 B에 명령 전송, 결과 수신 |
| 아키텍처 | 세션 간 메시지 버스, 에이전트 상태 모니터링, 작업 분배 |
| 결과 | 하나의 브라우저에서 N개 코딩 에이전트를 동시 운용 |

```
┌─────────────────────────────────────────────┐
│                  Browser UI                  │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐    │
│  │Term 1│  │Term 2│  │Term 3│  │Tasks │    │
│  │Agent │──│Agent │──│Agent │  │Board │    │
│  │  A   │  │  B   │  │  C   │  │      │    │
│  └──┬───┘  └──┬───┘  └──┬───┘  └──────┘    │
│     │         │         │                    │
│     └────── Message Bus ─┘                   │
│              (inter-session)                 │
├──────────────────────────────────────────────┤
│  File Manager  │  Viewer  │  MCP Tools       │
└──────────────────────────────────────────────┘
```

---

## 4. Architecture Principles

- **셸 네이티브**: PTY 기반, 기존 CLI 도구와 100% 호환
- **실시간**: SSE 스트리밍, 저지연 입력
- **보안 우선**: HTTPS + JWT + 2FA + 파일 보안
- **확장 가능**: MCP 프로토콜로 도구/뷰어 플러그인 추가
- **에이전트 중심**: 사람이 아닌 코딩 에이전트가 주 사용자

---

## 5. Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js, Express, TypeScript, node-pty |
| Frontend | React 18, TypeScript, Vite, xterm.js |
| Communication | HTTPS, SSE, REST, JWT |
| Config | JSON5, Zod validation |
| Security | AES-256-GCM, PBKDF2, nodemailer (SMTP) |
