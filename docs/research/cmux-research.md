# CMUX 기술 조사 보고서

> 조사일: 2026-03-25
> 목적: 프로젝트 피벗을 위한 CMUX 생태계 분석

---

## 1. CMUX 개요

CMUX는 **AI 코딩 에이전트 병렬 운용에 최적화된 네이티브 터미널 애플리케이션**이다. 2026년 2월 출시되었으며, 다수의 코딩 에이전트(Claude Code, Codex, Gemini CLI, Aider 등)를 동시에 실행하면서 시각적으로 관리할 수 있는 환경을 제공한다.

### 핵심 가치

- **멀티 에이전트 오케스트레이션**: 하나의 터미널에서 N개의 AI 코딩 에이전트를 동시 실행
- **시각적 알림 시스템**: 에이전트가 주의를 필요로 할 때 블루 링, 배지, 데스크톱 알림으로 표시
- **내장 브라우저**: 스크립터블 API로 에이전트가 웹 페이지와 상호작용 가능
- **CLI + Socket API**: 외부 스크립트/에이전트가 프로그래밍 방식으로 터미널 제어 가능

---

## 2. CMUX 변형 3종 비교

CMUX라는 이름으로 3가지 프로젝트가 존재한다.

### 2.1 Manaflow cmux (공식, macOS)

| 항목 | 내용 |
|------|------|
| **리포** | [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) |
| **플랫폼** | macOS 14.0+ (Apple Silicon / Intel) |
| **기술 스택** | Swift + AppKit, libghostty (GPU 가속 렌더링) |
| **라이선스** | AGPL-3.0 |
| **가격** | 무료 |
| **설치** | `brew install cmux` 또는 DMG 다운로드 |

**주요 기능:**
- 버티컬 탭 사이드바 (git branch, PR 상태, 포트, 알림 텍스트 표시)
- 수평/수직 분할 패널
- 내장 스크립터블 브라우저 (접근성 트리 스냅샷, 클릭, 폼 입력, JS 실행)
- 알림 시스템 (OSC 9/99/777 터미널 시퀀스 + CLI)
- Unix Socket API (`~/.cache/cmux/cmux.sock`, JSON-RPC)
- 세션 복원 (레이아웃, 작업 디렉토리, 스크롤백, 브라우저 URL)
- Ghostty 설정 파일 호환

### 2.2 cmux-windows (Windows 네이티브)

| 항목 | 내용 |
|------|------|
| **리포** | [mkurman/cmux-windows](https://github.com/mkurman/cmux-windows) |
| **플랫폼** | Windows 10/11 |
| **기술 스택** | .NET 10, WPF, ConPTY, C# |
| **라이선스** | MIT |
| **최신 릴리즈** | v1.0.6 (2026-03) |

**주요 기능:**
- 워크스페이스 관리 (`Ctrl+N`, `Ctrl+1..9`)
- 분할 패널 (`Ctrl+D` 수직, `Ctrl+Shift+D` 수평)
- OSC 알림 시스템 (9/99/777)
- 명령어 감사/기록 (`Ctrl+Shift+L`)
- 세션 복구 (크래시 후 자동 복원, Session Vault)
- 커맨드 팔레트 (`Ctrl+Shift+P`)
- Named-pipe API로 외부 스크립트 자동화

**빌드 옵션:**
- Framework-dependent (최소 크기, .NET 런타임 필요)
- Self-contained (런타임 번들)
- Single-file executable (완전 포터블)

**프로젝트 구조:**
```
src/Cmux/         # WPF 데스크톱 앱
src/Cmux.Core/    # 터미널 엔진, 서비스, IPC
src/Cmux.Cli/     # CLI 클라이언트
tests/Cmux.Tests/ # 단위 테스트
```

### 2.3 craigsc/cmux (CLI 도구, tmux for Claude Code)

| 항목 | 내용 |
|------|------|
| **리포** | [craigsc/cmux](https://github.com/craigsc/cmux) |
| **플랫폼** | macOS, Linux (Bash 기반) |
| **기술 스택** | Pure Bash, Git worktree, Claude CLI |
| **라이선스** | MIT |

**핵심 개념:** Git worktree를 활용하여 각 Claude Code 에이전트에게 격리된 작업 디렉토리를 제공하는 CLI 래퍼.

**CLI 명령:**
```bash
cmux new <branch>           # 워크트리 생성 + Claude 실행
cmux start <branch>         # 기존 세션 재개
cmux ls                     # 활성 워크트리 목록
cmux merge [branch] [--squash]  # 워크트리 브랜치 병합
cmux rm [branch|--all]      # 워크트리 제거
cmux init                   # 셋업 훅 생성 (Claude가 생성)
```

---

## 3. 아키텍처 상세 (Manaflow cmux 기준)

### 3.1 계층 구조

```
Window (macOS 윈도우)
  └── Workspace (사이드바 항목)
       └── Pane (분할 영역)
            └── Surface (개별 탭: 터미널 또는 브라우저)
```

### 3.2 Socket API

- **경로**: `~/.cache/cmux/cmux.sock` (환경변수 `CMUX_SOCKET_PATH`로 오버라이드)
- **프로토콜**: JSON-RPC, 개행 구분
- **접근 모드**:
  - `off`: 소켓 비활성화
  - `cmuxOnly`: cmux 내부 프로세스만 접근 (기본값)
  - `allowAll`: 모든 로컬 프로세스 허용

### 3.3 CLI 명령 체계

| 카테고리 | 주요 명령 |
|----------|-----------|
| **워크스페이스** | `workspace list/new/select/close` |
| **서피스** | `surface list/focus/new` |
| **입력** | `send <text>`, `send-key <key>`, `send-surface <id> <text>` |
| **분할** | `split left/right/up/down`, `split browser-right/browser-down` |
| **알림** | `notify [--title] [--body]`, `notify list/clear` |
| **사이드바** | `set-status <key> <value>`, `set-progress <0.0-1.0>`, `log <msg>` |
| **브라우저** | `browser navigate/click/fill/snapshot/screenshot/eval` |
| **유틸** | `ping`, `capabilities`, `identify` |

### 3.4 브라우저 자동화 API

에이전트가 내장 브라우저를 프로그래밍 방식으로 제어 가능:

```bash
# 네비게이션
cmux browser navigate <surface> <url>
cmux browser back/forward/reload <surface>

# 대기
cmux browser wait-selector <surface> <selector>
cmux browser wait-text <surface> <text>
cmux browser wait-load <surface>

# DOM 상호작용
cmux browser click <surface> <selector>
cmux browser fill <surface> <selector> <text>
cmux browser type <surface> <text>

# 검사
cmux browser snapshot <surface>        # 접근성 트리 캡처
cmux browser screenshot <surface>      # 스크린샷
cmux browser get-text <surface> <sel>  # 텍스트 읽기

# JavaScript
cmux browser eval <surface> <code>     # JS 실행 + 결과 반환
cmux browser inject <surface> <code>   # JS 실행 (반환 없음)

# 상태
cmux browser get-cookies/set-cookie/get-storage/clear-storage
```

### 3.5 알림 시스템

**생명주기:** Received → Unread (배지 표시) → Read (워크스페이스 확인 시) → Cleared

**전송 방법:**
1. CLI: `cmux notify --title "Build" --body "완료"`
2. OSC 777: `printf '\033]777;notify;%s;%s\033\\' "Title" "Body"`
3. OSC 99 (리치): `printf '\033]99;i=1;title=Build;subtitle=OK\033\\'`
4. Claude Code Hooks: `~/.local/share/claude-code-hooks/cmux.sh`
5. 커스텀 명령: Settings → App → Notification Command

**억제 규칙:** CMUX 창에 포커스 + 해당 워크스페이스 활성 + 알림 패널 오픈 시 데스크톱 알림 억제.

### 3.6 환경 변수

| 변수 | 용도 |
|------|------|
| `CMUX_SOCKET_PATH` | 소켓 경로 오버라이드 |
| `CMUX_SOCKET_ENABLED` | 소켓 활성화/비활성화 |
| `CMUX_SOCKET_MODE` | 접근 모드 설정 |
| `CMUX_WORKSPACE_ID` | 현재 워크스페이스 ID (자동 설정) |
| `CMUX_SURFACE_ID` | 현재 서피스 ID (자동 설정) |

---

## 4. cmux vs tmux 비교

| 기능 | cmux (Manaflow) | tmux |
|------|-----------------|------|
| 분할 패널 | O | O |
| Detach/Reattach | X | O |
| 원격 서버 지원 | X | O |
| 내장 브라우저 | O (스크립터블) | X |
| 에이전트 알림 | 블루 링, 배지, 점프 | 벨 알림만 |
| 세션 복원 | 레이아웃, 디렉토리, 스크롤백 | 플러그인 필요 |
| 플러그인 생태계 | 커뮤니티 초기 | 100+ (TPM) |
| GPU 렌더링 | O (libghostty) | X (호스트 터미널 의존) |
| 크로스 플랫폼 | macOS only | macOS, Linux, BSD |
| 라이선스 | AGPL-3.0 | ISC |

**cmux 선택 시나리오:** macOS에서 로컬 AI 에이전트 병렬 운용, GUI 통합, 내장 브라우저 필요 시
**tmux 선택 시나리오:** SSH 원격 작업, 크로스 플랫폼, Detach/Reattach, 성숙한 플러그인 생태계

---

## 5. 관련 도구 생태계

| 도구 | 설명 | 차별점 |
|------|------|--------|
| **AMUX** ([mixpeek/amux](https://github.com/mixpeek/amux)) | tmux 기반 Claude Code 에이전트 멀티플렉서 | 브라우저/폰에서 원격 제어 가능 |
| **Coder Mux** ([coder/mux](https://github.com/coder/mux)) | 격리된 병렬 에이전트 개발용 데스크톱 앱 | Coder 생태계 통합 |
| **cmuxlayer** (MCP 서버) | CMUX를 MCP 서버로 노출 | AI 에이전트가 직접 CMUX 제어 |
| **Claude Agent Teams** | Claude Code 공식 멀티 에이전트 | 세션 간 팀 리더 조율 방식 |

---

## 6. BuilderGate 피벗 관점에서의 시사점

### 6.1 CMUX가 이미 해결하는 것

BuilderGate의 원래 비전과 CMUX의 기능이 상당 부분 겹친다:

| BuilderGate 기능 | CMUX 대응 |
|------------------|-----------|
| 웹 터미널 (다중 세션/탭) | 네이티브 터미널 + 버티컬 탭 + 분할 패널 |
| 파일 매니저 | 미지원 (터미널 내 CLI 도구 사용) |
| 마크다운/코드 뷰어 | 내장 브라우저로 부분 대체 |
| 세션 간 에이전트 중계 | Socket API + CLI로 에이전트 간 통신 가능 |

### 6.2 CMUX의 한계 (기회 영역)

- **원격 접근 불가**: 웹 기반이 아니므로 브라우저에서 접속 불가
- **파일 매니저 부재**: Mdir 스타일 파일 탐색 없음
- **Task 관리 부재**: 에이전트 작업 상태를 체계적으로 추적하는 기능 없음
- **MCP 통합 제한**: cmuxlayer가 있지만 아직 초기 단계
- **Windows 공식 미지원**: cmux-windows는 커뮤니티 포크 (비공식)
- **라이브 프로세스 복원 불가**: 레이아웃만 복원, 실행 중 프로세스는 복원 안 됨

### 6.3 피벗 방향 제안

1. **CMUX 보완형**: CMUX가 못하는 웹 기반 원격 접근 + 파일 매니저 + Task 관리에 집중
2. **CMUX 통합형**: CMUX의 Socket API를 활용하여 웹 프론트엔드에서 CMUX를 원격 제어
3. **독자 경쟁형**: CMUX의 컨셉을 웹 기반으로 재구현 (크로스 플랫폼 장점)

---

## 7. 참고 자료

- [cmux 공식 사이트](https://cmux.com/)
- [manaflow-ai/cmux GitHub](https://github.com/manaflow-ai/cmux)
- [mkurman/cmux-windows GitHub](https://github.com/mkurman/cmux-windows)
- [craigsc/cmux GitHub](https://github.com/craigsc/cmux)
- [cmux vs tmux 비교 (SoloTerm)](https://soloterm.com/cmux-vs-tmux)
- [Hacker News 토론](https://news.ycombinator.com/item?id=45596024)
- [cmux 가이드 (Better Stack)](https://betterstack.com/community/guides/ai/cmux-terminal/)
- [cmuxlayer MCP 서버](https://glama.ai/mcp/servers/EtanHey/cmuxlayer)
