# Next Task Instruction: 팀장/팀원 MCP 협업 기능 SRS 업데이트

작성일: 2026-05-19 KST  
목적: 다음 작업에서 연구 결과를 바탕으로 SpecKiwi SRS를 업데이트한다.  
주 입력 연구문서: `C:/Work/git/_Snoworca/ProjectMaster/docs/report/2026-05-19.team-role-context-menu-mcp-completion-research.md`

## 작업 목표

팀장/팀원 세션 지정, MCP 기반 프롬프트 전달, `.buildergate` 팀 세션 상태 저장, 명시 완료 신호, 제한적 clear 도구 요구사항을 SRS에 반영한다.

다음 작업은 **구현이 아니라 SRS 업데이트**다. 코드 변경, UI 구현, MCP 서버 구현, hook CLI 구현은 하지 않는다.

## 반드시 먼저 읽을 문서

1. `docs/spec/00.index.md`
2. `docs/rule/SRS-MD-Rules-v1.0.0.md`
3. `docs/report/2026-05-19.team-role-context-menu-mcp-completion-research.md`
4. `docs/research/2026-05-19.team-session-mcp-completion-protocol-research.md`
5. `docs/report/2026-05-19.window-team-mcp-feasibility.md`
6. `docs/research/2026-05-10.agent-hook-status-signal-research.md`

## SRS 업데이트 방향

현재 `docs/spec/00.index.md`의 active target은 기존 터미널 컨텍스트 메뉴 범위다. 이번 기능은 별도 기능군이므로, SRS 업데이트 시 다음 중 하나를 명확히 선택한다.

- 새 target을 만든다. 예: `0.5.4-team-session-mcp`
- 기존 target에 포함해야 한다면 이유를 SRS change note에 남긴다.

가능하면 새 scope 또는 별도 requirement group으로 분리한다. 기존 컨텍스트 메뉴 등록 항목 요구사항과 섞어서 의미가 흐려지지 않게 한다.

## 반영할 핵심 요구사항

### 1. 팀 역할 지정

- 터미널 우클릭 컨텍스트 메뉴에 `팀장으로 지정`, `팀원으로 지정`, `팀 역할 해제` 동작이 정의되어야 한다.
- 팀장/팀원 지정 상태는 세션 우측 상단 역할 아이콘으로 표시되어야 한다.
- 팀 역할 상태는 기존 terminal runtime status인 `running | idle | disconnected`와 분리되어야 한다.
- 팀장 1명 제한 여부를 SRS에서 명확히 결정해야 한다. 권장: workspace 또는 team generation 단위로 팀장 1명.

### 2. 안정 세션 식별자

- `sessionId`는 PTY runtime id라 재시작/복구 시 바뀔 수 있으므로 장기 식별자로 쓰면 안 된다.
- 새 stable `sessionKey`를 요구사항으로 정의한다.
- `sessionNumber`는 사람에게 보여주는 alias일 뿐이며 권한이나 장기 식별자로 쓰면 안 된다.
- tab restart/orphan recovery 후에도 `sessionKey`는 유지되고 `currentSessionId`만 갱신되어야 한다.
- retired sessionKey 재사용 정책을 정의해야 한다.

### 3. `.buildergate` 저장

- 사용자가 말한 `.buldergate`는 `.buildergate`로 정규화한다.
- 1차 권장 위치는 runtime data root 아래다. 예: `server/data/.buildergate/team-sessions.json`
- 프로젝트 루트별 `.buildergate` 저장은 `Workspace.projectRoot` 개념이 없으므로 2차 범위로 두거나 별도 선행 요구사항으로 정의한다.
- JSON은 UTF-8, atomic write, backup/recovery, owner-only 권한 요구사항을 포함해야 한다.
- secret 원문은 `team-sessions.json`에 저장하지 않는다.

### 4. MCP 도구

1차 MCP tool 후보:

- `list_team_sessions`
- `get_team_session`
- `assign_session_role`
- `create_assignment`
- `deliver_agent_prompt`
- `submit_assignment_result`
- `get_assignment_status`

`deliver_agent_prompt`는 1차에서 paste-only를 기본으로 한다. Enter 포함 자동 제출은 별도 approval, audit, replay/input safety 검증을 갖춘 2차 범위로 둔다.

### 5. 완료 판정

SRS에 반드시 명시한다.

- `idle`은 완료 신호가 아니다.
- `Stop` hook은 작업 완료가 아니라 turn 종료 신호다.
- 화면 문자열, output quiet window, snapshot ACK, `session:ready`만으로 assignment를 완료 처리하면 안 된다.
- 완료는 `assignmentId`가 포함된 `submit_assignment_result` MCP tool 또는 검증된 `assignment-complete`/`assignment-failed` hook으로만 확정한다.

### 6. Hook fallback

- hook은 MCP 완료 신호의 fallback 또는 보강 신호로 정의한다.
- hook signal은 HMAC, nonce, sequence, TTL 검증을 거쳐야 한다.
- hook/MCP는 WebSocket `status`를 직접 broadcast하면 안 된다. 상태 원본은 계속 `SessionManager`다.

### 7. Clear 도구

단일 `clear` 도구는 금지한다. 의미가 다른 clear를 분리해서 SRS에 정의한다.

1차 허용 후보:

- `clear_team_role`: 역할만 해제한다. `sessionKey`와 audit은 보존한다. 활성 assignment가 있으면 거부하거나 먼저 cancel을 요구한다.
- `clear_session_prompt_state`: transient prompt/attention 표시만 초기화한다. assignment 상태나 PTY에는 영향이 없어야 한다.
- `clear_assignment`: draft 또는 완료된 assignment의 dismiss/archive만 허용한다. 실행 중 작업 삭제는 금지한다.

1차 제외:

- `clear_team_session_registry`: stable key 매핑과 assignment 추적을 깨므로 admin maintenance 전용 2차 기능으로 둔다. 필요하면 dry-run, backup, confirm, no-active-assignment 조건을 요구사항으로 남긴다.

## 필수 비기능 요구사항

- MCP write tool은 role/scope/approval을 검증해야 한다.
- `sessionNumber`만으로 write target을 확정하면 안 된다. 내부적으로 `sessionKey`로 resolve하고, 모호하면 거부한다.
- raw prompt 전문, JWT, hook secret, raw hook payload 전문은 기본 저장하지 않는다.
- audit log에는 actor, target sessionKey, assignmentId, prompt hash, byte length, safe preview, result, rejection reason을 남긴다.
- protocol/state/validation/lifecycle error는 silent fallback하지 않고 observable해야 한다.
- 기존 AGENTS invariant를 유지한다. AI TUI 사용자 입력, local echo, prompt redraw, cursor movement, waiting repaint는 `running` 전환 근거가 아니다.

## SRS Acceptance Criteria 초안

SRS 작성 시 아래 AC를 요구사항별로 구체화한다.

- Given a terminal tab, when the user selects `팀장으로 지정`, then the tab is marked as leader and a leader icon is visible on the terminal surface.
- Given a terminal tab, when the user selects `팀원으로 지정`, then the tab is assigned a stable `sessionKey` and a visible `sessionNumber`.
- Given a tab restart or orphan recovery, when the PTY `sessionId` changes, then the same `sessionKey` remains mapped to the new `currentSessionId`.
- Given an assignment is delivered, when the target session becomes `idle`, then the assignment is not marked completed unless an explicit completion signal is accepted.
- Given a worker calls `submit_assignment_result` with a valid `assignmentId`, when authorization and sequence checks pass, then the assignment is marked completed or failed.
- Given a `Stop` hook is received, when no explicit assignment completion signal is present, then the assignment remains awaiting completion.
- Given `deliver_agent_prompt` contains Enter/newline in 1차 범위, when submit approval is not present, then the delivery is rejected or treated as paste-only according to the SRS policy.
- Given `clear_team_role` is called for a session with active assignment, then the request is rejected or requires assignment cancellation first.
- Given `clear_session_prompt_state` is called, then assignment state, audit history, and PTY content are not deleted.
- Given `clear_team_session_registry` is requested in 1차 범위, then it is unavailable or admin-maintenance-only.

## 검증 계획 초안

SRS에는 다음 verification method를 포함한다.

- Unit tests for team session registry persistence, restart mapping, retired key rejection.
- Unit tests for MCP tool schema, role/scope checks, clear tool behavior.
- Unit tests for completion state machine: idle/Stop/snapshot ACK do not complete assignment.
- Unit tests for hook HMAC/nonce/sequence/TTL validation.
- Integration tests for paste-only `deliver_agent_prompt` through the safe input path.
- Playwright E2E against `https://localhost:2002` for two browser windows, role icons, assignment delivery, completion signal, and clear tool UI/API effects.

## 금지사항

- 구현하지 않는다.
- SRS 규칙을 우회하거나 `docs/spec` 외 별도 요구사항 source of truth를 만들지 않는다.
- `idle`을 완료로 취급하는 요구사항을 만들지 않는다.
- `sessionId`를 장기 target으로 정의하지 않는다.
- 단일 모호한 `clear` 도구를 정의하지 않는다.
- MCP/hook이 기존 WS `status`를 직접 바꾸도록 요구하지 않는다.

## 완료 조건

- `docs/spec`의 SRS 문서가 업데이트되어야 한다.
- 필요 시 `docs/spec/00.index.md`의 target/scope map도 업데이트되어야 한다.
- SpecKiwi MCP 또는 CLI로 SRS validation을 수행한다.
- AGENTS.md 규칙에 따라 최소 1개 서브에이전트 reviewer/evaluator 검증 결과를 확보한다.
- 최종 응답에 수정한 SRS 파일, target/scope 변경, validation 결과, 남은 결정사항을 요약한다.
