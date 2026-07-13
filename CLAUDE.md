# BuilderGate

코딩 에이전트 병렬 운용을 위한 웹 기반 통합 개발 환경. 상세 비전은 [PRD.md](./PRD.md) 참조. 프로젝트 구조는 [구조 문서](./docs/struct/2026-04-02/00.index.md) 참조.

## 목적

브라우저 하나로 다수의 셸 세션을 관리하고, 파일 탐색/편집하며, 세션 간 에이전트 명령을 중계한다. 최종 목표는 원격에서 N개 코딩 에이전트를 동시 운용하여 병렬 개발을 수행하는 것.

- 웹 터미널 (다중 세션/탭, PTY 기반)
- Mdir 스타일 파일 매니저 + 마크다운/코드 뷰어
- Task 관리자 + MCP 통합 (예정)
- 세션 간 에이전트 오케스트레이션 (예정)

## Quick Start

```bash
node dev.js --port 2222   # 서버(2222) + 프론트(2223) 동시 실행
```

**dev 서버는 항상 2222 포트를 사용한다** (`--port 2222`, 프론트는 `serverPort+1`=2223). 브라우저·실측·health 체크 모두 2222 기준으로 한다.
브라우저에서 `https://localhost:2222` 접속. 서버 상태 확인: `curl -k https://localhost:2222/health`
- 비밀번호 1234
- 코드 수정하면 자동으로 갱신됨

## Tech Stack

- **Backend**: Node.js + Express + TypeScript, node-pty, JWT auth
- **Frontend**: React 18 + TypeScript, Vite, xterm.js
- **Communication**: SSE (server→client) + HTTP POST (client→server)
- **Config**: `server/config.json5` (JSON5 + Zod validation)

## Project Structure

```
server/src/
  services/SessionManager.ts   # PTY 세션 관리 + SSE 브로드캐스트
  services/FileService.ts      # 파일 탐색/CRUD
  services/AuthService.ts      # JWT 인증
  routes/sessionRoutes.ts      # REST API
  routes/fileRoutes.ts         # 파일 API

frontend/src/
  hooks/useSession.ts          # 세션 상태
  hooks/useSSE.ts              # SSE 연결
  hooks/useTabManager.ts       # 탭 상태 머신
  components/Terminal/          # xterm.js 래퍼
  components/FileManager/       # Mdir 스타일 파일 매니저
  components/Viewer/            # Markdown + Code 뷰어
```

## Rules

- **dev 서버 포트는 항상 2222** — `node dev.js --port 2222`로 실행하며, health/브라우저 접속은 `https://localhost:2222`. 4242·4545·2002 등 다른 포트로 접속 시도 금지
- **`kill {pid}`** 또는  **`taskkill /F /IM node.exe` 절대 금지** — dev.js가 hot reload로 자동 재시작함
- **스크린샷 저장 경로**: `.playwright-mcp/` (루트에 png 파일 두지 말 것)
- **보안**: HTTPS + JWT + 2FA(선택) + 파일 경로 보안. localhost 전용

## 테스트 규칙 (필수)

**모든 버그 픽스는 반드시 테스트를 작성해야 한다. 테스트 없이 버그 픽스를 완료로 간주하지 않는다.**

### 백엔드 단위/통합 테스트
- **위치**: `server/src/test-runner.ts`
- **실행**: `npx tsx src/test-runner.ts` (server 디렉토리에서)
- **규칙**:
  1. 버그를 재현하는 실패 케이스 테스트 추가
  2. 버그 픽스 후 통과 케이스 테스트 추가
  3. 경계값(예: 설정 false일 때 기존 동작 유지) 테스트도 추가
  4. `makeAuthHarness` 등 기존 하네스 확장 시 모든 기존 테스트와의 호환성 유지

### E2E 테스트
- **도구**: Playwright (MCP playwright 도구 사용)
- **규칙**:
  1. UI/브라우저 동작에 영향을 주는 버그 픽스는 E2E 테스트 필수
  2. 서버 실행 상태(`node dev.js`)에서 `https://localhost:4242` 대상으로 테스트
  3. 스크린샷은 `.playwright-mcp/` 디렉토리에 저장
  4. 테스트 시나리오는 실제 사용자 플로우를 따름 (로그인 → 기능 확인 → 로그아웃)

## 작업 로그 및 보고서

모든 작업은 완료 시 아래 두 가지를 기록한다.

### 1. 작업 로그 (JSONL)

- **경로**: `docs/worklog/{yyyy-mm-dd}.jsonl`
- **형식**: 한 줄에 하나의 JSON 객체
- **필드**:
  ```json
  {
    "timestamp": "ISO8601",
    "request": "사용자 요청 원문",
    "analysis": "문제 원인 분석 요약",
    "solution": "해결 방법 요약",
    "files_changed": ["변경된 파일 목록"],
    "commit": "커밋 해시 + 메시지"
  }
  ```

### 2. 수정 완료 보고서 (Markdown)

- **경로**: `docs/report/{yyyy-mm-dd}.{작업-내용-제목}.md`
- **내용**: 이슈 설명, 문제 원인, 해결 방법, 변경 파일, 커밋 정보

### 3. 기록 및 검증 절차

1. 작업 완료 후 Haiku 서브에이전트로 보고서 + JSONL 작성
2. 두 개의 Haiku 서브에이전트가 각각 보고서/로그를 검증 (A+~F 등급)
3. 모든 등급이 A+가 될 때까지 반복 개선

### 4. CLI 도구 사용법

```bash
# 작업 로그 추가
node tools/worklog.mjs add \
  --request "사용자 요청" \
  --analysis "문제 원인 분석" \
  --solution "해결 방법" \
  --files "file1.ts,file2.tsx" \
  --commit "abc1234 fix: 커밋 메시지"

# 오늘 로그 조회
node tools/worklog.mjs list

# 특정 날짜 로그 조회
node tools/worklog.mjs list 2026-04-03
```

### 5. 예외: snoworca-* 스킬 작업

`snoworca-*` 스킬(아래 목록)을 통해 수행한 작업은 스킬 자체가 completion-report를 생성하므로 **별도 수정 완료 보고서(docs/report/)를 작성하지 않는다.** 단, JSONL 작업 로그는 기록한다.

## API (주요)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/sessions` | 세션 생성 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |
| POST | `/api/sessions/:id/input` | PTY 입력 |
| GET | `/api/sessions/:id/stream` | SSE 스트림 |
| GET | `/api/sessions/:id/files` | 파일 목록 |
| GET | `/health` | 상태 확인 |

# SpecKiwi SRS 워크플로 v1.4

This repository uses `docs/spec/` as the required source of truth for requirements.

Before making any code, test, CLI, MCP, or documentation change, agents MUST:
1. Read `docs/spec/00.index.md`.
2. Find the relevant Requirement ID in the scope SRS files.
3. Mention the Requirement ID in the work summary.
4. If no matching requirement exists, stop and ask whether to create/update an SRS requirement first.

Requirement metadata has two separate lifecycle fields:
- `Status` tracks implementation and verification progress.
- `Stability` tracks requirement maturity and change-control maturity.

Agents MUST stop before implementing a non-discarded requirement with `Stability=draft` or `Stability=deprecated` unless the user explicitly overrides that workflow.

TDD principle:
- Agents MUST follow TDD for behavior changes: write or update a failing automated test for the relevant Requirement ID before implementation, make the smallest change to pass, then refactor while keeping tests green.
- If no meaningful automated test can be written, agents MUST stop before implementation and explain the exception and alternative verification evidence.

Agents MUST NOT:
- Implement behavior that is not covered by an SRS requirement.
- Create an alternate requirements source outside `docs/spec/`.
- Change requirement IDs manually.
- Mark requirements as verified without evidence.
- Introduce or invoke bulk-archive / bulk-finalize tooling that flips multiple requirements to `verified` or empties Active Target without per-requirement evidence and stability gate checks.

When SpecKiwi MCP tools are available, agents MUST use them for requirement lookup and safe SRS updates. If MCP is unavailable, use the `speckiwi` CLI.

Current work status workflow:
1. Read the active target with MCP `get_active_target`, or CLI `speckiwi active-target --json` if MCP is unavailable.
2. If `activeTarget` is empty, report that no active target is set and ask which target to use before making target-scoped changes.
3. Read `summary.countsByStatus`, `summary.countsByStability`, `summary.stabilityBlockers`, `summary.stabilityWarnings`, and `summary.newWorkCandidates` before selecting work.
4. Read open work with MCP `list_requirements` for `status=in_progress`, `status=blocked`, and `status=implemented`; CLI fallback is `speckiwi list --status <status> --json`.
5. Check missing verification evidence through `summary` or MCP `summarize_target` before saying work is complete.
6. Read recent completed work with MCP `list_completed_work`; CLI fallback is `speckiwi completed-work --json`.

Next target authoring workflow:
1. If the user asks to set the next target, first read the current Active Target and Target Map.
2. If the target is not registered, use a supported target-registration mutation such as MCP `set_active_target` with creation support, or CLI `speckiwi set-active-target <target> --create` when that option is available.
3. If the configured MCP/CLI cannot register the target, stop before target-scoped SRS changes and report the tool gap, unless the user explicitly authorizes a minimal SRS-MD patch.
4. After target assignment, confirm the resolved Active Target with MCP `get_active_target`, or CLI `speckiwi active-target --json` if MCP is unavailable.
5. When the user provides a target goal, record it with MCP `set_target_goal`, or CLI `speckiwi set-target-goal <target> --goal <text>` if MCP is unavailable.
6. For later SRS creation, omit the target only when the tool supports Active Target defaulting; otherwise pass the confirmed Active Target explicitly.
7. If the user provides an explicit different target for a requirement, the explicit target wins over Active Target.

Merge-time duplicate Requirement ID repair workflow:
1. Run `speckiwi validate --json` or MCP `validate_spec` first. Use repair only when `SRS-E002` duplicate Requirement ID diagnostics exist, or when a named duplicate ID is confirmed in parsed diagnostics.
2. Resolve normal Git conflict markers before repair. Then run MCP `diagnose_requirement_id_collisions` or CLI `speckiwi repair requirement-id-collisions diagnose --json`.
3. Select explicit keep and rename occurrences by `filePath`, `headingLine`, and `blockHash`. A duplicate ID alone is never enough to write.
4. Create a dry-run plan with MCP `plan_requirement_id_collision_repair` or CLI `speckiwi repair requirement-id-collisions plan --duplicate-id <id> --keep <file:line:blockHash> --rename <file:line:blockHash> [--replacement-id <id>|--allocate-next] --write-plan <path> --json`.
5. Apply only from the explicit plan or equivalent explicit mapping with MCP `apply_requirement_id_collision_repair` or CLI `speckiwi repair requirement-id-collisions apply --plan <path> --json`. `--ignore-lock` is allowed only on apply and bypasses only the SRS mutation lock.
6. Do not use collision repair for general renumbering, gap filling, ID beautification, bulk archive, bulk finalize, or Status/Stability changes. When two duplicate logical requirements should be merged or discarded, first repair IDs to uniqueness, then use separate guarded SRS mutations for discard, supersedes, Status, Stability, AC, or evidence changes.
7. When implemented runtime CLI or MCP repair tooling is available, do not hand-edit Requirement IDs. If tooling is unavailable and the user explicitly authorizes a degraded SRS-MD patch, limit it to the selected occurrence and explicitly mapped references.
8. Finish with `speckiwi validate --fail-on-warning --json`, `speckiwi summary --target <target> --json`, and `speckiwi links check --json` or MCP equivalents. Evidence must show duplicate IDs are zero and ambiguous references were reported or explicitly mapped.

Completed Work Log is a read-only summary for agents. Requirement Block status, Acceptance Criteria, Verification Evidence, and Change Notes remain the source of truth for completion.

<!-- /SpecKiwi SRS 워크플로 -->
