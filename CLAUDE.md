# BuilderGate

코딩 에이전트 병렬 운용을 위한 웹 기반 통합 개발 환경. 상세 비전은 [PRD.md](./PRD.md) 참조. 프로젝트 구조는 [구조 문서](./docs/struct/2026-04-02/00.index.md) 참조 — 단 그 문서의 포트 표기(4242/4545)는 구식이며 아래 Rules 의 2222 가 우선한다.

## 목적

브라우저 하나로 다수의 셸 세션을 관리하고, 세션 간 에이전트 명령을 중계한다. 파일 탐색/편집은 목표이나 현재 UI 로는 도달할 수 없다(아래 참조). 최종 목표는 원격에서 N개 코딩 에이전트를 동시 운용하여 병렬 개발을 수행하는 것.

- 웹 터미널 (다중 세션/탭, PTY 기반) — 현재 렌더 트리에 연결된 주 기능
- MCP 통합 — 가동 중 (`McpControlDialog`, `McpControlService`)
- 세션 간 에이전트 오케스트레이션 — 가동 중 (`AgentLifecycleService`, agent profile, webhook)
- Mdir 스타일 파일 매니저 — 코드는 있으나 `App.tsx` 에 연결되어 있지 않음 (Project Structure 하단 주석 참조)
- 마크다운/코드 뷰어 — 커밋 `b37728a` 에서 제거됨. 잔존 배선 있음 (`hooks/useFileContent.ts`, `utils/viewableExtensions.ts`, `MdirPanel` 의 `onOpenViewer`) + 미사용 의존성 `react-markdown`/`mermaid`/`highlight.js`/`rehype-highlight`/`remark-gfm`
- Task 관리자 — 예정

## Quick Start

```bash
node dev.js --port 2222   # 서버(2222) + 프론트(2223) 동시 실행
```

**dev 서버는 항상 2222 포트를 사용한다** (`--port 2222`, 프론트는 `serverPort+1`=2223). 브라우저·실측·health 체크 모두 2222 기준으로 한다.
브라우저에서 `https://localhost:2222` 접속. 서버 상태 확인: `curl -k https://localhost:2222/health`
- 비밀번호 1234 — E2E 기본값(`frontend/tests/e2e/helpers.ts` 의 `BUILDERGATE_PASSWORD || '1234'`). `config.json5` 의 저장값은 암호화되어 있어 그 파일로는 확인할 수 없다
- 코드 수정하면 자동으로 갱신됨

## Tech Stack

- **Backend**: Node.js + Express + TypeScript, node-pty, JWT auth
- **Frontend**: React 19 + TypeScript, Vite 7, xterm.js 6
- **Communication**: WebSocket (`/ws`, 양방향) — 터미널 입력·출력·resize 모두 WS 로 전송
- **Config**: `server/config.json5` (JSON5 + Zod validation)

## Project Structure

```
server/src/
  services/SessionManager.ts   # PTY 세션 관리 + 출력 브로드캐스트
  services/FileService.ts      # 파일 탐색/CRUD
  services/AuthService.ts      # JWT 인증
  ws/WsRouter.ts               # WebSocket 라우팅 (터미널 입력/출력/resize)
  routes/sessionRoutes.ts      # REST API (세션 생성/삭제)
  routes/fileRoutes.ts         # 파일 API

frontend/src/
  components/Terminal/          # xterm.js 래퍼
  contexts/WebSocketContext.tsx # WS 연결/재연결 상태
  hooks/useWorkspaceManager.ts  # 워크스페이스·탭 상태

# 아래는 현재 App.tsx 렌더 트리에 연결되어 있지 않다
# (사장 코드, 2026-08-14 import 그래프 전수 — main.tsx 기점 도달 127 / 전체 152)
#   frontend/src/hooks/       useSession.ts, useTabManager.ts, useKeyboardNav.ts,
#                             useCwd.ts, useFileContent.ts, useLayoutMode.ts, useFileBrowser.ts
#   frontend/src/components/  FileManager/, Sidebar/, StatusBar/,
#                             Modal/ShellSelectModal.tsx, MetadataBar/index.ts
#   frontend/src/utils/       viewableExtensions.ts, splitWebSocketLifecycle.ts
#   Grid/EmptyCell.tsx — Grid/index.ts 배럴이 재수출하나 렌더 사이트가 없어
#                        프로덕션 번들에서 tree-shake 됨
```

## Rules

- **dev 서버 포트는 항상 2222** — `node dev.js --port 2222`로 실행하며, health/브라우저 접속은 `https://localhost:2222`. 4242·4545·2002 등 다른 포트로 접속 시도 금지
- **`kill {pid}`** 또는  **`taskkill /F /IM node.exe` 절대 금지** — dev.js가 hot reload로 자동 재시작함
- **스크린샷 저장 경로**: `.playwright-mcp/` (루트에 png 파일 두지 말 것)
- **보안**: HTTPS + JWT + 2FA(선택) + 파일 경로 보안. localhost 전용
- **연구·계획은 항상 서브에이전트로 수행한다.** 코드베이스 조사, 근본 원인 분석, 설계/구현 계획 수립 등 연구·계획 성격의 작업은 메인 세션에서 직접 하지 않고 서브에이전트에 위임한다. 이때 모델은 opus5 를 사용한다.
- **코드 주석(comment)은 검증(리뷰) 범위에서 제외한다.** 서브에이전트 기반 검증·리뷰는 동작·정확성·회귀에 집중하고, 주석 문구의 정확성/과장 여부는 finding으로 보고하지 않는다. 주석만 문제라면 fair-scheduler provenance-pinned 파일이라도 그것만으로 수정·republish 사이클을 돌리지 않는다.

## 테스트 규칙 (필수)

**모든 버그 픽스는 반드시 테스트를 작성해야 한다. 테스트 없이 버그 픽스를 완료로 간주하지 않는다.**

### 백엔드 단위/통합 테스트

**테스트 표면이 여러 곳으로 흩어져 있다. 회귀를 보려면 아래를 전부 돌려야 한다.**

| 스위트 | 위치 | 실행 |
|---|---|---|
| 모놀리식 러너 | `server/src/test-runner.ts` (자기완결형, `*.test.ts` 를 디스커버리하지 않음) | **cwd=`server/`** 에서 `npx tsx src/test-runner.ts` |
| node:test (server) | `server/src/**/*.test.ts` (60개, 2026-09-03 실측) | **cwd=`server/`** 에서 `npx tsx --test src/<경로>.test.ts` — 파일별 |
| daemon | `tools/daemon/*.test.js` (19개) | 루트 `npm run test:daemon` (server 빌드 선행) |
| wave3 closure | `tools/wave3/fair-readmission-closure-v3*.test.mjs` (22개, node:test — 그중 게이트는 `admission-gate`·`boundary-gate` 2개) | `node --test tools/wave3/<파일>` — npm 스크립트 없음. **게이트 2개는 형제를 재실행하니 아래 주의 참조** |
| wave3 증거 스크립트 | `tools/wave3/{authority-promotion-evidence, canary-admission-evidence, fair-scheduler-decision, retained-shadow-parity, terminal-resource-consumer-manifest}.test.mjs` (5개, **node:test 아님**) | `node tools/wave3/<파일>` (일부는 `--regenerate-green` 등 플래그를 받음) |
| wave1 | `tools/wave1/g1-decision-gate.test.mjs` (1개) | `node --test tools/wave1/g1-decision-gate.test.mjs` — 스크립트 없음 |
| server tools | `server/tools/*.test.{cjs,mjs}` (2개, node:test) | `node --test server/tools/<파일>` — 스크립트 없음 |

주의할 것:

- **exit code 를 회귀 신호로 믿을 수 없는 파일이 있다.** `server/src/ws/WsRouterSplitHandshake.test.ts` 는 `tests 28 / pass 14 / fail 0 / todo 14` 로 **exit 0** 을 반환하지만, 그 todo 14개는 실제로 assertion 이 깨진 채 `✖ failing tests:` 에 찍힌다(`3 !== 1` 등, 전부 "Wave-1 production unified limitation characterization"). 나중에 진짜로 green 이 되어도 exit code 는 그대로 0 이다 → **todo 카운트와 `✖` 목록을 대조**해야 한다 (2026-08-19 실측).
- **소스 텍스트를 읽어 계약을 단언하는 테스트는 `src/` 전용이다. `dist/` 로 돌리면 깨진다.** `new URL('./X.ts', import.meta.url)` 로 형제 원본을 읽는데 `dist/` 에는 `.d.ts` 만 있고 `.ts` 소스가 복사되지 않기 때문이다. 해당 파일은 넷이다: `TerminalAuthorityController.test.ts`, `TerminalResourcePolicyCanary.test.ts`, `benchmarks/terminalFairnessCharacterization.test.ts`, `TerminalAuthorityProductionRegression.test.ts`. 전부 위 표의 커맨드(`npx tsx --test src/…`)로 돌려야 한다. 오늘 빌드본으로 실측하면 `node --test dist/services/TerminalAuthorityController.test.js` 는 4건, `…/TerminalResourcePolicyCanary.test.js` 는 10건이 `ENOENT` 로 실패한다 (2026-09-02). `TerminalResourcePolicyCanary.test.ts:29` 는 아예 `.ts` 원본의 실재를 `assert.equal(MODULE_PRESENT, true, …)` 로 단언하므로 설계상 `src/` 를 전제한다.
- **서버를 실제로 띄우는 테스트가 하나 있다.** `server/src/ws/terminalWireFormatBoot.test.ts` 는 임시 설정으로 `src/index.ts` 를 자식 프로세스로 부팅해 바이너리 협상 응답을 관측한다. 설정 파일에서 `config` 객체를 거쳐 라우터까지 이어지는 구간은 이 방식으로만 실행되며(`config` 가 모듈 최상위 `export const config = loadConfig()` 이고 `index.ts` 가 부트스트랩을 export 하지 않는다), 그 구간의 회귀는 `realtimeSchema` 가 `defaultObject` 라서 **에러 없이 조용히 `json` 으로 수렴한다**. 3케이스에 약 20초가 들고 케이스마다 인접한 두 포트(`PORT` 와 `PORT-1`)를 20000~40000 에서 잡는다. 저장소에는 아무것도 쓰지 않는데, **그것을 지키는 장치가 둘로 나뉘어 있다.** `server/data/` 아래 상태 파일들은 `process.cwd()` 기준 상대 경로이므로 `spawn` 의 `cwd` 가 지키고(`CommandPresetService.ts:18` 외 7곳), `server/certs/` 는 `BUILDERGATE_SERVER_ROOT` 가 가리키는 곳을 본다. 인증서가 이미 있고 유효하면 `SSLService.ts:123-137` 이 재사용만 하므로 변수를 빠뜨려도 당장은 쓰기가 없다(2026-09-03 실측). 인증서가 없으면 그 자리에 새로 쓰며(임시 루트에서 실측), 만료 시 동작은 `SSLService.ts:141-191` 의 코드 근거일 뿐 실측하지 않았다. **둘 중 하나만 챙기면 안 된다.**
- **스위트가 서로를 spawn 한다. 격리돼 있지 않다.** (아래는 확인된 것이며 닫힌 목록이 아니다)
  - `tools/wave3` 증거 스크립트들이 `server/src` 테스트, `frontend/tests/unit` 테스트, 다른 wave3 파일을 직접 실행한다.
  - **재귀 게이트**: `fair-readmission-closure-v3.admission-gate.test.mjs` 가 형제 closure 스위트 **21개 전부**를 `node --test` 로 재실행한다(약 113초). 이것과 형제 20개를 함께 파일별로 돌리면 **중첩 2단계로 중복 실행**된다.
  - ⚠️ **`boundary-gate.test.mjs` 는 형제를 재실행하지 않는다 — 공허하게 통과한다** (2026-08-19 Node 24 실측, 최소 프로브로 재현). `:35` 의 `spawnSync` 에 `env` 지정이 없어 **`NODE_TEST_CONTEXT` 를 그대로 상속**하고, node 의 재귀 가드가 `skipping running files` 로 **0개 실행 후 exit 0** → `assert.equal(status, 0)` 이 공허 통과한다. 게이트 내부 소요 **84ms** vs 같은 9개를 셸에서 직접 돌린 **35,466ms** 가 그 증거다. `admission-gate` 는 `:63` 에서 `NODE_TEST_*` 를 필터링해 정상 동작하며, **그 한 줄이 두 게이트의 유일한 차이**다. 즉 boundary-gate 의 green 은 형제 9개에 대한 증거가 아니다.
  - `authority-promotion-evidence.test.mjs` 는 **Playwright E2E 까지 실행**한다 (`frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts`, `PLAYWRIGHT_BASE_URL=https://localhost:2222`, headless). 2222 에 서버가 없으면 `start.bat` 이 프로덕션 서버까지 띄운다 (아래 E2E 절의 `reuseExistingServer` 주의와 연결됨).
  - `fair-scheduler-decision.test.mjs` 는 테스트가 아니라 벤치마크 소스(`server/src/benchmarks/terminalFairnessCharacterization.ts`)를 실행한다.
  - **역방향도 있다**: `server/src/services/TerminalResourcePolicy.test.ts` 가 `tools/wave3/terminal-resource-policy-differential.ts` 를 `execFileSync` 로 실행한다.
- **server build 를 트리거하는 명령이 매우 많다.** (아래도 닫힌 목록이 아니다)
  - `npm --prefix server test` (= build + `dist/test-runner.js`)
  - 루트 `npm run test:daemon`
  - **`npx playwright test`** — `frontend/tests/e2e/wave1-split-characterization.spec.ts` 가 server `npm run build` 를 실행한다
  - `start.bat` / `tools/start-runtime.js` — dist 부재 시 **frontend → server** 순으로 빌드 (frontend 가 실패하면 server build 는 아예 도달하지 않는다)
  - **루트의 build 계열 스크립트 18개 전부** — `npm run build`(=`build:daemon-all`), `build:daemon-exe`, `build:pkg:*`, `build:{platform}` 등이 모두 `ensureBuildArtifacts()` 를 거쳐 server build 를 실행한다. CI(`release.yml`) 도 이 경로를 탄다. `ensureBuildArtifacts()` 역시 **frontend → server** 순이므로 위의 "frontend 실패 시 server build 미도달" 함정이 이 18개와 CI 전체에 적용된다
  - build 파이프라인: `prebuild: ensure-node-pty-windows-hide.cjs` → `tsc` → `write-fair-scheduler-source-provenance.mjs` → `write-fair-scheduler-evidence-bundle.mjs` → `cpSync(src/shell-integration → dist/shell-integration)`. 산출물은 gitignored `server/dist/**` 이며 추적 파일을 바꾸지 않는다.
  - **함정**: evidence-bundle 이 `docs/analysis/terminal-fairness-authority/` 의 sha256 매니페스트를 재검증하고 불일치 시 throw 한다 → **build 실패**. 그러면 위의 **테스트 명령·로컬 빌드·릴리스 빌드·CI 가 전부 깨진다.** 테스트 코드와 무관한 이유로 red 가 되므로, 테스트가 깨졌다고 진단하기 전에 build 로그를 먼저 볼 것.
  - 테스트만 돌릴 의도라면 cwd=`server/` 에서 `npx tsx src/test-runner.ts` (build 를 타지 않음). 단 이 러너는 `*.test.ts` 를 디스커버리하지 않으므로 이것만으로는 회귀 커버리지가 되지 않는다.

**루트에는 `test` 스크립트가 없다** — `npm test` 는 루트에서 `Missing script` 로 실패한다. server 용은 `npm --prefix server test`. 루트의 test 스크립트 4개(`test:daemon`, `test:daemon:wave5`, `test:docs`, `test:integration:native-daemon`)는 전부 `tools/daemon/` 만 겨냥한다. 어느 한 명령을 돌리고 "테스트 통과"로 보고하지 말 것.

- **규칙**:
  1. 버그를 재현하는 실패 케이스 테스트 추가
  2. 버그 픽스 후 통과 케이스 테스트 추가
  3. 경계값(예: 설정 false일 때 기존 동작 유지) 테스트도 추가
  4. `makeAuthHarness` 등 기존 하네스 확장 시 모든 기존 테스트와의 호환성 유지

### E2E 테스트
- **기존 자산**: `frontend/tests/e2e/` 에 `*.spec.ts` 30개, `frontend/tests/unit/` 56개, `frontend/tests/benchmarks/` `*.test.ts` 2개. 설정은 `frontend/playwright.config.ts`. **새로 짜기 전에 기존 spec 을 먼저 확인한다.**
- **실행**: frontend 에서 `npx playwright test [spec]` — 수집 대상은 **30개 파일 / 465 테스트**다 (project 3종 `Desktop Chrome`·`Mobile Safari`·`Tablet` 을 전부 돌기 때문). 저장소의 `test:e2e:*` 스크립트는 전부 `--project "Desktop Chrome"` 로 고정돼 있다. MCP playwright 도구는 대화형 확인용 보조 수단.
- **Playwright 가 안 돌리는 것** (전부 node:test 이므로 **cwd=`frontend/`** 에서 `node --experimental-strip-types --test <파일>` 로 직접 실행):
  - `tests/unit/` 56개 — `testDir` 이 `./tests/e2e` 라 수집 대상이 아니다.
  - `tests/benchmarks/` 2개 — 같은 이유. 이것을 도는 npm 스크립트도 없다.
  - `tests/e2e/wave1-characterization-artifacts.test.ts` — `tests/e2e/` 안에 있지만 `node:test` 파일이라 Playwright 가 **0건 수집**한다. 이것을 도는 npm 스크립트가 없으므로 위 커맨드로 직접 돌려야 한다.
- **주의**: `playwright.config.ts` 의 `reuseExistingServer: true` 때문에 2222 에 이미 떠 있는 서버가 있으면 그것을 그대로 쓴다. `webServer` 는 `start.bat` 으로 **프로덕션 빌드**를 띄우므로, `dev.js` 가 떠 있는 상태로 돌리면 dev 번들을 검사하게 된다.
- **규칙**:
  1. UI/브라우저 동작에 영향을 주는 버그 픽스는 E2E 테스트 필수
  2. 서버 실행 상태에서 `https://localhost:2222` 대상으로 테스트
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

`snoworca-*` 접두사 스킬을 통해 수행한 작업은 스킬 자체가 completion-report를 생성하므로 **별도 수정 완료 보고서(docs/report/)를 작성하지 않는다.** 단, JSONL 작업 로그는 기록한다.

## API (주요)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/sessions` | 세션 생성 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |
| WS | `/ws` | PTY 입력·출력·resize (구 `/:id/input`·`/:id/stream` 대체) |
| GET | `/api/sessions/:id/files` | 파일 목록 |
| GET | `/health` | 상태 확인 |

# SpecKiwi SRS workflow v1.9

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

Work-mode and the TDD First (tdd) workflow:
1. Before starting work, read the persisted work-mode with the MCP `get_work_mode` tool, or CLI `speckiwi mode` when MCP is unavailable (stored in `docs/spec/steps/state.md`). When no mode is set the mode is wait and the sdd (SRS-first) rules in this document apply.
2. Switch modes with the MCP `set_work_mode` tool (mode plus an optional activeTask for vibe/tdd) or CLI `speckiwi mode <value>`. Any mode may switch to any other of sdd, vibe, wait, and tdd; switching to sdd or wait drops a stale Active Task line, and an out-of-enum value is rejected with INVALID_MODE.
3. When the mode is `tdd`, step-scoped work follows the TDD First cycle: author the step SDS at `docs/spec/steps/<task>/design.md` per the installed SDS-MD Authoring Rules (`docs/rule/SDS-MD-Rules-v2.5.0.md`) with EARS acceptance contracts (SDS-AC), translate the SDS-ACs into failing tests and confirm they fail, implement the smallest change to green, run regression, then synthesize the step SRS and promote the step requirement with verification evidence.
4. tdd gates (all mandatory): do not write tests before the step's SDS exists; commit tests first and never weaken a test to reach green; never promote a step requirement without verification evidence.
5. In tdd mode the rule "do not implement behavior not covered by an SRS requirement" is satisfied for step-scoped work by the agreed SDS plus the mandatory post-hoc promotion; body-scope work keeps the sdd rules in this document.
6. Edits to existing body requirements and large architecture changes stay in sdd mode — never route them through a tdd step.

Scope SRS document naming:
1. A scope SRS document is named `docs/spec/{NN}.{scope-slug}.srs.md`, where `{NN}` is a two-digit ordering number. The full rules are in `docs/rule/SRS-MD-Rules-v2.5.0.md` §5.2.
2. Allocate `{NN}` as one above the highest number already present among the project's scope documents. The first scope document of a project is `01`, the next `02`. Do not number by tens.
3. Never reuse a number another scope document holds, and never renumber an existing document.
4. Prefer `speckiwi scaffold-scope <Name>:<PREFIX> --apply`, which allocates the number and registers the document in both index sections in one operation, over writing the file and the index rows by hand.

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

The Completed Work Log — inline in `docs/spec/00.index.md` §7 and its split history file `docs/spec/91.completed-work-log.md` — is a read-only summary for agents. Requirement Block status, Acceptance Criteria, Verification Evidence, and Change Notes remain the source of truth for completion.

<!-- /SpecKiwi SRS workflow -->
