# Software Requirements Specification (SRS)
# BuilderGate — Step 7: CMUX-Style Workspace Pivot

**Version**: 2.0.0
**Date**: 2026-03-25
**Status**: Approved (3인 전문가 평가 반영, 이중 검증 통과)
**Evaluation Rounds**: 1 (초안) + 1 (전문가 피드백 반영)
**Depends On**: `docs/archive/spec/srs.step6.md` (Pane Split System — 대체 대상)
**Research Reference**: `docs/research/cmux-research.md`

---

## 1. 개요

### 1.1 목적

본 문서는 BuilderGate를 **웹 기반 CMUX 경쟁 제품**으로 피벗하기 위한 Step 7 요구사항 명세서이다. CMUX(네이티브 macOS 터미널 멀티플렉서)의 핵심 컨셉인 Workspace 기반 멀티 터미널 관리를 웹 브라우저에서 크로스 플랫폼으로 제공하는 것이 목표이다.

### 1.2 피벗 동기

| 관점 | 설명 |
|------|------|
| CMUX의 한계 | macOS 전용, 원격 접근 불가, 파일 매니저 부재, Windows 미지원 |
| BuilderGate의 강점 | 웹 기반 크로스 플랫폼, 기존 PTY/보안/SSE 인프라 완성, REST API 보유 |
| 차별화 | 브라우저에서 어디서든 접속 가능한 CMUX 대안 |

### 1.3 범위

**포함:**
- 기존 "세션" 개념을 "Workspace" 기반으로 재구성
- 탭/그리드 듀얼 뷰 모드 도입 (기존 SplitPane 대체)
- 에이전트 활성 상태 시각적 표시 (breathing 효과)
- Workspace 하단 메타데이터 바
- 8색 탭 컬러 팔레트 시스템
- IndexedDB → 서버 JSON 상태 저장 전환
- 터미널 드래그 앤 드롭 재배치
- 서버 재시작 복구 프로토콜

**제외:**
- 파일 뷰어 탭 (추후 재추가 예정)
- 알림 시스템 (기존 상태 표시로 대체)
- 추가 CLI/API (기존 REST API 활용)
- Task 관리자, MCP 통합, Agent Orchestration (후속 Step)

### 1.4 용어

| 용어 | 설명 |
|------|------|
| Workspace | 터미널 탭들의 논리적 그룹. CMUX의 Workspace 개념에 대응 |
| Tab | Workspace 내의 개별 터미널 세션. 고유 색상 부여 |
| Tab Mode | 한 번에 하나의 터미널만 활성 표시하는 뷰 모드 |
| Grid Mode | Workspace 내 모든 터미널을 격자 형태로 동시 배치하는 뷰 모드 |
| Grid Cell | 그리드 모드에서 하나의 터미널이 배치되는 격자 영역 |
| Empty Cell | 그리드 모드에서 터미널이 배치되지 않은 빈 격자 영역 |
| Breathing Effect | 에이전트 활성 상태를 나타내는 페이드 인/아웃 애니메이션 |
| Metadata Bar | Workspace 하단에 각 탭의 상태 정보를 요약 표시하는 바 |
| Color Palette | 8색 고정 팔레트. 탭 색상과 메타데이터 바 라벨 색상에 동일 적용 |
| Orphan Tab | 서버 재시작 등으로 PTY 세션이 소멸된 상태의 탭 |

### 1.5 이전 버전 대비 변경사항

| 영역 | Step 6까지 | Step 7에서 변경 |
|------|-----------|----------------|
| 좌측 패널 | 세션(Session) 목록 | **Workspace** 목록 |
| 멀티 터미널 뷰 | 바이너리 트리 기반 SplitPane | **Grid Mode** (격자 배치) |
| 뷰 모드 | 탭 + Pane 분할 (혼합) | **Tab/Grid 전환** (듀얼 모드) |
| 상태 저장 | IndexedDB (브라우저) | **서버 JSON** 파일 |
| 터미널 재배치 | Pane swap (컨텍스트 메뉴) | **롱프레스 드래그 앤 드롭** |
| 에이전트 표시 | 초록 원 상태 인디케이터 | **초록 테두리 + breathing 효과** |
| 파일 뷰어 | 탭으로 추가 가능 | **제거** (추후 재추가) |
| 기본 터미널 | 세션 생성 시 기본 1개 | **빈 상태**로 생성 |
| 탭 색상 | 없음 | **8색 팔레트** 자동 할당 |
| 하단 바 | StatusBar (연결 상태, PWD) | **Metadata Bar** (세션별 상태 정보) |

### 1.6 사용자 요구사항 매핑

| UR-ID | 사용자 요구사항 | 대응 요구사항 |
|-------|----------------|---------------|
| UR-701 | 터미널들을 Workspace 단위로 그룹화하여 관리할 수 있어야 한다 | FR-7101~FR-7108 |
| UR-702 | Workspace 내에서 최대 8개의 터미널 탭을 추가/삭제하고 색상으로 구분할 수 있어야 한다 | FR-7201~FR-7207 |
| UR-703 | 탭 모드와 그리드 모드를 전환하여 터미널을 볼 수 있어야 한다 | FR-7301~FR-7305 |
| UR-704 | 그리드 모드에서 터미널들을 격자로 배치하고 크기를 조절할 수 있어야 한다 | FR-7401~FR-7406 |
| UR-705 | 에이전트가 실행 중인 터미널을 시각적으로 즉시 식별할 수 있어야 한다 | FR-7501~FR-7504 |
| UR-706 | 각 터미널의 상태(이름, 디렉토리, 경과 시간)를 하단 바에서 한눈에 확인할 수 있어야 한다 | FR-7601~FR-7605 |
| UR-707 | 브라우저를 닫았다 다시 열어도, 다른 기기에서 접속해도 동일한 레이아웃이 복원되어야 한다 | FR-7701~FR-7706 |

---

## 2. 현재 코드베이스 분석 요약

### 2.1 유지 대상 (인터페이스 확장 가능)

| 모듈 | 경로 | 역할 | Step 7 영향 |
|------|------|------|-------------|
| SessionManager | `server/src/services/SessionManager.ts` | PTY 세션 생성/삭제/SSE 스트리밍 | `hasSession(id)`, `deleteMultipleSessions(ids)` 메서드 추가 필요 |
| AuthService | `server/src/services/AuthService.ts` | JWT 인증 | 변경 없음 |
| TwoFactorService | `server/src/services/TwoFactorService.ts` | 이메일 OTP | 변경 없음 |
| SSLService | `server/src/services/SSLService.ts` | HTTPS 인증서 | 변경 없음 |
| CryptoService | `server/src/services/CryptoService.ts` | AES-256-GCM 암호화 | 변경 없음 |
| sessionRoutes | `server/src/routes/sessionRoutes.ts` | REST API (`/api/sessions/*`) | 변경 없음, 별도 workspaceRoutes 신규 생성 |
| fileRoutes | `server/src/routes/fileRoutes.ts` | 파일 API (`/api/files/*`) | 변경 없음 |
| TerminalView | `frontend/src/components/Terminal/TerminalView.tsx` | xterm.js 렌더링, ResizeObserver | 그리드 셀 내 배치에도 그대로 동작 |
| TerminalContainer | `frontend/src/components/Terminal/TerminalContainer.tsx` | SSE 연결, PTY 입력 | 변경 없음 |

### 2.2 수정 대상

| 모듈 | 현재 | Step 7 변경 |
|------|------|-------------|
| Sidebar | 세션 목록 (`SessionList`, `SessionItem`) | Workspace 목록으로 재구성, 모바일 드로어 전환 |
| StatusIndicator | `running`/`idle` 원형 인디케이터 | breathing 효과 + 초록 테두리로 대체 |
| TerminalBadges | 세션당 `running`/`idle` 카운트 뱃지 | Workspace당 활성 세션 수 뱃지로 전환 |
| StatusBar | 연결 상태, PWD 표시 | Metadata Bar로 완전 대체 |
| App.tsx | `childSessionIds` 관리, 탭 상태 로직 | Workspace 기반 상태 관리로 전면 재구성 |
| useTabManager | 세션별 `UnifiedTab[]` 관리 | Workspace 기반 `useWorkspaceManager` 훅으로 재작성 |
| server/src/index.ts | 라우트 마운트 | `workspaceRoutes` 마운트 추가 |
| config.json5 | 서버 설정 | workspace JSON 파일 경로 설정 추가 |

### 2.3 제거 대상

| 모듈 | 이유 |
|------|------|
| SplitPane 시스템 (`PaneSystem/` 전체) | Grid Mode로 대체 |
| usePaneManager 훅 | Grid Mode로 대체 |
| paneTree.ts 유틸 | Grid Mode로 대체 |
| IndexedDB 관련 코드 (paneDb.ts, usePaneDB.ts) | 서버 JSON 저장으로 전환 |
| 파일 뷰어 탭 (`ViewerPanel`, `MarkdownViewer`, `CodeViewer`) | 추후 재추가 예정 |
| Prefix Mode (Ctrl+B) | SplitPane 전용이었으므로 제거 |

### 2.4 신규 생성 파일

| 경로 | 역할 |
|------|------|
| `server/src/services/WorkspaceService.ts` | Workspace 상태 관리 (in-memory + JSON 파일 영속화) |
| `server/src/routes/workspaceRoutes.ts` | Workspace REST API + SSE 엔드포인트 |
| `server/src/types/workspace.types.ts` | Workspace 관련 TypeScript 타입 |
| `server/data/workspaces.json` | Workspace 상태 영속화 파일 |
| `frontend/src/hooks/useWorkspaceManager.ts` | Workspace 상태 관리 훅 |
| `frontend/src/components/Workspace/` | Workspace 관련 UI 컴포넌트 |
| `frontend/src/components/Grid/` | Grid Mode 컴포넌트 |
| `frontend/src/components/MetadataBar/` | 하단 메타데이터 바 |

---

## 3. 기능 요구사항

### FR-7100: Workspace 관리

#### FR-7101: Workspace 목록 좌측 패널

좌측 패널에 Workspace 목록을 표시한다.

| 속성 | 값 |
|------|---|
| 데스크톱 (≥768px) | 항상 노출 (고정) |
| 모바일 (<768px) | 드로어(서랍) 형태 |
| 각 항목 표시 | Workspace 이름, 활성 세션 수 뱃지 |
| ARIA | `role="listbox"`, 각 항목 `role="option"`, `aria-selected` |

**모바일 드로어 상세:**

| 속성 | 값 |
|------|---|
| 열기 트리거 | 햄버거 버튼 (좌측 상단) 또는 좌측 가장자리에서 오른쪽으로 50px 이상 스와이프 |
| 닫기 트리거 | 드로어 바깥 터치, 오른쪽에서 왼쪽 스와이프, 또는 X 버튼 |
| 오버레이 | `rgba(0, 0, 0, 0.5)` dim 배경 |
| 드로어 너비 | `80vw`, `max-width: 320px` |
| 애니메이션 | `transform: translateX()`, 200ms ease-out |
| 포커스 트랩 | 드로어 오픈 시 포커스가 드로어 내부에 갇힘 |

#### FR-7102: Workspace 생성

사용자가 Workspace를 생성하면 **빈 상태**로 시작한다. 기본 터미널이 자동 생성되지 않는다.

| 속성 | 값 |
|------|---|
| 빈 상태 UI | 중앙 정렬: 터미널 아이콘(48px) + "터미널을 추가하세요" 텍스트(16px, `#888`) + 추가 버튼(primary color) |
| 이름 기본값 | `Workspace-{N}` (순번 자동 증가) |
| 이름 유효성 | 빈 문자열 불가, 최대 32자, 중복 허용 |
| 생성 후 동작 | 해당 Workspace로 자동 전환 + 터미널 포커스 |

#### FR-7103: Workspace 전환

Workspace 간 전환 시 이전 Workspace의 **PTY 세션은 백그라운드에서 계속 실행**된다.

| 속성 | 값 |
|------|---|
| 전환 방식 | 좌측 패널에서 클릭 |
| PTY 세션 | 모든 Workspace의 PTY 프로세스 유지 |
| 뷰 상태 | 각 Workspace별 탭 모드/그리드 모드, 활성 탭, 그리드 레이아웃 독립 유지 |
| 포커스 | 전환 대상 Workspace의 `activeTabId` 터미널에 자동 포커스 |
| 비활성 최적화 | 비활성 Workspace의 xterm.js 인스턴스는 DOM에서 분리(detach)하되 버퍼 유지 |

#### FR-7104: Workspace 삭제

Workspace 삭제 시 소속된 모든 PTY 세션을 정리한다.

| 속성 | 값 |
|------|---|
| 확인 | 삭제 전 확인 모달 표시 ("세션 N개가 종료됩니다" 안내) |
| 정리 | 소속 PTY 세션 전부 종료, 서버 JSON에서 해당 Workspace 데이터 삭제 |
| SSE 알림 | 삭제 전 `workspace:deleting` 이벤트를 다른 클라이언트에 전송 |

#### FR-7105: Workspace 이름 변경

좌측 패널에서 Workspace를 더블클릭하거나 컨텍스트 메뉴로 이름을 변경할 수 있다.

**Workspace 컨텍스트 메뉴 항목:**

| 항목 | 동작 |
|------|------|
| 이름 변경 | 인라인 편집 모드 진입 |
| 삭제 | FR-7104 삭제 프로세스 |
| 터미널 추가 | FR-7201 탭 추가 |

#### FR-7106: Workspace 정렬

좌측 패널에서 Workspace를 드래그하여 순서를 변경할 수 있다.

#### FR-7107: 최소 Workspace 유지

최소 1개의 Workspace가 항상 존재해야 한다.

| 속성 | 값 |
|------|---|
| 마지막 Workspace | 삭제 버튼 비활성화 (컨텍스트 메뉴에서 삭제 항목 숨김) |
| 초기 상태 | 앱 최초 실행 시 빈 Workspace 1개 자동 생성 |

#### FR-7108: 최대 Workspace 제한

| 속성 | 값 |
|------|---|
| Workspace 상한 | **10개** (config.json5에서 변경 가능) |
| 전체 PTY 세션 상한 | **32개** (config.json5에서 변경 가능) |
| 초과 시 | 생성 버튼 비활성화 + 툴팁 안내 |

---

### FR-7200: 탭 시스템

#### FR-7201: 터미널 탭 추가

Workspace 내에서 터미널 탭을 추가할 수 있다.

| 속성 | 값 |
|------|---|
| 상한 | Workspace당 최대 **8개** |
| 추가 방식 | 상단 TabBar의 `+` 버튼 |
| 초과 시 | `+` 버튼 비활성화, 툴팁으로 "최대 8개" 안내 |
| 전체 PTY 상한 | 전체 세션이 32개에 도달하면 모든 Workspace에서 추가 차단 |
| 셸 선택 | 기존 ShellSelectModal 재활용 (PowerShell, WSL, Bash, Auto) |
| 추가 후 동작 | 새 탭이 활성 탭이 됨, 터미널 포커스 이동 |

#### FR-7202: 8색 탭 컬러 팔레트

탭에 고유 색상을 자동 할당한다.

| 속성 | 값 |
|------|---|
| 팔레트 크기 | 8색 |
| 할당 규칙 | `colorIndex = 생성 순번 카운터 % 8`. 카운터는 Workspace별 독립, 단조 증가. 탭 삭제 후에도 카운터 복귀하지 않음 |
| 적용 범위 | TabBar 탭 색상, Grid Mode 셀 상단 테두리, Metadata Bar 라벨 색상 — 모두 동일 |
| 색상 정의 | 섹션 `4.3 Color Palette` 참조 |

#### FR-7203: 탭 드래그 앤 드롭 재배치

마우스 롱프레스(300ms)로 탭을 드래그하여 순서를 변경할 수 있다.

| 속성 | 값 |
|------|---|
| 트리거 | 마우스 롱프레스 300ms (기존 `useDragReorder` 패턴 재활용) |
| Tab Mode | TabBar에서 탭 순서 변경 |
| Grid Mode | 격자 내 셀 위치 교환 |
| 드래그 고스트 | opacity 0.6, 원본 크기 100%, 커서 중앙 오프셋 |
| 드롭 타겟 | 2px dashed border, 해당 탭 팔레트 색상 |

#### FR-7204: 파일 뷰어 탭 제거

탭 타입에서 파일 뷰어(`viewer`, `markdown`, `code`)를 제거한다. 탭은 터미널(`terminal`) 전용이다.

#### FR-7205: 탭 닫기

| 속성 | 값 |
|------|---|
| UI 트리거 | TabBar 탭 우측 X 버튼, 또는 탭 컨텍스트 메뉴 "닫기" |
| PTY 종료 | 해당 탭의 PTY 세션 즉시 종료 |
| 확인 모달 | 불필요 (터미널 종료는 복구 불가하지만 빈번한 동작이므로 빠른 UX 우선) |

**활성 탭 닫기 후 전환 정책:**

| 조건 | 동작 |
|------|------|
| 우측 인접 탭 존재 | 우측 인접 탭이 활성화 |
| 우측 없고 좌측 존재 | 좌측 인접 탭이 활성화 |
| 마지막 탭 닫기 | `activeTabId = null`, 빈 상태 UI 표시 (FR-7102 참조) |

#### FR-7206: 탭 이름 변경

| 속성 | 값 |
|------|---|
| 트리거 | TabBar 탭 더블클릭 또는 컨텍스트 메뉴 "이름 변경" |
| 편집 | 인라인 텍스트 입력, Enter로 확정, Escape로 취소 |
| 동기화 | 탭 이름이 마스터. `Session.name`은 내부용으로만 사용, 동기화하지 않음 |

#### FR-7207: 탭 세션 비정상 종료 처리

PTY 프로세스가 비정상 종료(crash, exit code ≠ 0)된 경우의 처리.

| 속성 | 값 |
|------|---|
| 탭 상태 | `disconnected` (기존 `running`/`idle` 외 추가) |
| UI 표시 | 탭에 경고 아이콘, 터미널 영역에 에러 오버레이 ("세션이 종료되었습니다") + "재시작" 버튼 |
| 재시작 | 동일 셸 타입으로 새 PTY 세션 생성, 기존 탭에 연결 |
| 자동 제거 | 하지 않음 (사용자가 명시적으로 닫기 수행) |

---

### FR-7300: 탭/그리드 듀얼 뷰 모드

#### FR-7301: 전환 토글 버튼

우측 상단에 탭/그리드 전환 토글 버튼을 배치한다.

| 속성 | 값 |
|------|---|
| 위치 | 우측 상단 (TabBar 영역) |
| 아이콘 | 탭 아이콘 ↔ 그리드(격자) 아이콘 토글 |
| 상태 | Workspace별 독립 저장 |
| 전환 애니메이션 | CSS transition, opacity + transform, 200ms ease-out |

#### FR-7302: 데스크톱 전용 토글

토글 버튼은 **데스크톱(≥768px)에서만** 노출된다.

#### FR-7303: 모바일 고정 탭 모드

모바일(<768px)에서는 **항상 탭 모드**이며 전환 버튼을 표시하지 않는다.

#### FR-7304: Tab Mode 동작

한 번에 하나의 터미널만 활성 표시한다. TabBar에서 탭을 클릭하여 전환한다.

| 속성 | 값 |
|------|---|
| ARIA | TabBar: `role="tablist"`, 각 탭: `role="tab"`, `aria-selected`, `aria-controls` |
| 포커스 | 탭 전환 시 해당 터미널에 자동 포커스 |

#### FR-7305: Grid Mode 동작

Workspace 내 모든 터미널 탭을 격자 형태로 동시 배치한다. 자세한 그리드 동작은 FR-7400 참조.

---

### FR-7400: Grid Mode

#### FR-7401: 자동 격자 계산

터미널 수에 따라 격자 배치를 자동 계산한다.

| 터미널 수 | 격자 (열×행) | 비고 |
|-----------|-------------|------|
| 1 | 1×1 | 전체 화면 |
| 2 | 2×1 | 좌우 배치 |
| 3 | 2×2 (1셀 비움) | |
| 4 | 2×2 | 균등 4분할 |
| 5~6 | 3×2 | 빈 셀 허용 |
| 7~8 | 4×2 | 빈 셀 허용 |

**알고리즘:**
```
cols = Math.ceil(Math.sqrt(count))
rows = Math.ceil(count / cols)
if (containerWidth / containerHeight < 1.0) swap(cols, rows)  // portrait 전치
```

#### FR-7402: 셀 경계 드래그 리사이즈

그리드 셀 경계를 드래그하여 크기를 조절할 수 있다.

| 속성 | 값 |
|------|---|
| 리사이즈 방향 | 수평(열 경계), 수직(행 경계) |
| 최소 셀 크기 | 120px (너비), 80px (높이) |
| 리사이즈 핸들 | 셀 경계 위에 hover 시 4px 리사이즈 커서 표시 |
| 열 경계 드래그 | 해당 열의 모든 행에서 동일 너비 조절 |
| 행 경계 드래그 | 해당 행의 모든 열에서 동일 높이 조절 |
| xterm.js | 셀 크기 변경 시 `ResizeObserver` → `fitAddon.fit()` 자동 반영 |
| 저장 | 드래그 종료 시 1회 서버 저장 (드래그 중에는 저장 억제) |

#### FR-7403: SplitPane 대체

기존 Step 6의 바이너리 트리 SplitPane 시스템을 **완전히 대체**한다. SplitPane 관련 코드(컴포넌트, 훅, 유틸, IndexedDB)는 전부 제거한다.

#### FR-7404: 그리드 내 터미널 드래그 재배치

Grid Mode에서 터미널을 롱프레스(300ms) 드래그하여 다른 셀과 위치를 교환할 수 있다.

| 속성 | 값 |
|------|---|
| 트리거 | 셀 영역 롱프레스 300ms |
| 드래그 중 | 드래그 중인 셀 opacity 0.6 + 드롭 타겟 셀 2px dashed border (팔레트 색상) |
| 드롭 | 두 셀의 위치(탭 순서 인덱스) 교환 |
| 빈 셀로 드롭 | 해당 위치로 이동 |

#### FR-7405: 그리드 빈 셀 렌더링

터미널 수가 격자 셀 수보다 적을 때 남은 빈 셀의 렌더링.

| 속성 | 값 |
|------|---|
| 배경 | 어두운 배경 (`#1a1a1a`) |
| 테두리 | 1px dashed `#333` |
| 중앙 | `+` 아이콘 (24px, `#555`) |
| 클릭 시 | 탭 추가 동작 (FR-7201과 동일, 상한 8개 적용) |

#### FR-7406: 반응형 그리드 리사이즈

브라우저 윈도우 크기 변경 시 그리드 레이아웃의 반응.

| 속성 | 값 |
|------|---|
| 감지 | `ResizeObserver`로 그리드 컨테이너 크기 감시 |
| 비율 유지 | 사용자 커스텀 `cellSizes`는 비율 기반이므로 자동 유지 |
| 최소 크기 위반 | 셀이 최소 크기(120×80px) 미만이 되면 커스텀 크기를 null로 리셋하여 균등 배분 |
| portrait ↔ landscape | aspect ratio 변경 시 자동 격자 재계산 (cols/rows 전치) |
| 탭 수 변경 시 | 커스텀 `cellSizes`를 null로 리셋하여 자동 재계산 |

---

### FR-7500: 에이전트 활성 상태 표시

#### FR-7501: 초록 테두리 + 내부 그림자

`running` 상태 터미널에 시각적 강조를 적용한다.

| 속성 | 값 |
|------|---|
| 테두리 | 2px solid `#22c55e` (green-500) |
| 내부 그림자 | `inset 0 0 20px rgba(34, 197, 94, 0.15)` |
| 적용 범위 | Tab Mode의 활성 터미널, Grid Mode의 각 셀 |

#### FR-7502: Breathing 효과

`running` 상태 터미널의 테두리와 그림자가 **페이드 아웃/인 애니메이션**을 반복한다.

| 속성 | 값 |
|------|---|
| 애니메이션 | CSS `@keyframes` — opacity 0.4 ↔ 1.0 |
| 주기 | 2초 (1초 페이드 아웃 + 1초 페이드 인) |
| easing | `ease-in-out` |
| 성능 | `will-change: opacity`로 GPU 가속 |
| `prefers-reduced-motion` | 정적 초록 테두리만 표시, 애니메이션 비활성화 |
| ARIA | 상태 변경 시 `aria-live="polite"` 영역에 "터미널 N 활성" 알림 |

#### FR-7503: Workspace 활성 세션 뱃지

좌측 Workspace 목록에 해당 Workspace 내 `running` 상태 세션 수를 뱃지로 표시한다.

| 속성 | 값 |
|------|---|
| 위치 | Workspace 항목 우측 |
| 색상 | 초록 배경 + 흰색 숫자 |
| 0일 때 | 뱃지 숨김 |

#### FR-7504: 상태 감지 메커니즘

기존 `SessionManager`의 `idleDelayMs` 타이머 기반 `running`/`idle` 상태 감지를 그대로 유지한다. 추후 정교한 감지(프로세스명, 출력 패턴)는 별도 연구 후 도입.

---

### FR-7600: Workspace 하단 메타데이터 바

#### FR-7601: 세션별 한 줄 표시

Workspace 하단에 소속된 각 터미널 탭마다 한 줄씩 상태 정보를 표시한다.

| 속성 | 값 |
|------|---|
| 행 수 | 현재 Workspace의 탭 수 (0~8) |
| 정렬 | 탭 순서와 동일 |
| 탭 0개 시 | 메타데이터 바 숨김 |

#### FR-7602: 회색 배경 명암 차이

각 행의 배경색을 회색 계통으로 하되, 행마다 명암을 미세하게 다르게 한다.

| 속성 | 값 |
|------|---|
| 기본 배경 | `#2a2a2a` (다크 테마 기준) |
| 명암 차이 | 짝수행 `#2a2a2a` / 홀수행 `#2e2e2e` |

#### FR-7603: 좌측 컬러 라벨 + 세션 이름

| 속성 | 값 |
|------|---|
| 라벨 형태 | 높이 100%, 너비 4px (얇은 수직 컬러 바) |
| 라벨 색상 | 해당 탭의 8색 팔레트 색상 |
| 세션 이름 | 흰색 텍스트, 라벨 우측 8px 간격, 최대 20자 truncate + ellipsis |

#### FR-7604: CWD 복사 버튼

| 속성 | 값 |
|------|---|
| 위치 | 행 우측 |
| 아이콘 | 복사(clipboard) 아이콘 (16px) |
| 동작 | 클릭 시 해당 세션의 CWD를 클립보드에 복사 |
| CWD 출처 | 기존 SessionManager의 CWD 추적(5초 폴링) 결과를 프론트엔드에서 참조 |
| 피드백 | 복사 성공 시 아이콘 → 체크마크 (1.5초 후 복원) |

#### FR-7605: 세션 경과 시간

| 속성 | 값 |
|------|---|
| 위치 | 행 우측, 복사 아이콘 좌측 |
| 형식 | `MM:SS` (분:초) |
| 기준 | 세션 **생성 시점** (`WorkspaceTab.createdAt`)부터의 경과 시간 |
| 갱신 | 1초 간격 (`setInterval(1000)`) |
| 60분 초과 시 | `HH:MM:SS` (시:분:초) 형식으로 전환 |

---

### FR-7700: 서버 상태 저장

#### FR-7701: IndexedDB 제거

기존 IndexedDB 기반 상태 저장(paneLayouts, savedLayouts, sessionMeta)을 **완전히 제거**하고 서버 JSON 파일로 전환한다.

#### FR-7702: 서버 동시성 모델

| 속성 | 값 |
|------|---|
| Canonical source | **서버 프로세스 in-memory 상태** |
| API 응답 | 메모리에서 직접 반환 (파일 미참조) |
| 디스크 저장 | Background flush: 변경 발생 후 **5초 debounce**로 파일 쓰기 |
| 즉시 저장 예외 | Workspace/탭 생성/삭제 시에는 debounce 무시하고 즉시 flush |
| Atomic write | `workspaces.json.tmp`에 쓴 후 `rename()`으로 교체 |
| 백업 | flush 전 `workspaces.json.bak` 백업 유지 (최근 1개) |
| 파일 퍼미션 | 생성 시 `mode: 0o600` (서버 프로세스만 읽기/쓰기) |

**Node.js 단일 스레드 모델에서 in-memory 상태 변경은 순차적으로 처리되므로, 다중 클라이언트 동시 요청 시에도 race condition이 발생하지 않는다.**

#### FR-7703: 서버 JSON 저장 구조

| 속성 | 값 |
|------|---|
| 저장 경로 | `server/data/workspaces.json` (config.json5에서 설정 가능) |
| 내용 | Workspace 목록, 각 Workspace의 탭 목록/순서/색상, 뷰 모드, 그리드 레이아웃 |

#### FR-7704: JSON 파일 손상 복구

| 시나리오 | 복구 전략 |
|----------|-----------|
| JSON 파싱 실패 | `workspaces.json.bak`에서 복원 시도 |
| 백업도 실패 | 빈 초기 상태로 시작 (Workspace 1개 자동 생성) |
| 파일 미존재 (최초 실행) | 빈 초기 상태 생성 + 파일 쓰기 |

#### FR-7705: 레이아웃 복원

브라우저 새로고침 또는 재접속 시 서버에서 전체 Workspace 상태를 복원한다.

| 속성 | 값 |
|------|---|
| API | `GET /api/workspaces` → 전체 Workspace 상태 반환 |
| 복원 범위 | Workspace 목록, 탭 순서, 뷰 모드, 그리드 레이아웃 |
| PTY 세션 | 서버 PTY는 이미 실행 중이므로 SSE 재연결만 수행 |
| `activeWorkspaceId` | **클라이언트 로컬 상태**로 관리 (서버에 저장하지 않음). 재접속 시 첫 번째 Workspace가 활성화 |

#### FR-7706: 서버 재시작 복구 프로토콜

서버 재시작 시 모든 PTY 프로세스는 소멸되지만 `workspaces.json`은 디스크에 남아있다.

**복구 절차:**
1. `workspaces.json` 로드 (실패 시 FR-7704 복구 적용)
2. 각 `WorkspaceTab`의 `sessionId`에 대해 `SessionManager.hasSession(id)` 확인
3. 존재하지 않는 세션 → 탭 상태를 `disconnected`로 설정
4. 프론트엔드에서 `disconnected` 탭에 "세션이 종료되었습니다 — 재시작" UI 표시 (FR-7207)
5. 사용자가 "재시작" 클릭 → 동일 셸 타입으로 새 PTY 세션 생성, `sessionId` 갱신
6. 갱신된 상태를 `workspaces.json`에 저장

---

## 4. 데이터 요구사항

### 4.1 서버 데이터 모델

```typescript
// === 영속 데이터 (서버 JSON 파일에 저장) ===

interface Workspace {
  id: string;                    // UUID
  name: string;                  // 표시 이름 (max 32자)
  sortOrder: number;             // 좌측 패널 정렬 순서
  viewMode: 'tab' | 'grid';     // 현재 뷰 모드
  activeTabId: string | null;    // Tab Mode에서 활성 탭 ID
  colorCounter: number;          // 탭 색상 할당용 단조 증가 카운터
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
}

interface WorkspaceTab {
  id: string;                    // UUID
  workspaceId: string;           // 소속 Workspace ID
  sessionId: string;             // PTY 세션 ID (SessionManager)
  name: string;                  // 탭 이름 (마스터, max 32자)
  colorIndex: number;            // 0~7 (8색 팔레트 인덱스)
  sortOrder: number;             // 탭 순서
  shellType: ShellType;          // 셸 타입 (재시작 시 필요)
  createdAt: string;             // ISO 8601 (경과 시간 계산 기준)
}

interface GridLayout {
  workspaceId: string;           // 소속 Workspace ID
  columns: number;               // 격자 열 수
  rows: number;                  // 격자 행 수
  tabOrder: string[];            // 격자 셀 배치 순서 (탭 ID 배열)
  cellSizes: {                   // null이면 자동 균등 배분
    colWidths: number[];         // 각 열의 비율 (합 = 1.0)
    rowHeights: number[];        // 각 행의 비율 (합 = 1.0)
  } | null;
}

// === 서버 저장 파일 루트 ===

interface WorkspaceState {
  workspaces: Workspace[];
  tabs: WorkspaceTab[];
  gridLayouts: GridLayout[];
  // activeWorkspaceId는 서버에 저장하지 않음 (클라이언트 로컬)
}

interface WorkspaceFile {
  version: 1;
  lastUpdated: string;           // ISO 8601
  state: WorkspaceState;
}
```

### 4.2 프론트엔드 런타임 타입

```typescript
// === 프론트엔드 전용 런타임 상태 (서버 저장 안 함) ===

interface WorkspaceTabRuntime extends WorkspaceTab {
  status: 'running' | 'idle' | 'disconnected';  // SessionManager에서 SSE로 수신
  cwd: string;                                    // CWD 폴링 결과
}
```

### 4.3 8색 팔레트 정의

| Index | Name | Hex | 어두운 배경 대비 비율 |
|-------|------|-----|---------------------|
| 0 | Blue | `#3b82f6` | 4.7:1 ✓ |
| 1 | Emerald | `#10b981` | 5.2:1 ✓ |
| 2 | Amber | `#f59e0b` | 8.1:1 ✓ |
| 3 | Rose | `#f43f5e` | 4.6:1 ✓ |
| 4 | Violet | `#8b5cf6` | 4.5:1 ✓ |
| 5 | Cyan | `#06b6d4` | 5.0:1 ✓ |
| 6 | Orange | `#f97316` | 6.3:1 ✓ |
| 7 | Pink | `#ec4899` | 5.1:1 ✓ |

모든 색상이 `#1e1e1e` 배경 기준 WCAG AA(4.5:1) 충족.

### 4.4 제약조건

| 제약 | 값 | 설명 |
|------|---|------|
| Workspace당 최대 탭 수 | 8 | 초과 시 추가 버튼 비활성화 |
| 최대 Workspace 수 | 10 | config.json5에서 변경 가능 |
| 전체 PTY 세션 상한 | 32 | config.json5에서 변경 가능 |
| 최소 그리드 셀 크기 | 120px × 80px | 이하로 축소 불가 |
| 세션/Workspace 이름 최대 길이 | 32자 | 초과 시 자동 truncate |

---

## 5. API 요구사항

### 5.1 Workspace REST API

| Method | Endpoint | 설명 | 요청 바디 | 응답 |
|--------|----------|------|-----------|------|
| GET | `/api/workspaces` | 전체 Workspace 상태 조회 | — | `WorkspaceState` |
| POST | `/api/workspaces` | Workspace 생성 | `{ name?: string }` | `Workspace` |
| PATCH | `/api/workspaces/:id` | Workspace 수정 (이름, 뷰 모드) | `Partial<Workspace>` | `Workspace` |
| DELETE | `/api/workspaces/:id` | Workspace 삭제 (소속 세션 정리) | — | `{ success: true }` |
| PUT | `/api/workspaces/order` | Workspace 순서 일괄 변경 | `{ workspaceIds: string[] }` | `{ success: true }` |
| POST | `/api/workspaces/:id/tabs` | 탭 추가 | `{ shell?: ShellType, name?: string }` | `WorkspaceTab` |
| PATCH | `/api/workspaces/:wid/tabs/:tid` | 탭 수정 (이름) | `{ name: string }` | `WorkspaceTab` |
| DELETE | `/api/workspaces/:wid/tabs/:tid` | 탭 삭제 (PTY 세션 종료) | — | `{ success: true }` |
| PUT | `/api/workspaces/:id/grid` | 그리드 레이아웃 저장 | `{ columns, rows, tabOrder, cellSizes }` | `GridLayout` |
| PUT | `/api/workspaces/:id/tab-order` | 탭 순서 일괄 변경 | `{ tabIds: string[] }` | `{ success: true }` |
| POST | `/api/workspaces/:wid/tabs/:tid/restart` | 탭 세션 재시작 | — | `WorkspaceTab` (갱신된 sessionId) |

### 5.2 Workspace SSE 엔드포인트

기존 세션별 SSE(`/api/sessions/:id/stream`)는 PTY output/status 전용으로 유지한다. Workspace 수준 이벤트를 위한 **별도 SSE 엔드포인트**를 추가한다.

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /api/workspaces/stream` | 모든 Workspace/탭 수준 이벤트를 전달하는 SSE 스트림 |

**SSE 이벤트 목록:**

| 이벤트 | 데이터 | 트리거 |
|--------|--------|--------|
| `workspace:created` | `Workspace` | 다른 클라이언트에서 Workspace 생성 |
| `workspace:updated` | `{ id, changes: Partial<Workspace> }` | Workspace 메타데이터 변경 |
| `workspace:deleted` | `{ id }` | Workspace 삭제 |
| `workspace:deleting` | `{ id }` | Workspace 삭제 직전 (다른 클라이언트 경고) |
| `workspace:reordered` | `{ workspaceIds: string[] }` | Workspace 순서 변경 |
| `tab:added` | `WorkspaceTab` | 탭 추가 |
| `tab:updated` | `{ id, workspaceId, changes }` | 탭 이름/순서 변경 |
| `tab:removed` | `{ id, workspaceId }` | 탭 삭제 |
| `tab:reordered` | `{ workspaceId, tabIds: string[] }` | 탭 순서 변경 |
| `tab:disconnected` | `{ id, workspaceId }` | PTY 세션 비정상 종료 |
| `grid:updated` | `GridLayout` | 그리드 레이아웃 변경 |

### 5.3 에러 응답 형식

모든 Workspace API 에러는 기존 `AppError` 패턴을 따른다:

```json
{
  "error": {
    "code": "WORKSPACE_NOT_FOUND",
    "message": "Workspace를 찾을 수 없습니다",
    "timestamp": "2026-03-25T10:30:00Z"
  }
}
```

| 에러 코드 | HTTP | 설명 |
|-----------|------|------|
| `WORKSPACE_NOT_FOUND` | 404 | 존재하지 않는 Workspace |
| `TAB_NOT_FOUND` | 404 | 존재하지 않는 탭 |
| `TAB_LIMIT_EXCEEDED` | 409 | Workspace당 8개 탭 초과 |
| `WORKSPACE_LIMIT_EXCEEDED` | 409 | 최대 Workspace 수 초과 |
| `SESSION_LIMIT_EXCEEDED` | 409 | 전체 PTY 세션 32개 초과 |
| `LAST_WORKSPACE` | 409 | 마지막 Workspace 삭제 시도 |
| `INVALID_NAME` | 400 | 빈 문자열 또는 32자 초과 |

### 5.4 config.json5 추가 설정

```json5
{
  workspace: {
    dataPath: "./data/workspaces.json",   // 상태 파일 경로
    maxWorkspaces: 10,                     // 최대 Workspace 수
    maxTabsPerWorkspace: 8,                // Workspace당 최대 탭 수
    maxTotalSessions: 32,                  // 전체 PTY 세션 상한
    flushDebounceMs: 5000,                 // 디스크 저장 debounce (ms)
  }
}
```

---

## 6. 비기능 요구사항

### NFR-701: 성능

| 항목 | 기준 |
|------|------|
| 그리드 리사이즈 반응 | 드래그 중 16ms 이내 렌더링 (60fps) |
| Workspace 전환 | 200ms 이내 뷰 전환 완료 |
| 탭/그리드 모드 전환 | 200ms 이내 애니메이션 포함 전환 |
| Breathing 애니메이션 | GPU 가속, 메인 스레드 블로킹 없음 |
| Metadata Bar 경과 시간 | `setInterval(1000)`, 8행 동시 업데이트 시 1ms 이내 |
| 비활성 Workspace 최적화 | xterm.js 인스턴스 DOM detach, 버퍼 유지 |
| 동시 PTY 세션 | 32개 동시 실행 시 서버 메모리 2GB 이내 |

### NFR-702: 호환성

| 항목 | 기준 |
|------|------|
| 브라우저 | Chrome 90+, Firefox 90+, Safari 15+, Edge 90+ |
| 해상도 | 320px (모바일) ~ 3840px (4K) |
| 입력 | 마우스, 터치, 키보드 |

### NFR-703: 보안

기존 보안 체계(HTTPS, JWT, 2FA, 파일 경로 보안)를 그대로 유지한다.

| 항목 | 기준 |
|------|------|
| Workspace API | 기존 JWT 인증 미들웨어 적용 (`authMiddleware`) |
| Workspace SSE | JWT 인증 쿼리 파라미터 지원 |
| 서버 JSON 파일 | `mode: 0o600` (서버 프로세스만 읽기/쓰기) |
| Workspace 삭제 | 다른 클라이언트에 사전 경고 후 삭제 |

### NFR-704: 접근성

| 항목 | 기준 |
|------|------|
| Workspace 전환 | `Ctrl+Shift+1~9`로 Workspace 전환 |
| 탭 전환 | `Ctrl+1~8`로 탭 전환 |
| 색상 대비 | 8색 팔레트 모두 WCAG AA (4.5:1 이상) 충족 |
| 탭 ARIA | `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls` |
| Workspace ARIA | `role="listbox"`, `role="option"`, `aria-selected` |
| 포커스 관리 | 탭 닫기 후 인접 탭 포커스, 모달 포커스 트랩, 드로어 포커스 트랩 |
| `prefers-reduced-motion` | Breathing 효과 비활성화 → 정적 초록 테두리만 표시 |
| 상태 변경 알림 | `aria-live="polite"` 영역에 `running`/`idle` 상태 변경 알림 |

### NFR-705: 네트워크 단절 처리

| 항목 | 기준 |
|------|------|
| SSE 재연결 | exponential backoff (1초→2초→4초→...최대 30초) |
| 오프라인 배너 | 상단에 "연결 끊김 — 재연결 중..." 경고 배너 표시 |
| 재연결 성공 시 | `GET /api/workspaces`로 최신 상태 재동기화, 배너 제거 |
| API 호출 실패 | 재시도 1회 후 에러 토스트 표시 |

---

## 7. 인수 조건

### AC-701: Workspace 관리

- [ ] Workspace를 생성하면 빈 상태로 시작한다
- [ ] Workspace 전환 시 이전 PTY 세션이 계속 실행된다 (출력 누적 확인)
- [ ] Workspace 삭제 시 소속 PTY 세션이 모두 종료된다
- [ ] Workspace 이름 변경과 순서 변경이 서버에 즉시 반영된다
- [ ] 마지막 Workspace는 삭제할 수 없다
- [ ] 최대 10개 Workspace 초과 시 생성이 차단된다

### AC-702: 탭 시스템

- [ ] 탭 추가 시 8색 중 순서대로 색상이 할당된다
- [ ] 9번째 탭 추가가 차단된다
- [ ] 탭을 롱프레스 드래그하여 순서를 변경할 수 있다
- [ ] 탭 색상이 TabBar, Grid 셀, Metadata Bar에 동일하게 표시된다
- [ ] 활성 탭을 닫으면 우측 인접 탭이 활성화된다
- [ ] 마지막 탭을 닫으면 빈 상태 UI가 표시된다
- [ ] 탭 이름을 더블클릭으로 인라인 편집할 수 있다

### AC-703: Tab/Grid 모드

- [ ] 데스크톱에서 탭/그리드 전환 토글이 동작한다
- [ ] 모바일에서 전환 토글이 숨겨지고 항상 탭 모드이다
- [ ] Grid Mode에서 터미널 수에 맞게 격자가 자동 배치된다
- [ ] 격자 셀 경계를 드래그하여 크기를 조절할 수 있다
- [ ] 그리드 내에서 롱프레스 드래그로 터미널 위치를 교환할 수 있다
- [ ] 빈 셀에 `+` 아이콘이 표시되고 클릭 시 탭이 추가된다
- [ ] 브라우저 윈도우 리사이즈 시 그리드가 자동 재조정된다

### AC-704: 에이전트 상태 표시

- [ ] `running` 상태 터미널에 초록 테두리와 breathing 효과가 표시된다
- [ ] `idle` 상태 전환 시 테두리와 효과가 사라진다
- [ ] `prefers-reduced-motion` 설정 시 정적 테두리만 표시된다
- [ ] Workspace 목록에 활성 세션 수 뱃지가 정확히 표시된다

### AC-705: 메타데이터 바

- [ ] 각 탭의 세션 이름, 컬러 라벨, 경과 시간, 복사 버튼이 표시된다
- [ ] 복사 버튼 클릭 시 CWD 경로가 클립보드에 복사된다
- [ ] 경과 시간이 실시간으로 업데이트된다

### AC-706: 서버 상태 저장 및 복구

- [ ] 브라우저 새로고침 후 모든 Workspace/탭/레이아웃이 복원된다
- [ ] 다른 브라우저에서 접속 시 동일한 레이아웃이 표시된다
- [ ] IndexedDB 관련 코드가 완전히 제거되었다
- [ ] 서버 재시작 후 `disconnected` 탭에 재시작 UI가 표시된다
- [ ] 재시작 버튼 클릭 시 새 PTY 세션으로 복구된다
- [ ] `workspaces.json` 손상 시 백업에서 복구된다

### AC-707: 기존 기능 제거 확인

- [ ] SplitPane 관련 컴포넌트/훅/유틸이 제거되었다
- [ ] 파일 뷰어 탭 기능이 제거되었다
- [ ] Prefix Mode(Ctrl+B) 키보드 단축키가 제거되었다

### AC-708: 에지 케이스

- [ ] PTY 비정상 종료 시 탭에 에러 오버레이 + 재시작 버튼이 표시된다
- [ ] 네트워크 단절 시 오프라인 배너가 표시되고 SSE가 자동 재연결된다
- [ ] 전체 PTY 세션 32개 도달 시 모든 Workspace에서 탭 추가가 차단된다

---

## 8. 마이그레이션 전략

### 8.1 단계적 전환

| 단계 | 내용 | 제거 포함 |
|------|------|-----------|
| 1 | 서버 WorkspaceService + REST API + SSE 엔드포인트 구현 | — |
| 2 | 프론트엔드 `useWorkspaceManager` 훅 + 상태 관리 | — |
| 3 | 좌측 패널 Workspace 목록 UI 전환 (모바일 드로어 포함) | — |
| 4 | Tab/Grid 듀얼 뷰 모드 구현 | SplitPane 코드 + IndexedDB 코드 제거 |
| 5 | 에이전트 상태 표시 (breathing 효과) | — |
| 6 | Metadata Bar 구현 | StatusBar 제거 |
| 7 | 서버 재시작 복구 프로토콜 + 탭 비정상 종료 처리 | — |
| 8 | 파일 뷰어 탭 코드 제거 + 최종 정리 | 파일 뷰어 코드 제거 |

### 8.2 하위 호환성

이번 Step은 **피벗**이므로 이전 버전과의 하위 호환성을 유지하지 않는다. 기존 IndexedDB 데이터는 마이그레이션 없이 폐기한다. 기존 `/api/sessions/*` API는 유지하되, Workspace API를 통하지 않는 직접 세션 생성은 orphan 세션이 되므로 프론트엔드에서는 항상 Workspace API를 사용한다.
