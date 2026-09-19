# BuilderGate

코딩 에이전트 병렬 운용을 위한 웹 기반 통합 개발 환경. 상세 비전은 [PRD.md](./PRD.md) 참조. 프로젝트 구조는 [구조 문서](./docs/struct/2026-04-02/00.index.md) 참조 — 단 그 문서의 포트 표기(4242/4545)는 구식이며 아래 Rules 의 2222 가 우선한다.

## 목적

브라우저 하나로 다수의 셸 세션을 관리하고, 세션 간 에이전트 명령을 중계한다. 파일 편집은 마크다운 편집기로 도달 가능하며, 파일 탐색(Mdir)은 아직 UI 로 도달할 수 없다(아래 참조). 최종 목표는 원격에서 N개 코딩 에이전트를 동시 운용하여 병렬 개발을 수행하는 것.

- 웹 터미널 (다중 세션/탭, PTY 기반) — 현재 렌더 트리에 연결된 주 기능
- MCP 통합 — 가동 중 (`McpControlDialog`, `McpControlService`)
- 세션 간 에이전트 오케스트레이션 — 가동 중 (`AgentLifecycleService`, agent profile, webhook)
- Mdir 스타일 파일 매니저 — 코드는 있으나 `App.tsx` 에 연결되어 있지 않음 (Project Structure 하단 주석 참조)
- 마크다운 편집기 — 가동 중 (`components/editor/`, CodeMirror 6 기반 `src/editor/` 벤더링). 모달리스 창으로 뜨며 세션 경로 우클릭에서 `CLAUDE.md`·`CLAUDE.local.md`·`AGENTS.md` 를 연다. 요구사항은 `docs/spec/41.markdown-editor.srs.md`
- 구 마크다운/코드 뷰어 — 커밋 `b37728a` 에서 제거됨. 잔존 배선 있음 (`hooks/useFileContent.ts`, `utils/viewableExtensions.ts`, `MdirPanel` 의 `onOpenViewer`) + 미사용 의존성 `react-markdown`/`mermaid`/`highlight.js`/`rehype-highlight`/`remark-gfm`
- Task 관리자 — 예정

## Quick Start

```bash
start.bat --port 2222
```

**검증 접속 포트는 항상 2222이다.** 아래 Rules와 현재 AGENTS의 소유권 사전검토를 따른다.
브라우저에서 `https://localhost:2222` 접속. 서버 상태 확인: `curl -k https://localhost:2222/health`
- 비밀번호는 **`BUILDERGATE_PASSWORD` 환경변수**로 넘긴다. 코드에 기본값이 없다(#57) — `frontend/tests/e2e/testPassword.ts` 의 `requireTestPassword()` 가 미설정 시 그 사실을 이름과 함께 던진다. `config.json5` 의 저장값은 암호화되어 있어 그 파일로는 확인할 수 없다. **값을 이 문서나 어떤 추적 파일에도 적지 않는다** — 조직 규정이 로컬 테스트 값에 예외를 두지 않고 이 저장소는 public 이다
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
  components/dialog/            # WindowDialog + modal/modeless 두 밴드 스택
  components/editor/            # 편집기 창 (배치·가시성·저장·닫기 판정)
  editor/                       # CodeMirror 6 벤더링 (atomic-editor, MIT)
  contexts/WebSocketContext.tsx # WS 연결/재연결 상태
  hooks/useWorkspaceManager.ts  # 워크스페이스·탭 상태
  hooks/useEditorWindows.ts     # 편집기 창 목록·복원·저장

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

- 현재 사용자 지시와 `AGENTS.md`의 프로젝트 목표·SRS·strict TDD·독립 리뷰·provenance·보존 규칙을 따른다. 진행 상태는 `docs/plan/2026-09-08.remaining-work-autonomous.plan.md`의 Resume를 읽는다. editor branch의 과거 실행 기록은 통합 상태의 검증 증거가 아니다.
- 실제 검증은 `start.bat --port 2222`와 `https://localhost:2222`를 사용한다. 임의 포트 병렬 레인 예외는 없다. TCP2001/2002 서버는 종료하거나 테스트에 사용하지 않는다.
- **TCP2002 는 이 프로젝트가 이 시스템에 실제로 배포되어 운영 중인 포트다. 2002 포트를 점유한 프로세스를 어떠한 경우에도 종료하지 않는다.** `stop.bat`·`stop.js`·내부 shutdown 엔드포인트·OS 수준 종료 모두 금지이며, 2002 를 멈춰야 검증이 진행되는 상황이라면 멈추지 말고 그 사실을 사용자에게 보고하고 지시를 기다린다. 2001 도 같은 프로세스가 함께 점유하므로(2026-09-10 실측: 하나의 PID 가 2001·2002 를 동시에 LISTENING) 2001 을 내리는 것이 곧 운영 중단이다 — 위 줄의 2001/2002 종료 금지는 그대로 유효하다. `tools/start-runtime.js` 는 다른 데몬이 떠 있으면 "A different BuilderGate daemon is already running" 을 내며 2222 로 뜨지 않는데, 그때 2002 를 내리는 것은 해결책이 아니다. 데몬을 거치지 않고 이 체크아웃의 `server/dist/index.js` 를 `NODE_ENV=production PORT=2222` 로 직접 띄우면 데몬 상태 파일을 건드리지 않고 검증할 수 있다. 그때 상속된 `BUILDERGATE_*` 는 설치본을 가리키므로 자식 환경에서 전부 제거하되 `NODE_ENV` 는 남긴다.
- 종료는 `stop.bat`를 우선하되 **범위를 명시한다**: `stop.bat --port 2222`. 포트를 대지 않으면 상속된 `BUILDERGATE_ROOT` 가 대상을 고르며, 그것이 설치본을 가리키면 운영 데몬(2001/2002)이 멈춘다(#50). 이 체크아웃 밖의 root 가 상속된 경우 `stop` 은 이제 거부하며, 정말 그 대상이면 `--root <dir>` 또는 `--allow-foreign-root` 로 말해야 한다. 정상 종료가 불가능한 TCP2222의 BuilderGate listener만 OS의 실제 owning PID, 실행 파일과 명령줄이 이 checkout 소유인지 검증한 후 그 PID 하나를 종료할 수 있다. 전체 Node 종료, process tree 종료, wrapper 취소/신호, 다른 node.exe 종료는 금지다. 포트가 이미 비었으면 잔여 프로세스를 종료하지 않는다.
- 환경 변수는 실행별로 확인하고 보호 guard/소유 경로 설정을 보존한다. 상속된 설정이 설치본을 가리키는지 확인하고, 필요한 변경은 검토된 child environment에만 적용한다. `BUILDERGATE_*` 일괄 삭제나 parent 환경 변경을 기본 절차로 사용하지 않는다. 실제 설정의 load/merge와 경로를 확인하며 비밀값을 출력하지 않는다.
- 원본 dirty/untracked/config 파일을 다른 worktree에 복사해 baseline을 만들지 않는다. 깨끗한 전용 checkout에서 검토된 소유 fixture를 만들고 정확한 입력 hash와 HEAD를 기록한다.
- 스크린샷은 `.playwright-mcp/`에 저장한다. UI는 요구된 editor 통합 외에 개인 판단으로 바꾸지 않는다. 연구·계획과 검증의 역할 분리 및 모델 선택은 현재 사용자/AGENTS 지시를 따른다.
## 테스트 규칙 (필수)

아래 날짜별 수치와 실패 서술은 병합 전 관찰 기록이다. 현재 통합 결과로 재라벨링하지 않는다. 현재 admission은 exact20 자식과 no-kill observer 계약이며 canonical bbf59ed에서3회 통과했다; 통합 source에는 새 검증이 필요하다. split은15 ordinary PASS/13 TODO의 기록이며 완료가 아니다. 표의 명령은 실행 surface 안내이지 안전성 검토 면제가 아니다.

**모든 버그 픽스는 반드시 테스트를 작성해야 한다. 테스트 없이 버그 픽스를 완료로 간주하지 않는다.**

### 백엔드 단위/통합 테스트

**테스트 표면이 여러 곳으로 흩어져 있다. 회귀를 보려면 아래를 전부 돌려야 한다.**

| 스위트 | 위치 | 실행 |
|---|---|---|
| 모놀리식 러너 | `server/src/test-runner.ts` (자기완결형, `*.test.ts` 를 디스커버리하지 않음) | **cwd=`server/`** 에서 `npx tsx src/test-runner.ts` |
| node:test (server) | `server/src/**/*.test.ts` (개수는 `find server/src -name '*.test.ts' \| wc -l`) | **cwd=`server/`** 에서 `npx tsx --test src/<경로>.test.ts` — 파일별 |
| daemon | `tools/daemon/*.test.js` (19개) | 루트 `npm run test:daemon` (server 빌드 선행) |
| wave3 closure | `tools/wave3/fair-readmission-closure-v3*.test.mjs` (21개, node:test — 그중 게이트는 `admission-gate` 1개) | `node --test tools/wave3/<파일>` — npm 스크립트 없음. **그 게이트는 형제 20개를 재실행하니 아래 주의 참조** |
| wave3 증거 스크립트 | `tools/wave3/{authority-promotion-evidence, canary-admission-evidence, fair-scheduler-decision, retained-shadow-parity, terminal-resource-consumer-manifest}.test.mjs` (5개, **node:test 아님**) | `node tools/wave3/<파일>` (일부는 `--regenerate-green` 등 플래그를 받음) |
| wave1 | `tools/wave1/g1-decision-gate.test.mjs` (1개) | `node --test tools/wave1/g1-decision-gate.test.mjs` — 스크립트 없음 |
| server tools | `server/tools/*.test.{cjs,mjs}` (3개, node:test) | `node --test server/tools/<파일>` — 스크립트 없음 |
| 릴리즈 파이프라인 가드 | `tools/build-portable-runtime-evidence.test.mjs`, `server/tools/canonical-authority-line-endings.test.mjs`, `server/src/benchmarks/FairSchedulerAuthorityGenerationPin.test.ts`, `server/src/utils/retiredSettingsResidue.test.ts` (15 케이스) | 루트 `npm run test:release-pipeline` — 넷을 한 번에 돈다. **릴리즈 빌드를 세 번 깨뜨린 것들을 지키는 가드이므로 릴리즈 전에 반드시 돌릴 것** |

주의할 것:

- **exit code 를 회귀 신호로 믿을 수 없는 파일이 있다.** `server/src/ws/WsRouterSplitHandshake.test.ts` 는 `fail 0` 으로 **exit 0** 을 반환하지만, 그 todo 들은 실제로 assertion 이 깨진 채 `✖ failing tests:` 에 찍힌다(`3 !== 1` 등, 전부 "Wave-1 production unified limitation characterization"). 나중에 진짜로 green 이 되어도 exit code 는 그대로 0 이다 → **todo 카운트와 `✖` 목록을 대조**해야 한다.
  - #77: 여기 있던 `pass 14 / todo 14` 를 지웠다. 그 숫자는 2026-08-19 실측이었고 오늘은 `pass 15 / todo 13` 이며, 이 문서를 고치는 동안에도 다시 움직인다. **대조해야 할 것은 어떤 숫자가 아니라 todo 카운트와 `✖` 목록이 서로 맞는지다.** 숫자를 적어두면 그 숫자가 기준처럼 읽히고, 틀린 기준은 없는 기준보다 나쁘다.
- **소스 텍스트를 읽어 계약을 단언하는 테스트는 `src/` 전용이다. `dist/` 로 돌리면 깨진다.** `new URL('./X.ts', import.meta.url)` 로 형제 원본을 읽는데 `dist/` 에는 `.d.ts` 만 있고 `.ts` 소스가 복사되지 않기 때문이다. 해당 파일은 `grep -rl "new URL('./" server/src --include=*.test.ts` 로 열거한다 — 알려진 것은 `TerminalAuthorityController.test.ts`, `TerminalResourcePolicyCanary.test.ts`, `benchmarks/terminalFairnessCharacterization.test.ts`, `TerminalAuthorityProductionRegression.test.ts` 이고 **닫힌 목록이 아니다**(#77: 넷이라고 적혀 있었으나 실측은 그보다 많다). 전부 위 표의 커맨드(`npx tsx --test src/…`)로 돌려야 한다. 오늘 빌드본으로 실측하면 `node --test dist/services/TerminalAuthorityController.test.js` 는 4건, `…/TerminalResourcePolicyCanary.test.js` 는 10건이 `ENOENT` 로 실패한다 (2026-09-02). `TerminalResourcePolicyCanary.test.ts:29` 는 아예 `.ts` 원본의 실재를 `assert.equal(MODULE_PRESENT, true, …)` 로 단언하므로 설계상 `src/` 를 전제한다.
- **서버를 실제로 띄우는 테스트가 하나 있다.** `server/src/ws/terminalWireFormatBoot.test.ts` 는 임시 설정으로 `src/index.ts` 를 자식 프로세스로 부팅해 바이너리 협상 응답을 관측한다. 설정 파일에서 `config` 객체를 거쳐 라우터까지 이어지는 구간은 이 방식으로만 실행되며(`config` 가 모듈 최상위 `export const config = loadConfig()` 이고 `index.ts` 가 부트스트랩을 export 하지 않는다), 그 구간의 회귀는 `realtimeSchema` 가 `defaultObject` 라서 **에러 없이 조용히 `json` 으로 수렴한다**. 3케이스에 약 20초가 들고 케이스마다 인접한 두 포트(`PORT` 와 `PORT-1`)를 20000~40000 에서 잡는다. 저장소에는 아무것도 쓰지 않는데, **그것을 지키는 장치가 둘로 나뉘어 있다.** `server/data/` 아래 상태 파일들은 `process.cwd()` 기준 상대 경로이므로 `spawn` 의 `cwd` 가 지키고(`CommandPresetService.ts:18` 외 7곳), `server/certs/` 는 `BUILDERGATE_SERVER_ROOT` 가 가리키는 곳을 본다. 인증서가 이미 있고 유효하면 `SSLService.ts:123-137` 이 재사용만 하므로 변수를 빠뜨려도 당장은 쓰기가 없다(2026-09-03 실측). 인증서가 없으면 그 자리에 새로 쓰며(임시 루트에서 실측), 만료 시 동작은 `SSLService.ts:141-191` 의 코드 근거일 뿐 실측하지 않았다. **둘 중 하나만 챙기면 안 된다.**
- **스위트가 서로를 spawn 한다. 격리돼 있지 않다.** (아래는 확인된 것이며 닫힌 목록이 아니다)
  - `tools/wave3` 증거 스크립트들이 `server/src` 테스트, `frontend/tests/unit` 테스트, 다른 wave3 파일을 직접 실행한다.
  - **재귀 게이트**: `fair-readmission-closure-v3.admission-gate.test.mjs` 가 형제 closure 스위트 **20개 전부**를 `node --test` 로 재실행한다. 이것과 형제 20개를 함께 파일별로 돌리면 **중첩 2단계로 중복 실행**된다. **병합 전 2026-09-03 관찰에서 그 게이트는 red였다** — 내부 118초 예산을 넘겨 `ETIMEDOUT` 으로 끝난다(2026-09-03 실측, 2회). 형제 아홉만 셸에서 직접 돌려도 181.7초가 걸리고 그중 `fair-readmission-closure-v3.wave.test.mjs:107` 의 `captureFrozenProvenance` 한 호출이 88.7초를 쓴다. 종료 양상은 부하에 따라 흔들려서, 예산을 넘기기 전에 형제 단언 실패로 끝나기도 한다.
  - ⚠️ **게이트가 형제를 재실행할 때는 `NODE_TEST_*` 를 걸러야 한다.** `node --test` 로 도는 프로세스는 `NODE_TEST_CONTEXT` 를 자식에게 물려주고, node 의 재귀 가드가 `skipping running files` 경고만 남긴 채 **0개 실행 후 exit 0** 을 낸다. 그러면 `assert.equal(status, 0)` 이 공허하게 통과하고 **stdout 이 빈 채로 남는다** — 그것이 유일한 관측 가능한 흔적이다. `admission-gate` 는 `:62` 의 `env` 필터로 이것을 막으며, 그 한 줄이 없으면 게이트가 아무것도 검증하지 않는다. 같은 결함으로 공허하던 `boundary-gate.test.mjs` 는 2026-09-03 에 제거되었고 현재의 exact20 계약은 별도 agreed successor에서 명시적으로 채택했다. 삭제 wrapper의 별도120초/경계제외 정책이 무손실로 자동 흡수됐다고 해석하지 않는다.
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

- editor branch의 2026-09-03 관찰은 E2E37파일/651 project-expanded cases(Desktop217), unit92파일과 타입 미등재 사례를 기록했다. 이는 역사적 수치이며 현재 통합 수집 수/통과 증거가 아니다. 새 테스트는 실제 tsconfig 입력에 포함되는지 확인한다. frontend root tsc만으로 앱/테스트 타입 검증을 주장하지 않는다.
- 기존 editor spec과 `workspace-ownership-validation.spec.ts`, `workspaceOwnershipFixture.ts`를 먼저 읽는다. 성공한 생성 응답의 ID만 소유하며 사용자/다른 테스트 workspace를 prefix나 quota 회복 목적으로 삭제하지 않는다. 시드는 각 spec의 소유권/초기상태 계약에 맞춰 만든다.
- 실제 브라우저는 검증된 외부 `https://localhost:2222`만 사용한다. 자동 webServer가 다른 인스턴스를 재사용하거나 시작하지 않게 검토하고, 앞뒤 health와 정확한 프로세스 정체성을 확인한다. 임의 포트로 우회하지 않는다.
- editor branch는 장시간 실행에서 서버 소실과 초기 seed 의존성을 관찰했다. 현재 실패 원인이나 고정 수명으로 단정하지 않는다. 실패 케이스가 달라진다는 이유로 제품 결함을 배제하거나 서버를 재시작하지 않는다. 실제 원시 로그·소유 상태로 원인을 조사한다.
- **2222 에 대한 Playwright 실행은 호스트 전역에서 한 번에 하나다. 실행 전 다른 `playwright test` 프로세스가 없는지 확인하고, 있으면 시작하지 않는다.** `workers: 1` 은 한 Playwright *프로세스* 안에서만 직렬화하며 두 프로세스에 대해서는 아무것도 하지 않는다. 동시에 도는 두 레인은 `test-results/`(Playwright 가 기동 시 통째로 지운다), workspace-ownership 레지스트리, 서버의 전역 workspace 목록과 라이브 세션 수를 공유한다 — 그래서 **한 레인이 다른 레인을 제품 결함처럼 보이는 이유로 실패시킬 수 있다.** 2026-09-19 실측: 한 레인의 기동이 다른 레인의 ownership 레지스트리를 실행 도중 삭제해 `ENOENT … test-results/.workspace-ownership/<runId>/run.json` → `AggregateError: Workspace ownership tracking failed` 로 끝났다. 단언은 전부 통과한 뒤 cleanup 경로에서 난 실패였다.
  - 사전 카운트를 **출력만 하고 진행하지 않는다.** 0 이 아니면 하드 스톱이다. 이 항목이 생긴 이유가 정확히 "4 를 보고도 시작한 것" 이다.
  - 충돌로 레지스트리가 지워지면 그 실행이 만든 workspace 가 남을 수 있다. 그때도 **prefix 로 지우지 않는다** — 생성 응답의 정확한 ID 를 실행 산출물에서 복구해 그 하나만 지우고, 복구할 수 없으면 남겨둔 채 보고한다.
  - **established 연결 수를 게이트로 쓰지 않는다.** 사용자가 `https://localhost:2222` 를 브라우저 탭으로 열어두면 WS 연결이 상시 유지되어 카운트가 영원히 0 이 되지 않는다. 2026-09-19 실측: `playwright test` 프로세스가 하나도 없는 상태에서 established 가 12 였다. 카운트는 레인과 사용자 브라우저를 구별하지 못하므로, 0 을 요구하는 게이트는 모든 레인을 무기한 정지시킨다. 게이트는 **프로세스 유무**로 판정한다: `pgrep -af "playwright test"` — **단, 체커를 자기 결과에서 걸러낸다**(`| grep -v pgrep`). 패턴을 감싸는 bracket trick(`[p]laywright`)은 같은 명령줄 안에 그 리터럴이 다시 등장하는 순간 무너지므로 해법이 아니다. 2026-09-19 에 이 자기매칭이 서로 다른 모습으로 두 번 물었다: 한 번은 워처가 영원히 기다려 인내처럼 보였고, 한 번은 실행 명령 안의 preflight 가 자기 자신의 `npx playwright test …` 텍스트를 보고 진행해야 할 실행을 중단시켰다. **증상이 정반대라서 같은 버그로 보이지 않는다.** 카운트는 진단 정보로만 남긴다.
  - **게이트를 `&&` 로 엮지 않는다. 하나를 고른다.** 2026-09-19 실측: 한 레인의 preflight 가 연결 수 검사와 프로세스 검사를 `&&` 로 묶었고, *옳은* 프로세스 검사가 *틀린* 연결 수 검사에 가려졌다. 안전 검사를 쓸 때의 본능은 조건을 더하는 것이지만, **연언으로 묶인 게이트는 가장 취약한 항만큼만 쓸 만하다.** 덧붙인 조건이 안전을 더하는 것처럼 보여도 실제로는 오작동 지점을 하나 더 만든다.
  - 게이트를 통과했다는 것이 게이트가 작동한다는 뜻이 아니다. 같은 레인이 네 번 통과했는데 네 번 모두 마침 연결 수가 0 이었을 뿐이다 — **브라우저 탭이 없을 때만 맞는 신호는 게이트가 아니라 우연이다.**
  - 다른 레인의 실행이 진행 중일 때 인증된 delete 를 쏘지 않는다. 그 delete 가 상대 spec 과 경합하는 것이 Workspace-1 급 손상이 나는 경로다.
- UI 동작 수정의 E2E 증거와 단위 검증을 구분한다. 스크린샷은 `.playwright-mcp/`, 시나리오는 실제 로그인→기능→종료 흐름을 따른다. 실제 실행은 AGENTS의 포트/프로세스/원본 보존 사전검토 이후다.
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

## 작업 강도 방침 (2026-09-18, 사용자 지시)

**이 저장소는 상용 솔루션이 아니라 오픈소스다. 기능에 큰 문제가 없으면 정교하게 만들지 않는다.**

- **속도를 우선한다.** 완결성보다 진행이 중요하다.
- **리뷰 라운드는 기본 1회.** 실제 기능 결함(사용자가 겪는 동작 문제)이 나왔을 때만 추가로 돈다. 기록 정확성·문서 표현·계측기 정밀도 문제로 라운드를 반복하지 않는다.
- **발견한 모든 것을 이슈로 만들지 않는다.** 범위 안이고 작으면 그 자리에서 고치고, 범위 밖이면 보고서에 한 줄로 남긴다. 별도 이슈는 **실제 기능 결함이거나 다른 작업을 막을 때만** 세운다.
- **검증 장치의 정밀도를 목적으로 삼지 않는다.** 테스트가 실제 결함을 잡을 수 있으면 충분하다. 변이 테스트·대조군·봉인 검증은 **안전 임계 경로에서만** 요구한다.
- **"충분히 좋다" 를 받아들인다.** 잔여와 한계는 기록하되, 그것을 닫으려고 작업을 연장하지 않는다.
- **런타임 의존성은 묻지 않고 추가한다.** 필요한 패키지(예: `@xterm/addon-webgl`)는 승인을 기다리지 말고 바로 추가하고 진행한다. 설치한 패키지와 이유는 커밋 메시지에 남긴다.

이 방침은 이 파일의 다른 규칙(TDD, SRS 워크플로, 안전 규칙)을 대체하지 않는다. 다만 **어디까지 파고들 것인가**에 대한 기본값을 낮춘다.

## 유계 링 버퍼는 "없음" 과 "밀려남" 을 구별해 주지 않는다 (2026-09-19)

**디버그 링은 400건(`MAX_CLIENT_DEBUG_EVENTS`)에서 감기고 페이지 전역이다** — 배열 하나를 읽을 때 session 으로 거를 뿐이다. 700줄을 뽑으면 그보다 훨씬 많은 이벤트가 발생하므로 **attach 시점 이벤트는 전부 축출된다.**

실측(2026-09-19): 8회 실행의 덤프가 매번 정확히 400건이었고 전부 전달 마지막 ~1.2초 구간이었다(`terminal_delivery_ack_attempted` ×309, `live_output_received` ×91). 캡을 제거하자 857–982건이 되었고 그제서야 attach 창이 보였다.

귀결: **대량 출력 뒤에 `hidden_output_recovery_*` 나 `visible_output_resync_*` 가 링에 없다는 것은 그 경로가 동작하지 않았다는 증거가 아니다.** 링이 담지 못했다는 증거다. 이것은 null-instrument 규칙과 같은 실패 모양이다 — 볼 수 없는 창에 대해 **확정적이고 완전해 보이는** 답을 낸다.

- 링으로 무언가의 **부재**를 주장하기 전에, 덤프 건수가 캡과 같은지 본다. 400이면 그 덤프는 잘린 것이고 부재를 주장할 수 없다.
- 부재를 봐야 하는 조사에서는 캡을 제거하거나 출력량을 캡 아래로 줄인다.
- **계측기의 포화가 가설과 같은 서명을 낼 때가 가장 위험하다.** 2026-09-19 실측: 서버 replay 링이 12회 전부 256(상한)이라 `subscribe-begin` 이 하나도 안 보였는데, 마침 찾던 가설이 "아무 흔적도 남기지 않고 포기하는 경로(Path C)" 였다. **빈 읽기 12건이 그 가설의 확증 12건처럼 보인다.** 부재가 가설과 일치하면 부재를 읽고 싶은 압력이 최대가 되므로, 그때야말로 포화 여부를 먼저 본다.
- 전역 링을 리로드 직후에 한 번 읽는 것으로는 이 질문에 답할 수 없다. **세션 단위 캡처**(`enableDebugReplayCapture`)를 쓰거나, 리로드 구간에 걸쳐 반복 폴링하며 중복 제거로 누적한다.
- **가까이서 관측하면 사라지는 현상이 있다.** 같은 빌드·무변경 상태에서 4/12 였던 분기가 텔레메트리 `fetch` 하나를 추가하자 12/12 가 되었다. 타이밍에 민감한 현상은 관측 행위가 교란하므로, 재현되지 않는다고 없는 것으로도, 한 번 봤다고 있는 것으로도 취급하지 않는다 — **쫓기 가장 어렵고, 봤다고 스스로를 설득하기 가장 쉬운 종류다.**
- **이벤트 종류 자체가 실패만 기록하는 경우가 있다.** 2026-09-19 실측: 브라우저의 checkpoint 디버그 이벤트 12종이 전부 `_rejected`/`_deferred`/`_ignored`/`_refused`/`_blocked`/`_incomplete` 계열이고 **성공 이벤트가 존재하지 않는다.** 그러므로 "링에 checkpoint 이벤트가 없다" 는 "그 경로가 돌지 않았다" 와 "깨끗이 돌았고 원래 아무 말도 안 한다" 를 구별하지 못한다. 부재를 읽기 전에 **그 사건의 성공 케이스에 해당하는 이벤트 종류가 애초에 존재하는지** 열거해서 확인한다.
- **버퍼 길이 같은 단일 숫자로 결과를 판정하지 않는다.** 같은 실측에서 `normalLength: 28` 이 "뷰포트를 복원함" 과 "아무것도 복원하지 않음" 두 가지를 동시에 의미했다 — 새 xterm 은 어느 쪽이든 정확히 `rows` 줄이기 때문이다. 숫자가 같다고 현상이 같은 것이 아니다.

## 단언을 쓸 때 "이것을 만족시키는 가장 값싼 것은 무엇인가" 를 묻는다 (2026-09-19)

내용 동일성 규칙과 단일 숫자 규칙은 **좋은 단언이 어떻게 생겼는지**는 말해주지만 **약한 단언을 어떻게 알아채는지**는 말해주지 않는다. 2026-09-19 의 약한 형태 셋은 전부 리뷰를 통과했다.

셋을 잡아낸 것은 매번 같은 동작이었다 — **그 단언이 *주장하는* 것이 아니라 *허용하는* 것을 측정한 것.**

| 약한 형태 | 무엇이 그것을 만족시켰나 |
|---|---|
| `normalLength > floor` | 아무것도 복원되지 않은 채 새 출력이 쌓이기만 해도 28 → 129 |
| `hasSelection()` 이 true | `getSelection()` 이 빈 문자열인 상태 |
| overlap > 0 | 709줄 중 우연히 동일하게 해시되는 빈 줄 **한 줄** (`overlap=1/709`) |

**방법**: 단언을 쓸 때 "이것을 만족시키는 **가장 값싼** 것은 무엇인가" 를 묻고, **그 값싼 것이 실제로 일어나는지 측정한다.** 세 번 다 일어났다. 결함이 가르쳐 주기를 기다리지 않고 작성 시점에 물을 수 있는 질문이다.

## 결함을 측정한 것인지 구성(configuration)을 측정한 것인지 구별한다 (2026-09-19)

**측정이 정확하고, 재현되고, 메커니즘과 일치해도, 그것이 결함이 아니라 설정된 동작을 기술하고 있을 수 있다.**

실측: 새로고침 뒤 scrollback 이 사라지는 것을 4라운드에 걸쳐 32/32 로 재현했다. viewport-only 페이로드를 찾고, `truncated: false` 를 확인하고, 스냅샷이 도착·적용·ack 되고도 28 인 것을 확인했다. 전부 옳았다. **그러나 그것은 legacy authority 경로가 설계대로 동작하는 모습이었다** — 체크포인트 election 은 이미 완전히 구현되어 있고, 모드 캐스케이드가 `legacy` 에서 무조건 return 하기 때문에 도달하지 않을 뿐이었다.

- **반복 횟수는 이 둘을 구별해 주지 않는다.** 32회가 32회 모두 같은 구성을 관측한 것이다. 추가 실행으로는 절대 드러나지 않는다.
- 증상에서 아래로 읽어 내려가면 그 게이트에 도달하지 못한다. **복구 경로에서 위로 읽어 올라가야** 무엇이 그 경로를 선택했는지 나온다.
- "이 동작을 *선택하는* 코드를 지목할 수 있는가" 를 결함이라고 말하기 전에 묻는다. 지목할 수 없으면 아직 결함이라고 부르지 않는다.
- 설정된 동작을 결함으로 보고하면, 고치는 쪽은 설계된 게이트를 우회하게 된다 — 그 게이트가 바로 그 요구사항의 승급 ladder 인 경우가 있다.

## 상태 필드를 판정으로 읽지 않는다 (2026-09-19)

**`Status` 와 `Stability` 는 서로 다른 축이고, 둘 다 "진행해도 되는가" 에 답하지 않는다.** 2026-09-19 에 한 사람이 같은 오류를 **다섯 번** 했다:

| 읽은 것 | 실제 의미 | 결과 |
|---|---|---|
| `Status=planned` → "막혀 있다" | 아직 안 지어졌다 | 지을 수 있는 요구사항을 차단됐다고 기록 |
| AC 가 하나도 체크 안 됨 → "AC 가 없다" | 구현이 안 됐다 | 같은 오판 |
| `Stability=stable` + 0/12 → "모순, 기록 오류" | 성숙도는 stable, 구현은 미완 | 없는 record-reality gap 을 제기 |
| `Stability=stable` + 0/12 → "막혀 있다" | 안정된 계약 위의 미착수 작업 | 두 레인을 세워 둠 |

멈춰야 하는 것은 **`Stability=draft` 또는 `deprecated`** 뿐이다(이 문서 위쪽의 SRS 규칙). 그 외에는 상태 필드가 작업 가능 여부를 말해주지 않는다.

이것은 계측기 결함들과 **같은 모양**이다 — 묻지 않은 질문에 대해 확정적이고 완전해 보이는 답을 낸다. 필드를 보고 판정이 떠오르면, **그 필드의 정의를 다시 읽는다.**

## 가설을 precondition 에 넣으면 계측기는 그 가설만 확인할 수 있다 (2026-09-19)

**메커니즘에 대한 믿음을 검사 자체에 넣으면, 그 검사는 그 믿음을 반증할 수 없다.**

2026-09-19 하루에 같은 측정 하나에서 계측기 결함이 **네 번** 나왔고, 넷 다 뿌리가 같았다:

1. `captureTerminalText` 는 `term.rows` 뷰포트만 반환하는데 scrollback 을 묻는 데 썼다 — 볼 수 없는 것에 대해 확정적인 답을 냈다.
2. precondition 이 "새로고침 *전에* 버퍼가 이미 커야 한다" 를 단언했다 — eager retention 모델을 계측기 안에 박아 넣은 것.
3. 안정화 폴링이 "안정됨" 과 "시작도 안 함" 을 구별하지 못했다 — 4회 중 3회가 자신 있게 `28` 을 보고했고 그 숫자는 아무 의미도 없었다.
4. lazy hydration 이라고 결론 낸 뒤 "스크롤 중 버퍼가 자랐는가" 를 precondition 으로 만들었다 — 레이스를 없애자 올바르게 채워진 버퍼는 자라지 않게 되었고, **테스트가 원하던 상태를 바로 그 이유로 거부**했다.

공통 증상: **관측할 수 없는 상태에 대해 확정적인 숫자를 낸다.** 측정값이 없는 것보다 나쁘다 — 확정적인 숫자는 믿어지기 때문이다.

- precondition 은 **관측 가능한 최종 상태**로 쓴다("버퍼가 생성된 히스토리를 담고 있다"), 메커니즘의 중간 신호로 쓰지 않는다("스크롤 중 자랐다").
- 메커니즘에 대한 믿음은 precondition 이 아니라 **진단 출력**으로 남긴다.
- 계측기를 고칠 때마다 이전 실행의 결과를 **증거에서 철회**한다. 바뀐 계측기로 얻은 숫자와 섞어 쓰지 않는다.
- 같은 측정에서 계측기 수정이 반복되면 멈추고 측정 문제 자체를 위로 올린다.
- **어느 답이 나와도 정보가 되도록 설계한 뒤에 돌린다.** 틀린 주장이 비싼 이유는 부주의가 아니라 **자기 표본 안에서는 잘 뒷받침된다**는 데 있다 — 2026-09-19 의 "reload 가 기준" 은 12/12 였고, 배타성 발견들은 n=8 에서 깨끗했으며, scrollback 가설은 가진 데이터 전부와 정합했다. 그것들을 깬 것은 더 큰 표본, 다른 경로에서 온 사실, 그리고 **어느 쪽으로 떨어져도 답이 되게 만든 probe** 뿐이었다. 확증을 찾으러 갔다면 셋 다 오지 않았다.
- 반증된 모델과 그 이유를 **테스트 안에 주석으로 남긴다.** 그러지 않으면 다음 사람이 지워진 검사를 다시 넣는다.

## `test.fail()` 특성화는 표식을 떼고 돌려본 적이 있어야 한다 (2026-09-19)

현재 결함을 기록하는 테스트를 `test.fail()` 로 표시하면 **결함이 있는 동안 통과하고 누군가 고치는 순간 red 가 된다.** 원하는 신호지만 구멍이 둘 있다.

1. **표식 아래에서는 모든 실패가 "예상된 실패" 로 집계된다** — 단언 실패뿐 아니라 precondition 실패, 하네스 예외, 타임아웃, fixture 오류까지. fixture 가 조용히 출력을 멈춰도 특성화는 "통과" 하고, **승인 도장이 찍힌 공허한 통과**가 된다. 아무도 다시 볼 이유가 없으므로 평범한 공허한 통과보다 나쁘다. → precondition 을 **표식 밖의 평범한 테스트로 분리**한다. 테스트 둘을 두되, 하나는 다른 하나가 거짓말하지 못하게 하려고만 존재한다.
2. **표식을 떼고 한 번은 돌려야 한다.** 분리는 깨진 fixture 를 막아주지만, 그 특성화가 *애초에 올바른 것을 단언하고 있었는지*는 말해주지 않는다. 그것은 표식을 제거해 red 가 **의도한 단언에서** 나는지 보는 것으로만 확인된다. **표식 없이 한 번도 돌아본 적 없는 `test.fail()` 은, 실패하는 것을 한 번도 본 적 없는 golden 과 같은 범주다.**

- **주의는 표시된 테스트로 가지만, 무게를 지는 것은 표시되지 않은 쪽이다.** 표시된 테스트가 주장을 하므로 눈이 그쪽으로 가는데, 그 테스트는 어떤 실패든 흡수하므로 **그 진실성은 전적으로 표시되지 않은 control 에 위임되어 있다.** 실측: 강화 지시가 characterization 만 다루고 control 을 길이 주장인 채로 남겼는데, 위험한 쪽은 control 이었다. 아무도 보지 않는 쪽이 일을 하고 있다 — 오늘 찾은, 통과하면서 아무것도 측정하지 않던 가드들과 같은 모양이다.

(2)가 (1)보다 중요하다. 실측 예: 표식 제거 시 `Measured before=708 after=28 / Expected > 200 / Received 28` — 올바른 단언이 올바른 이유로 실패한다는 것이 그제서야 보인다.

## 특성화(characterization) 테스트의 red 와 낡은 테스트의 red 는 구별되지 않는다 (2026-09-19)

**테스트가 올바른 이유로 실패하는 순간이, 바로 그 테스트가 잘못된 이유로 삭제될 가능성이 가장 높은 순간이다.**

둘은 겉모습이 같다 — 둘 다 red 이고, 둘 다 진행을 막고, 둘 다 지금 이 자리에 없는 사람이 썼다. 그리고 그것을 보는 사람은 대개 기능 작업 도중이며, 초록 스위트를 가로막는 red 에 대한 가장 값싼 해석은 "이 테스트는 이제 낡았다" 이다.

둘을 가르는 것은 **어느 쪽인지 말해주는 기록**뿐이다. 그 기록은 테스트 자신의 주석이 아니라 **요구사항**에 있어야 한다 — 주석은 그 테스트를 지우는 사람이 함께 지운다.

실례: `TC-7004`(`header-context-menu-regression.spec.ts`)는 `payloadKind === 'viewport-only'` 를 핀으로 박고 있고, #16 완료 조건 6 이 구현되면 **올바른 이유로** 빨개진다. 그때 할 일은 뒤집기도 삭제도 아니라 **legacy 경로로 범위를 좁히는 것**이다. 그것을 아는 근거는 `OBS-BGSTAB-009`(`stable`, `implemented`) 가 AC-4 에서 target parity 테스트를 TC-7004 와 **별개 테스트로 존재하도록 요구**하고 그 테스트를 이름으로 지목한다는 사실이다.

귀결: 현재 동작을 기록하는 테스트를 쓸 때는 **그것이 기록이라는 사실과 무엇이 그것을 대체할지를 요구사항에 적는다.** 테스트 제목과 주석만으로는 다음 사람에게 도달하지 않는다.

## 공유 워크트리에서 커밋되지 않은 작업은 우연으로만 보인다 (2026-09-19)

여러 레인이 한 워크트리를 쓰면 **아직 커밋되지 않은 편집은 다른 레인에게 보이지 않는다.** `git status` 는 누가 무엇을 쓰는 중인지 말해주지 않고, 파일을 읽는 것도 그 순간의 스냅샷일 뿐이다.

실측: 편집 전에 `git status` 로 clean 을 확인하고 파일을 읽어 패치를 썼는데, 그 사이 다른 레인이 같은 파일에 60줄을 넣고 있었다. 충돌을 알려준 것은 **앵커가 매치되지 않아 스크립트가 멈춘 것**뿐이다 — 상대 편집이 더 작았거나 다른 영역이었다면 패치가 깨끗이 얹혔고 둘 다 몰랐을 것이다. 적용 실패는 안전장치가 아니라 우연이다.

- 남의 파일을 고치기 직전에 **그 파일을 마지막으로 만진 레인에게 먼저 묻는다.** clean 한 `git status` 는 허가가 아니다.
- 편집하려는 영역을 **직전에 다시 읽고**, 앵커가 여러 개면 전부 확인한다.
- 자기 작업은 가능한 한 빨리 커밋한다. 커밋되지 않은 채 오래 있는 파일이 다른 레인에게는 존재하지 않는 것과 같다.
- 같은 뿌리에서 나온 다른 표면: 두 Playwright 실행이 `test-results/` 를 공유해 서로의 레지스트리를 지운 것.

## 안전 장치가 그 다음 실패의 원인이 된다 (2026-09-19, 이슈 #2 레인)

**옳은 안전 규칙의 옳은 적용이 다음 실패를 만든다.** 하루에 세 번, 서로 다른 모습으로 나타났다.

- `git add -A` 금지 → 명시 경로로만 스테이징 → **새로 생긴 untracked 디렉터리가 남는다.** authority 를 republish 하면 `current.json` 은 tracked 라 잡히지만 새 generation 디렉터리 18개 파일은 `??` 로 남고, 그대로 커밋하면 포인터가 저장소에 없는 generation 을 가리켜 evidence-bundle 이 throw 하고 **모든 빌드·테스트·CI 가 red 가 된다**.
- 게이트를 엄격하게 만들려고 조건을 `&&` 로 더함 → **가장 취약한 항이 전체를 정한다.** 옳은 프로세스 검사가 틀린 연결 수 검사에 가려졌다.
- 동시 실행을 막으려고 게이트를 추가함 → 그 게이트가 사용자 브라우저 탭을 레인으로 오인 → **모든 레인이 무기한 정지.**

귀결: **안전 장치를 추가한 뒤에는 "이것이 무엇을 못 하게 만드는가" 를 한 번 더 본다.** 안전 장치의 실패는 위험한 동작이 아니라 *정당한 동작이 막히거나, 막아야 할 것을 조용히 통과시키는* 모습으로 나타나므로 버그로 보이지 않는다. 오늘 두 경우 모두 겉보기 행동은 미덕이었다 — 인내, 그리고 신중함.

## 알려진 실패(known failure) 라벨의 상속 규칙 (2026-09-18, issue #89)

**다른 커밋에서 측정된 실패 분류를 인용할 때는, 그 원인이 내 HEAD 에서도 성립하는지 먼저 확인한다.**
실패 *이름* 이 같다는 것은 *원인* 이 같다는 뜻이 아니다.

- 알려진 실패 목록은 허용목록이고, 허용목록은 썩는다. 코드 허용목록은 red 가 났을 때 사람이 한 번은 보지만, **실패 목록은 red 가 계속 나는 것이 정상 상태**라 아무도 다시 보지 않는다.
- 이것은 이 파일의 *"editor branch 의 과거 실행 기록은 통합 상태의 검증 증거가 아니다"* 를 실패 목록으로 확장한 것이다.
- 항목의 필수 필드는 넷이며, 하나라도 빠지면 재검증이 불가능하므로 항목으로 인정하지 않는다: **(1) 테스트 이름 (2) 측정된 원인 (3) 측정된 커밋 SHA (4) 측정 일자**.
- 가능하면 이름이 아니라 **실패 서명(스택 최상단 + 던진 메시지)** 으로 매칭한다.
- 실측 근거: VE-11 의 선재 실패 6건을 현재 HEAD 에서 전수 재검증한 결과 **6건 전부가 기록된 그대로는 사실이 아니었다** (2건은 이미 통과, 3건은 #8 이 해결, 1건은 여전히 red 이나 기록된 것과 전혀 다른 원인). 상세는 `docs/plan/2026-09-18.issue-2-lane-standing-brief.md`.

**갓 나온 실패도 상속된 라벨과 같은 부담을 진다.** 이 규칙을 상속 목록에만 적용하고 *살아 있는* red 에는 적용하지 않는 것이 2026-09-19 의 실패였다. 한 레인이 그날 아침 상속된 실패 라벨 여섯 건을 전부 재도출해 놓고, 오후에 커밋 해시가 붙은 fresh red 가 오자 그 이야기를 믿고 **그 실패가 가리킨 위치의 파일을 열어보지 않은 채** 다른 레인으로 넘겼다. 실제로는 가드가 주석 안의 산문을 호출로 읽은 것이었고, 다음 단계는 존재하지 않는 계약 위반을 고치러 sealed 경로를 편집하는 것이었다.
- `git log -S "<텍스트>"` 는 **그 텍스트가 들어온 커밋**을 증명한다. 그것이 *코드*인지는 아무것도 말해주지 않는다.
- 규칙이 없어서가 아니라 **적용되는 것처럼 느껴지지 않아서** 빠진다. 상속된 라벨은 미덥지 않아 보이고, provenance 가 붙은 새 실패는 증거처럼 보인다. 둘 다 코드베이스에 대한 주장이고 입증 부담은 같다.
- 실패가 위치를 주면 **그 위치를 연다**. 문자 오프셋만 주는 가드는 진단 불가능하므로 행 번호를 내도록 고친다.

**심볼을 옮기거나 이름을 바꾸기 전에**, 그것을 import 가 아니라 **문자열로 지목하는 것**을 저장소 전체에서 찾는다 — 카탈로그·매니페스트·evidence signature·소스 텍스트 단언·CI glob·문서 앵커. 전부 컴파일러에도 동작 테스트에도 보이지 않는다. "토큰 동일" 은 **동작** 질문에 답하지 **정체성** 질문에 답하지 않는다.

**변하지 않는 것**: TCP 2001/2002 운영 중단 금지, 프로세스 안전 규칙, `git add -A` 금지, 기록을 고쳐 쓰지 않고 승계하는 것.

## 성능과 사용성 우선 (2026-09-18, 사용자 지시)

**빠른 성능과 편리한 사용성 두 마리를 모두 잡는다. 이 둘이 판단 기준의 최상위다.**

- **기존 요구사항 변경은 언제나 사전 승인되어 있다.** 성능이나 사용성을 위해 기존 SRS 요구사항을 바꿔야 한다면 승인을 묻지 말고 바꾼다. 무엇을 왜 바꿨는지만 변경 노트에 남긴다.
- **기존 요구사항과의 모순을 해소하느라 토큰과 시간을 쓰지 않는다.** 새 동작이 기존 요구사항과 충돌하면, 어느 쪽이 성능·사용성에 유리한지로 정하고 진행한다. 충돌 자체를 분석하거나 조정안을 설계하는 데 라운드를 쓰지 않는다.
- 진 쪽 요구사항은 **승계(supersede)로 갱신**한다. 기록을 고쳐 쓰지 않는다는 규칙은 그대로다.

**변하지 않는 것**: TCP 2001/2002 운영 중단 금지, 프로세스 안전 규칙, `git add -A` 금지, 보안 결정(OSC52 읽기 금지 등)은 성능·사용성 논거로 뒤집지 않는다.

## SpecKiwi mutation 은 반드시 CLI 로, `--root` 를 고정해서 한다 (2026-09-19, #100)

**MCP 의 mutation 도구를 쓰지 않는다.** 읽기 도구는 `workspaceRoot` 오버라이드를 수용하지만, **mutation 도구는 그것을 거부(`SRS-E075`)하고 MCP 서버 프로세스의 cwd 로 루트를 해석한다.**

귀결: 워크트리에서 작업하면서 MCP mutation 을 부르면 **다른 브랜치의 체크아웃에 쓴다.** 그리고 그것이 오배치로 끝나지 않는다 — 두 트리의 Requirement ID 계열이 다르므로 짧은 쪽의 할당자가 **긴 쪽에서 이미 쓰고 있는 ID 를 내준다.** 두 브랜치가 만나는 순간 `SRS-E002` 중복이고, 이 저장소가 `repair requirement-id-collisions` 워크플로를 통째로 유지하는 이유가 그 조건이다.

**mutation 응답에는 해석된 루트가 포함되지 않는다.** 읽기 도구는 `rootSource` 를 보고하지만 mutation 은 보고하지 않으므로, **호출자가 어디에 썼는지 확인할 방법이 없다.** 조용히 성공한다.

올바른 형태:

```bash
npx speckiwi add-evidence <REQ-ID> --root . --type test --ref <path> --covers "AC-n" --notes "..."
npx speckiwi validate --root . --fail-on-warning
```

CLI 는 cwd 를 루트로 삼고 `--root` 를 존중한다. 실측으로 확인된다 — 같은 `speckiwi show <ID>` 가 워크트리에서는 성공하고 다른 체크아웃에서는 `NOT_FOUND` 를 반환한다.

## SpecKiwi 도구의 알려진 함정 세 가지 (2026-09-19, #65 · #79)

외부 패키지(`speckiwi ^3.0.0`)의 결함이라 이 저장소에서 고칠 수 없다. 회피 절차와 가드로 다룬다.

### 1. `edit-requirement-table-rows` 가 Change Note 를 조용히 삼킨다

요구사항 블록 전체를 **stale read 기준으로 다시 쓰므로**, 그 사이에 추가된 Change Note 가 **오류도 경고도 없이** 사라진다. `validate` 는 0 errors / 0 warnings 를 낸다 — 없어진 기록은 구조적 결함이 아니기 때문이다.

- **Change Note 는 그 요구사항에 대한 table-row 쓰기를 전부 끝낸 뒤에 추가한다.**
- 같은 요구사항에 반복 호출할 때마다 직전 호출 이후의 수동 편집이 사라질 수 있다고 가정한다.
- `--dry-run` 을 선행하고, 실행 전후 `git diff` 의 삽입·삭제 줄 수가 의도와 정확히 일치하는지 본다.
- 커밋 전에 `npm run check:srs-change-notes` 를 돌린다. Change Note 행은 append-only 이므로 **HEAD 보다 적어졌다면 쓰기가 하나 먹은 것**이다.

또한 연산 키를 잘못 주면 **조용히 무시되고 원본과 동일한 교체**가 일어난다(`cells` · `fields` · `set`). 성공처럼 보이므로 증거를 갱신했다고 믿고 넘어갈 수 있다. 올바른 키는 `kind` · `rowId` · `values` 다.

### 2. `sync-index` 가 lock 을 남긴다 — 다만 막지는 않는다

`sync-index` 뒤 `kiwi/.status.json` 의 `lock.active` 가 `true` 로 남고 60초 뒤 만료된다. **실측으로 그 잔존 lock 은 아무것도 막지 않는다** — 두 번째 `sync-index`, `check-ac`, `add-change-note` 가 모두 그 아래에서 진행된다. 비용은 막힌 명령이 아니라 **다음 사람과 모든 diff 에게 "누군가 쓰는 중" 으로 읽히는 기록**이다.

커밋된 파일의 lock 은 살아 있는 lock 일 수 없다. 커밋 전에 `lock` 을 `{"active": false, "metadata": null}` 로 되돌린다. `npm run check:kiwi-status` 가 이것을 막는다.

### 3. Trace Links 행은 도구로 주소 지정할 수 없다

`edit-requirement-table-rows` 는 **ID 열이 없는 Trace Links 행을 지목하지 못한다.** 그 표만은 수기 편집이 불가피하며, 그때는 **사유를 Change Note 로 남긴다.**

관련해서: **이 저장소에서 행 번호는 빠르게 썩는다.** 불변 기록물의 참조는 이름(테스트 제목·심볼)으로 걸고, 이름을 댈 수 없으면 **경로만 남긴다.** 행 번호 범위는 다음 커밋에 이미 틀린 곳을 가리킨다.

### 4. 에픽 작업 중에는 target 을 항상 명시한다

Active Target 이 다른 것으로 설정돼 있으면 `speckiwi summary` 가 이 에픽의 요구사항을 보여주지 않는다. **명시를 빠뜨리면 관련 없는 집합에 대한 요약을 보고 판단하게 된다.** Active Target 기본값에 기대지 말고 `--target` 을 항상 넘긴다.
