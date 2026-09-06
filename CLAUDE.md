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
node dev.js --port 2222   # 서버(2222) + 프론트(2223) 동시 실행
```

**dev 서버의 기본 포트는 2222 이다**(병렬 검증에서 레인마다 자기 포트를 쓰는 예외는 아래 Rules 참조) (`--port 2222`, 프론트는 `serverPort+1`=2223). 브라우저·실측·health 체크 모두 2222 기준으로 한다.
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

- **dev 서버 포트의 기본은 2222** — `node dev.js --port 2222`로 실행하며, health/브라우저 접속은 `https://localhost:2222`. 4242·4545·2002 처럼 **근거 없는 포트로 접속을 시도하지 말 것.**

  **예외는 병렬 검증이다.** 레인이 여럿 동시에 E2E 를 돌 때는 각자 자기 포트를 써야 한다 — 한 인스턴스를 나눠 쓰면 세션이 누적되어 무관한 케이스가 서로의 실행에서 빨개진다. 그때는 **앞뒤가 모두 빈 포트**를 고른다(`server/src/index.ts` 가 `HTTP_PORT = PORT - 1` 을 쓰고 vite 가 `PORT + 1` 을 쓰므로 셋이 필요하다). `netstat -ano | grep LISTENING` 으로 확인하고, `PLAYWRIGHT_BASE_URL` 로 그 포트를 명시한다. 실제로 2222 외의 포트로 뜬 `dev.js` 가 동시에 일곱 개 관측된 적이 있다
- **`taskkill /F /IM node.exe` 절대 금지** — 이 머신에는 다른 세션·다른 워크트리의 node 프로세스가 수백 개 떠 있고 그것까지 함께 죽는다. dev.js 가 hot reload 로 자동 재시작하므로 `kill {pid}` 도 평소에는 불필요하다. **다만 `TaskStop` 은 래퍼만 끊고 자식 프로세스를 고아로 남기며, 그 고아가 포트를 계속 점유한다.**

  그때 **커맨드라인으로 자기 것을 가려내려 하지 말 것.** 부모(`node.exe dev.js --port 2222`)에는 포트만 있고 워크트리가 없으며, 자식(`…\<워크트리>\server\node_modules\…\tsx\dist\cli.mjs`)에는 워크트리만 있고 포트가 없다. 게다가 같은 포트를 쓰는 `dev.js` 가 둘 이상 떠 있는 것이 실제로 관측되었으므로 **포트도 유일 키가 아니다.** 어느 축으로도 단독 식별이 되지 않는데 `/T` 로 트리째 죽이면 남의 트리를 죽인다.

  **포트 소유자를 OS 에 직접 물어라.** 앞 문단이 포트로 식별하지 말라고 한 것과 어긋나 보이지만 층위가 다르다 — **커맨드라인의 `--port 2272` 는 그 프로세스가 하는 주장**이고(같은 주장을 하는 프로세스가 여럿일 수 있다), **리슨 소켓은 OS 가 아는 사실**이다.

  ```powershell
  Get-NetTCPConnection -LocalPort <포트> -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  ```

  **`-Unique` 를 빼지 말 것** — 리슨 엔트리마다 값이 하나씩 나오므로 `0.0.0.0` 과 `[::]` 양쪽에 바인드한 포트는 **같은 PID 가 두 번** 나온다(이 머신의 리슨 포트 68개 중 11개가 그렇다). 그 값을 그대로 다음 명령에 보간하면 `ProcessId=13720 13720` 이 되어 쿼리가 깨진다.

  **결과가 비면 그 고아는 포트를 이미 놓은 것이니 그대로 두어라.** 실제로 `dev.js` 고아가 서버 포트를 놓은 채 남아 있는 상태가 관측되며(포트는 vite 자식만 쥐고 있다), 그때 `-ErrorAction SilentlyContinue` 가 없으면 `ObjectNotFound` 붉은 벽만 보고 다음 수를 알 수 없다.

  PID 를 얻었으면 죽이기 전에 `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` 로 커맨드라인을 한 번 더 눈으로 확인하고, **그 PID 에만** `taskkill /PID <pid> /T /F` 를 쓴다
- **`dev.js` · `npm run build` · `npm ci` 는 `BUILDERGATE_*` 를 전부 지우고 실행한다.** 이 셸에는 그 접두사의 변수가 **열다섯 개** 상속되어 있고, `BUILDERGATE_CONFIG_PATH` 하나만 남아도 서버가 **설치본의 `config.json5`** 를 읽는다. 그러면 `/health` 는 200 이고 앱도 정상으로 보이지만 **워크트리 소스가 전혀 검사되지 않는다.** 이름을 손으로 나열하면 반드시 빠뜨리므로 접두사째 지우고, `unset` 과 명령을 **같은 셸 호출 안에** 둔다 (파이프·명령 치환 안의 `unset` 은 서브셸에서만 먹는다)

  ```bash
  unset NODE_ENV $(env | grep -oE '^BUILDERGATE[A-Z_]*' | tr '
' ' '); node dev.js --port 2222
  ```

  띄운 뒤 배너의 `2FA: Disabled` 만 보는 것으로는 부족하다 — 설치본 config 가 마침 `false` 면 잘못된 인스턴스도 같은 줄을 낸다. **띄우기 직전에 `env | grep -c '^BUILDERGATE_'` 가 0 인지 확인**하고, 로그에서 `[ViteProxy] Development proxy to http://localhost:<포트+1> enabled` 를 함께 본다. 워크트리 `server/config.json5` 가 `enabled: false` 인데 배너가 `TOTP` 이면 그것은 **다른 파일을 읽었다는 증명**이다
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
| node:test (server) | `server/src/**/*.test.ts` (**62개**, 2026-09-06 실측) | **cwd=`server/`** 에서 `npx tsx --test src/<경로>.test.ts` — 파일별. **단 `TerminalAuthorityProductionRegression.test.ts` 는 이 커맨드로 green 이 될 수 없다** (아래 주의) |
| daemon | `tools/daemon/*.test.js` (**20개**, 2026-09-03 실측) | 루트 `npm run test:daemon` (server 빌드 선행) |
| wave3 closure | `tools/wave3/fair-readmission-closure-v3*.test.mjs` (22개, node:test — 그중 게이트는 `admission-gate`·`boundary-gate` 2개) | `node --test tools/wave3/<파일>` — npm 스크립트 없음. **게이트 2개는 형제를 재실행하니 아래 주의 참조** |
| wave3 증거 스크립트 | `tools/wave3/{authority-promotion-evidence, canary-admission-evidence, fair-scheduler-decision, retained-shadow-parity, terminal-resource-consumer-manifest}.test.mjs` (5개, **node:test 아님**) | `node tools/wave3/<파일>` (일부는 `--regenerate-green` 등 플래그를 받음) |
| wave1 | `tools/wave1/g1-decision-gate.test.mjs` (1개) | `node --test tools/wave1/g1-decision-gate.test.mjs` — 스크립트 없음 |
| server tools | `server/tools/*.test.{cjs,mjs}` (3개, node:test) | `node --test server/tools/<파일>` — 스크립트 없음 |
| 릴리즈 파이프라인 가드 | `tools/build-portable-runtime-evidence.test.mjs`, `server/tools/canonical-authority-line-endings.test.mjs`, `server/src/benchmarks/FairSchedulerAuthorityGenerationPin.test.ts` (13 케이스) | 루트 `npm run test:release-pipeline` — 셋을 한 번에 돈다. **릴리즈 빌드를 세 번 깨뜨린 것들을 지키는 가드이므로 릴리즈 전에 반드시 돌릴 것** |

주의할 것:

- **exit code 를 회귀 신호로 믿을 수 없는 파일이 있다.** `server/src/ws/WsRouterSplitHandshake.test.ts` 는 `tests 28 / pass 14 / fail 0 / todo 14` 로 **exit 0** 을 반환하지만, 그 todo 14개는 실제로 assertion 이 깨진 채 `✖ failing tests:` 에 찍힌다(`3 !== 1` 등, 전부 "Wave-1 production unified limitation characterization"). 나중에 진짜로 green 이 되어도 exit code 는 그대로 0 이다.

  ⚠️ **그런데 `✖` 를 세는 방식은 작동하지 않는다** (2026-09-03 실측). `✖` 는 **절 제목 한 줄뿐**이고 항목 13개는 전부 **`⚠`** 로 렌더링된다. 그래서 `grep -c '✖'` 는 절 제목 **1** 만 세고, 지침을 성실히 따른 사람도 "대조했는데 깨진 것이 없다"고 보고하게 된다. **`test at …` 줄 수를 세라 — 13이다.** `grep -c '⚠'` 는 **26** 이 나온다(항목이 실행 목록과 실패 절에 각각 한 번씩 렌더링된다). `⚠` 를 쓰려면 중복을 제거해야 13 이다. 오류 종류는 AssertionError 11 · TypeError 1 · ZodError 1 이다. 참고로 node 가 보고하는 todo 는 **14** 인데 렌더링된 목록은 **13** 이며, 남은 하나는 실행 목록에도 실패 절에도 나타나지 않는다.
- **`server/src/services/TerminalAuthorityProductionRegression.test.ts` 는 위 표의 커맨드로 green 이 될 수 없다** (2026-08-19 실측, 13건 실패). `readFileSync(new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url))` 로 **소스 텍스트를 읽는데**, `npx tsx --test src/…` 로 돌리면 `import.meta.url` 이 `src/` 를 가리켜 `.js` 가 없다(`.ts` 만 있다). import 는 tsx 가 해석하지만 `readFileSync` 는 못 한다. 이 파일은 **컴파일된 `dist/` 를 대상으로만 성립**한다.
- **스위트가 서로를 spawn 한다. 격리돼 있지 않다.** (아래는 확인된 것이며 닫힌 목록이 아니다)
  - `tools/wave3` 증거 스크립트들이 `server/src` 테스트, `frontend/tests/unit` 테스트, 다른 wave3 파일을 직접 실행한다.
  - **재귀 게이트**: `fair-readmission-closure-v3.admission-gate.test.mjs` 가 형제 closure 스위트 **21개 전부**를 `node --test` 로 재실행한다(약 113초). 이것과 형제 20개를 함께 파일별로 돌리면 **중첩 2단계로 중복 실행**된다.
  - ⚠️ **`boundary-gate.test.mjs` 는 형제를 재실행하지 않는다 — 공허하게 통과한다** (2026-08-19 Node 24 실측, 최소 프로브로 재현). `:35` 의 `spawnSync` 에 `env` 지정이 없어 **`NODE_TEST_CONTEXT` 를 그대로 상속**하고, node 의 재귀 가드가 `skipping running files` 로 **0개 실행 후 exit 0** → `assert.equal(status, 0)` 이 공허 통과한다. 게이트 내부 소요 **84ms** vs 같은 9개를 셸에서 직접 돌린 **30초 안팎**이 그 증거다(재측정 98ms 대 28,660~36,265ms — 절대값은 흔들려도 자릿수 차이는 흔들리지 않는다). `admission-gate` 는 `:63` 에서 `NODE_TEST_*` 를 필터링한다 — **공허 통과를 가르는 것이 그 한 줄**이다(두 게이트는 대상 파일 목록과 timeout 도 다르다).

    **그 green 이 무엇을 덮는지는 어디서 돌리느냐에 달려 있다** (2026-09-03 실측). **워크트리에서 돌리면** 9개 중 5개가 개별 실행에서 red 이고 9개를 한 번에 돌리면 exit 1 이라, 재귀 가드가 삼키지 않았다면 통과할 수 없다. 다만 **그 red 는 코드의 성질이 아니다** — red 5개는 전부 `const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';` 로 **본 체크아웃 경로를 하드코딩**하고 있고(`…strict.test.mjs:6` · `…test.mjs:6` · `…hardening:6` · `…ingress:5` · `…wave:7`), green 4개(`remediation`·`reparse`·`batch`·`snapshot`)는 그 하드코딩이 없다. 상관이 완전하다. `fair-readmission-closure-v3.mjs:72` 가 `COLLECTOR_WORKSPACE_ROOT` 를 `import.meta.url` 에서 유도하므로 워크트리에서는 둘이 어긋난다. **판별자는 실패 메시지다.** `workspace root must equal the collector-derived workspace root` 면 경로 하드코딩 탓이니 그 스위트를 고치러 가지 말고, **다른 메시지면 진짜 결함이다.** 실측된 실패 6건은 전부 앞엣것이었다. 본 체크아웃에서는 통과할 수 있을 것으로 보이나 그것까지 확인하지는 않았다.

    **`admission-gate` 도 통과하지 못한다 — 다른 이유로.** 형제를 실제로 재실행하지만 `spawnSync` 가 **ETIMEDOUT** 으로 죽는다(wall 118,266ms). `.internal-core-race` 하나가 단독 **2분 안팎**(측정에 따라 120,677ms ~ 202초)이라 구조적으로 시간 안에 끝나지 않는다.
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
  - **기준선과 대조할 때**: `git stash` 를 쓰지 말고(스택을 다른 체크아웃과 공유하며 다른 세션이 동시에 push/pop 한다) `git worktree add --detach <임시경로> HEAD` 를 쓴다. **그 사본에는 gitignore 된 파일이 따라오지 않는다** — `server/config.json5` 가 없어 그것을 읽는 테스트가 기준선에서만 실패하고, 그러면 **워킹트리가 오히려 개선된 것처럼 보이는 거짓 대조**가 된다(2026-09-03 실측: 기준선 `0 pass / 7 fail` 대 워킹트리 `11 pass`, 파일을 복사해 재대조하니 `15/13/0`). **필요한 런타임 파일을 복사해 넣고, 무엇을 복사했는지 기록한다.** 그리고 워크트리 이름에 **커밋을 담아라** — `baseline` 같은 이름은 그것이 어느 커밋인지 말해 주지 않아 다음 사람이 오인한다.
  - 테스트만 돌릴 의도라면 cwd=`server/` 에서 `npx tsx src/test-runner.ts` (build 를 타지 않음). 단 이 러너는 `*.test.ts` 를 디스커버리하지 않으므로 이것만으로는 회귀 커버리지가 되지 않는다.

**루트에는 `test` 스크립트가 없다** — `npm test` 는 루트에서 `Missing script` 로 실패한다. server 용은 `npm --prefix server test`. 루트의 test 스크립트 4개(`test:daemon`, `test:daemon:wave5`, `test:docs`, `test:integration:native-daemon`)는 전부 `tools/daemon/` 만 겨냥한다. 어느 한 명령을 돌리고 "테스트 통과"로 보고하지 말 것.

- **규칙**:
  1. 버그를 재현하는 실패 케이스 테스트 추가
  2. 버그 픽스 후 통과 케이스 테스트 추가
  3. 경계값(예: 설정 false일 때 기존 동작 유지) 테스트도 추가
  4. `makeAuthHarness` 등 기존 하네스 확장 시 모든 기존 테스트와의 호환성 유지

### E2E 테스트
- **기존 자산**(2026-09-03 실측): `frontend/tests/e2e/` 에 `*.spec.ts` **37개**, `frontend/tests/unit/` **92개**, `frontend/tests/benchmarks/` `*.test.ts` 2개. 설정은 `frontend/playwright.config.ts`. **새로 짜기 전에 기존 spec 을 먼저 확인한다.**
- **실행**: frontend 에서 `npx playwright test [spec]` — 수집 대상은 **37개 파일 / 651 테스트**다 (project 3종 `Desktop Chrome`·`Mobile Safari`·`Tablet` 을 전부 돌기 때문). `--project "Desktop Chrome"` 단독은 **217개**다. 저장소의 `test:e2e:*` 스크립트는 전부 `--project "Desktop Chrome"` 로 고정돼 있다. MCP playwright 도구는 대화형 확인용 보조 수단.
- **Playwright 가 안 돌리는 것** (전부 node:test 이므로 **cwd=`frontend/`** 에서 `node --experimental-strip-types --test <파일>` 로 직접 실행):
  - `tests/unit/` 92개 — `testDir` 이 `./tests/e2e` 라 수집 대상이 아니다.
  - `tests/benchmarks/` 2개 — 같은 이유. 이것을 도는 npm 스크립트도 없다.
  - `tests/e2e/wave1-characterization-artifacts.test.ts` — `tests/e2e/` 안에 있지만 `node:test` 파일이라 Playwright 가 **0건 수집**한다. 이것을 도는 npm 스크립트가 없으므로 위 커맨드로 직접 돌려야 한다.
- **주의**: `playwright.config.ts` 의 `reuseExistingServer: true` 때문에 2222 에 이미 떠 있는 서버가 있으면 그것을 그대로 쓴다. `webServer` 는 `start.bat` 으로 **프로덕션 빌드**를 띄우므로, `dev.js` 가 떠 있는 상태로 돌리면 dev 번들을 검사하게 된다. **자기 포트를 쓰려면 `PLAYWRIGHT_BASE_URL=https://localhost:<포트>` 를 반드시 명시한다** — 빼면 남의 인스턴스를 잡는다.

**자기 포트에 서버를 새로 띄워 돌릴 때의 함정 넷** (전부 2026-09-03 실측):

1. **새 포트 인스턴스는 워크스페이스가 비어 있다.** `waitForTerminal` 을 쓰는 spec 이 전부 실패한다 — 화면에 "터미널을 추가하세요" 와 `+ Add Terminal` 만 있고 `.xterm-screen` 이 끝내 나오지 않는다. **2222 에서 이것이 안 보이는 이유는 이전 실행이 남긴 탭이 있어서**이며, 곧 기존 spec 들이 남이 남긴 상태에 기대고 있다는 뜻이다. 서버 로그에 `"totalSessions":0` 이 보이면 그것이다. 터미널을 시드할 때 **탭 존재 여부를 DOM 이 아니라 `GET /api/workspaces` 에 물어라** — 워크스페이스 상태가 첫 페인트 뒤에 도착하므로 DOM 을 믿은 검사는 곧 언마운트될 버튼을 눌러 `element was detached from the DOM` 으로 깨진다.
2. **그런데 시드는 딜레마다.** 시드하면 `waitForTerminal` 계열 28개가 살아나지만 **탭 수 산술에 의존하는 spec 이 그 시드 때문에 깨진다**(`markdown-editor-placement:410`, `grid-equal-mode`). **시드가 필요한 spec 과 필요 없는 spec 을 나눠 돌려라.**
3. **한 인스턴스로 spec 을 연달아 돌리면 노후한다.** `tab create failed: 500` 이 나기 시작하고 **매 실행마다 다른 케이스가 빨개진다.** 같은 spec 을 두 번 돌렸는데 실패 케이스가 다르면 그것은 제품이 아니라 인스턴스다. 판정하지 말고 새로 띄워 다시 재라. (다만 로그의 `cleanup: {attempted N, completed 0, unverifiedSkipped N}` 은 **노후 지표가 아니다** — 신선한 인스턴스에서도 같은 값이 나오는 상시 기준선이고 프로세스 누수도 아니다.)
4. **백그라운드로 띄운 서버가 약 60분에 사라지는 것이 두 차례 관측되었다**(07:12→08:10, 08:20→09:20). 원인은 규명되지 않았고 표본도 둘뿐이니 상수로 믿지 말 것 — 다만 **긴 실행이 서버 없이 끝날 수 있다는 사실만으로 대비할 이유는 충분하다.** 전수 회귀처럼 오래 걸리는 실행에서 **뒷부분이 서버 없이 실패하고, 그 실패는 제품 결함과 구분되지 않는다.** 한 시간 넘게 걸릴 실행은 분리 기동으로 시작하고, 끝난 뒤 `/health` 로 서버가 살아 있었는지 확인해야 그 결과를 믿을 수 있다.

- **타입 검사는 테스트 파일 82개에 닿지 않는다** (2026-09-03 실측). `npx tsc -b` 의 참조는 `editor`·`app`·`node` 뿐이라 **테스트 파일을 하나도 보지 않고**, `tsconfig.test.json` 은 `include` 가 아니라 **`files` 허용목록**이며 47개만 담는다(`tests/e2e` 는 0개). 결과적으로 e2e spec **37개 전부**와 단위 테스트 **92개 중 45개**가 어떤 tsconfig 에도 없다. **새 테스트는 명시 등재하지 않는 한 영원히 검사 밖이다** — 이번 작업에서 일곱을 등재하자마자 숨어 있던 `TS2367` 셋이 드러났다. 단 그 미등재는 **의도된 선택**이다(파일 주석 "Deliberately NOT listed"): 테스트 전용 타입 오류가 `npm run build` 와 CI 를 깨뜨리지 않게 하려는 것이므로, solution 에 그냥 등재하면 빌드가 깨진다. 검사하려면 `npx tsc -p tsconfig.test.json --noEmit` 을 따로 돌린다.
- **규칙**:
  1. UI/브라우저 동작에 영향을 주는 버그 픽스는 E2E 테스트 필수
  2. 서버 실행 상태에서 `https://localhost:2222` 대상으로 테스트 — **자기 인스턴스를 띄웠다면 `PLAYWRIGHT_BASE_URL` 로 그 포트를 명시한다**(그러지 않으면 `reuseExistingServer` 가 2222 의 남의 인스턴스를 잡는다)
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
