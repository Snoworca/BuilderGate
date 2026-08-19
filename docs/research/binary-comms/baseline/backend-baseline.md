# 회귀 기준선 (S-1) — 백엔드 (서버 불필요 node:test 계열)

바이너리 전환 작업 **착수 전** 시점의 "이미 깨져 있는 것" 스냅샷이다.
**아무것도 고치지 않았고, 어떤 파일도 수정하지 않았으며, 커밋하지 않았다.**
나중에 red 가 나오면 이 문서와 대조하여 *우리가 깬 것* / *원래 깨져 있던 것* 을 가른다.

## 0. 측정 환경

| 항목 | 값 |
|---|---|
| 측정 시각 | 2026-08-18 ~ 2026-08-19 (KST). 그룹 A 1차 시작 `2026-08-19T00:07:11+09:00` |
| `git rev-parse HEAD` | `eb2f4f89b7a40c0461d11866b0a36f5bc2b4b8a9` |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| 워킹트리 | 추적 수정(` M`) **121** / 미추적 파일(`--untracked-files=all`) **1243** — 즉 **HEAD 가 아니라 미커밋 워킹트리를 측정한 값**이다 |
| node | v24.16.0 |
| 플랫폼 | Windows 11, Git Bash |
| 환경변수 | 모든 실행을 `env -u NODE_ENV` 로 감쌌다 (`NODE_ENV=production` 시 devDependencies 누락 함정 회피) |

**범위 밖(다른 에이전트 담당)**: `tools/wave3/` 전부, Playwright E2E, frontend 테스트.

---

## 1. 요약표

| 그룹 | 대상 | 대상 수 | tests | pass | fail | exit code | 소요 |
|---|---|---|---|---|---|---|---|
| **A** | `server/src/test-runner.ts` (모놀리식 러너) | 1 러너 | 530 | 509 | **21** | **1** | 60초 |
| **B** | `server/src/**/*.test.ts` | 37 파일 | 562 | 525 | **23** | 32 파일 `0` / **5 파일 `1`** | 305초 (5분 5초) |
| **C** | `tools/daemon/*.test.js` (`npm run test:daemon`) | 19 파일 | 204 | 196 | **8** | **1** | 테스트 구간 1.9초 (+ server build·pkg exe build 포함 wall-clock 미계측) |
| **F** | `tools/wave1/*.test.mjs` 1 + `server/tools/*.test.{cjs,mjs}` 2 | 3 파일 | 9 | 9 | **0** | **0** (3개 모두) | 0.6초 |
| **합계** | | | **1305** | **1239** | **52** | | |

> **B 그룹의 pass 합(525)** 은 `562 - fail 23 - todo 14` 다. `todo 14` 는 §4.1 참조.

### 결정성 확인
그룹 A 를 2회 실행했고 **실패 집합이 완전히 동일**했다 (`diff` 결과 0 라인). 즉 A 의 21건은 flaky 가 아니다.

### 빌드 상태 (중요)
그룹 C 의 `npm run test:daemon` 이 유발한 **server build 는 성공**했다.
`write-fair-scheduler-evidence-bundle.mjs` 가 `{"evidenceRoot":"dist/benchmarks/fair-scheduler-evidence","fileCount":19,"generationId":"0f98a0454f472d505423af5dea0d8a1545c4431df17ad8c13db187886ed084e8"}` 를 출력하고 정상 종료했다.
→ **`docs/analysis/terminal-fairness-authority/` sha256 매니페스트 재검증은 현재 green** 이며, 아래 실패 중 provenance 핀에 기인한 것은 **없다**. (사전 정보와 일치)

---

## 2. 그룹 B 파일별 결과 (37개 전수)

| # | 파일 | exit | tests | pass | fail | 초 |
|---|---|---|---|---|---|---|
| 1 | `src/benchmarks/FairSchedulerEvidenceBundleRuntime.test.ts` | 0 | 3 | 3 | 0 | 14 |
| 2 | `src/benchmarks/FairSchedulerEvidenceIntegrity.test.ts` | 0 | 16 | 16 | 0 | 21 |
| 3 | `src/benchmarks/FairSchedulerRuntimePolicyProfile.test.ts` | 0 | 10 | 10 | 0 | 18 |
| 4 | `src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts` | 0 | 4 | 4 | 0 | 12 |
| 5 | `src/benchmarks/benchmarkStatistics.test.ts` | 0 | 6 | 6 | 0 | 1 |
| 6 | `src/benchmarks/retainedStateLegacyBoundary.test.ts` | 0 | 1 | 1 | 0 | 1 |
| 7 | `src/benchmarks/terminalCharacterization.test.ts` | 0 | 8 | 8 | 0 | 58 |
| 8 | `src/benchmarks/terminalFairnessCharacterization.test.ts` | 0 | 14 | 14 | 0 | 29 |
| 9 | `src/routes/terminalAuthorityDebugRoutes.guard.test.ts` | 0 | 5 | 5 | 0 | 1 |
| 10 | `src/schemas/config.schema.test.ts` | 0 | 10 | 10 | 0 | 1 |
| 11 | `src/services/AuthService.test.ts` | 0 | 1 | 1 | 0 | 2 |
| 12 | `src/services/ConfigFileRepository.resourceLimits.test.ts` | 0 | 1 | 1 | 0 | 2 |
| 13 | `src/services/FileService.test.ts` | 0 | 1 | 1 | 0 | 2 |
| **14** | **`src/services/RetainedTerminalAuthority.test.ts`** | **1** | 41 | 40 | **1** | 15 |
| 15 | `src/services/RuntimeConfigStore.test.ts` | 0 | 4 | 4 | 0 | 2 |
| 16 | `src/services/SessionManager.test.ts` | 0 | 1 | 1 | 0 | 3 |
| **17** | **`src/services/SessionManagerPartialEscapeTail.test.ts`** | **1** | 9 | 4 | **5** | 3 |
| 18 | `src/services/SessionManagerTerminalAuthorityDebugIsolation.test.ts` | 0 | 12 | 12 | 0 | 4 |
| 19 | `src/services/SessionManagerTerminalAuthorityRuntimePorts.test.ts` | 0 | 12 | 12 | 0 | 4 |
| 20 | `src/services/SettingsService.resourceLimits.test.ts` | 0 | 4 | 4 | 0 | 3 |
| 21 | `src/services/TerminalAuthorityController.test.ts` | 0 | 147 | 147 | 0 | 40 |
| 22 | `src/services/TerminalAuthorityDebugService.test.ts` | 0 | 47 | 47 | 0 | 2 |
| **23** | **`src/services/TerminalAuthorityProductionRegression.test.ts`** | **1** | 38 | 25 | **13** | 2 |
| **24** | **`src/services/TerminalResourcePolicy.test.ts`** | **1** | 20 | 17 | **3** | 4 |
| **25** | **`src/services/TerminalResourcePolicyCanary.test.ts`** | **1** | 26 | 25 | **1** | 15 |
| 26 | `src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` | 0 | 1 | 1 | 0 | 3 |
| 27 | `src/types/wsCheckpointProtocol.test.ts` | 0 | 3 | 3 | 0 | 1 |
| 28 | `src/utils/configTemplate.test.ts` | 0 | 2 | 2 | 0 | 1 |
| 29 | `src/utils/headlessTerminal.test.ts` | 0 | 2 | 2 | 0 | 1 |
| 30 | `src/utils/terminalQueryResponder.test.ts` | 0 | 1 | 1 | 0 | 4 |
| 31 | `src/ws/FairTerminalDeliveryScheduler.test.ts` | 0 | 15 | 15 | 0 | 2 |
| 32 | `src/ws/WsRouterCheckpointProtocol.test.ts` | 0 | 15 | 15 | 0 | 2 |
| 33 | `src/ws/WsRouterRestoreMetadata.test.ts` | 0 | 3 | 3 | 0 | 9 |
| 34 | `src/ws/WsRouterSendPriority.test.ts` | 0 | 41 | 41 | 0 | 17 |
| 35 | `src/ws/WsRouterSplitHandshake.test.ts` | 0 | 28 | 14 | 0 (**todo 14 실패**) | 3 |
| 36 | `src/ws/wsSendPolicyRestoreMetadata.test.ts` | 0 | 4 | 4 | 0 | 2 |
| 37 | `src/ws/wsTransportMode.test.ts` | 0 | 6 | 6 | 0 | 1 |

---

## 3. 실패 목록

추정 원인 분류: `미커밋 작업` / `환경` / `빌드` / `실제 결함` / `불명`.
분류는 **관측한 에러 메시지와 워킹트리 상태만으로** 판단했고, 근본원인 진단은 하지 않았다.

### 3.1 그룹 A — `server/src/test-runner.ts` (21건)

| # | 테스트명 | 실패 메시지 요지 | 추정 원인 |
|---|---|---|---|
| A-1 | SessionManager keeps immediate shell Ctrl+C repaint idle | `'running' !== 'idle'` — an immediate Ctrl+C prompt repaint must not become semantic shell activity (`test-runner.ts:4061`) | 불명 |
| A-2 | SessionManager keeps delayed shell Ctrl+C prompt return idle | `'running' !== 'idle'` (`test-runner.ts:4080`) | 불명 |
| A-3 | SessionManager keeps delayed PowerShell-shaped Ctrl+C prompt return idle when shell metadata is stale | `'running' !== 'idle'` (`test-runner.ts:4099`) | 불명 |
| A-4 | SessionManager keeps PowerShell prompt redraw idle in heuristic mode | `'running' !== 'idle'` (`test-runner.ts:4615`) | 불명 |
| A-5 | SessionManager preserves unsnapshotted healthy output when degrading | `TypeError: Cannot read properties of undefined (reading 'toString')` @ `SessionManager.ts:4391` | 미커밋 작업 |
| A-6 | SessionManager preserves queued output when degradation happens before headless writes flush | 동일 TypeError | 미커밋 작업 |
| A-7 | SessionManager does not duplicate flushed output when later queued output is still pending at degradation time | 동일 TypeError | 미커밋 작업 |
| A-8 | SessionManager does not duplicate queued output on direct write failure | 동일 TypeError | 미커밋 작업 |
| A-9 | SessionManager bounded headless queue degrades on delayed chunk cap overflow | 동일 TypeError | 미커밋 작업 |
| A-10 | SessionManager bounded headless queue degrades on delayed byte cap overflow | 동일 TypeError | 미커밋 작업 |
| A-11 | SessionManager bounded headless queue counts multibyte output as UTF-8 bytes | 동일 TypeError | 미커밋 작업 |
| A-12 | SessionManager bounded headless overflow clears queue telemetry | 동일 TypeError | 미커밋 작업 |
| A-13 | SessionManager observe headless queue overflow degrades without unbounded pending output | 동일 TypeError | 미커밋 작업 |
| A-14 | SessionManager observe headless queue preserves bounded pending output on degradation | 동일 TypeError | 미커밋 작업 |
| A-15 | SessionManager degraded overflow starts ready-subscriber fallback recovery | 동일 TypeError | 미커밋 작업 |
| A-16 | SessionManager routes bounded output only after headless write commit | 동일 TypeError | 미커밋 작업 |
| A-17 | WsRouter fences input and output while atomic restore authority retries | `'screen-snapshot' !== 'session:ready'` (`test-runner.ts:15134`) | 불명 |
| A-18 | WsRouter reports replay observability counters | `1 !== 0` (`test-runner.ts:15776`) | 불명 |
| A-19 | WsRouter queues output while screen repair is generating | 동일 TypeError @ `SessionManager.ts:4391` | 미커밋 작업 |
| A-20 | WsRouter queues output during repair replay until ACK | `'screen-snapshot' !== 'session:ready'` (`test-runner.ts:18277`) | 불명 |
| A-21 | WsRouter does not duplicate deferred degraded payload after fallback snapshot ack | 동일 TypeError @ `SessionManager.ts:4391` | 미커밋 작업 |

### 3.2 그룹 B (23건)

| # | 파일 | 테스트명 | 실패 메시지 요지 | 추정 원인 |
|---|---|---|---|---|
| B-1 | `RetainedTerminalAuthority.test.ts` | RED reviewer — populated Ordinal64 rollover keeps oldest retained marker epoch-qualified | `AssertionError: REL-BGSTAB-011 AC-1/AC-2 populated rollover mislabeled old-epoch retained markers` — actual 에 `oldestRetainedSeq: '0'` 가 추가로 존재 | 불명 |
| B-2 | `SessionManagerPartialEscapeTail.test.ts` | server RED — atomic authority revision race | `TypeError: Cannot read properties of undefined (reading 'toString')` @ `SessionManager.ts:4391` (호출: 테스트 `ingest` L101) | 미커밋 작업 |
| B-3 | 〃 | server RED — unstable pending-write authority | 동일 TypeError | 미커밋 작업 |
| B-4 | 〃 | server RED — split terminal escape ingest | 동일 TypeError | 미커밋 작업 |
| B-5 | 〃 | server RED — split C1 CSI OSC and DCS stay incomplete until final ST CAN or SUB | 동일 TypeError | 미커밋 작업 |
| B-6 | 〃 | server RED — pending tail sequence attachment | 동일 TypeError | 미커밋 작업 |
| B-7 ~ B-19 | `TerminalAuthorityProductionRegression.test.ts` | (13건 전부) MIG-BGSTAB-002 계열 — `rollback held query transfer invokes the exact compatibility responder port`, `production adapter hard reload rebinds the live view and sends fresh recovery`, `promotion defers an acknowledged view until server authority is committed`, `rollback start stays on terminal delivery while legacy enable gates control replay`, `rollback selects the suspended driver and withholds attributes challenges from passive peers`, `accepted owner keeps its attributes challenge for recovery capability refresh`, `a stale precommit driver identity cannot reject a replacement view attributes push`, `a replacement attributes handshake takes precedence over a stale precommit driver`, `an unrelated precommit lease cannot become the responder identity fallback`, `exact precommit and pending identities retain their full generation tuples`, `rollback topology churn coalesces to one leading-edge recovery window`, `a subscription-ready observer cannot rotate a still-open browser mutation owner`, `an already reserved view recovery cannot create a second checkpoint lifecycle` | 13건 **모두** `Error: ENOENT: no such file or directory, open 'server\src\services\TerminalAuthorityProductionAdapter.js'` | 환경 |
| B-20 | `TerminalResourcePolicy.test.ts` | Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-6 | `Error: required terminal resource consumer scope mismatch: frontend/src/components/Terminal/TerminalContainer.tsx#…@127825#onOutput scopes=…@130025#onOutput` | 미커밋 작업 |
| B-21 | 〃 | OBS-BGSTAB-005 review regression — exact repository tuples validate bidirectionally and detect new callsites | 동일 scope mismatch (`@127825` 기대 vs `@130025` 관측) | 미커밋 작업 |
| B-22 | 〃 | OBS-BGSTAB-005 third review regression — catalog evidence must be executable and remain in the intended symbol scope | 동일 scope mismatch | 미커밋 작업 |
| B-23 | `TerminalResourcePolicyCanary.test.ts` | PERF-BGSTAB-010 source canonical resolver rejects noncanonical authority | `Error: authority resolver root option is unsupported` | 불명 |

### 3.3 그룹 C — `npm run test:daemon` (8건)

| # | 파일 | 테스트명 | 실패 메시지 요지 | 추정 원인 |
|---|---|---|---|---|
| C-1 | `tools/daemon/build-portable-runtime.test.js:202` | validatePortableBuildOutput admits a real compiled fair bundle and rejects its missing staging marker | `ENOENT … buildergate-portable-output-dCreKV\server\dist\benchmarks\fair-scheduler-evidence\fair-scheduler-decision.json.publication.json` | 불명 |
| C-2 | `tools/daemon/native-daemon.integration.test.js:152` | source foreground Ctrl+C in a terminal lets the app child flush before exit | `AssertionError: foreground PTY harness failed` — stdout 에 `[start] Deployment dist already exists. Skipping install/build.` / `HTTPS: https://localhost:24670`, 이후 `Error: write EPIPE` | 환경 |
| C-3 | `tools/daemon/node-pty-windows-hide.test.js:20` | node-pty ConPTY helper fork is patched with windowsHide | deep-equal 불일치 — actual 에 `'[prebuild] node-pty Windows runtime patches applied.'` 가 추가로 존재 | 환경 |
| C-4 | `tools/daemon/node-pty-windows-hide.test.js:39` | node-pty hidden-console patch is idempotent | deep-equal 불일치 — actual 에 `'[prebuild] node-pty Windows runtime patches already applied.'` 가 추가로 존재 | 환경 |
| C-5 | `tools/daemon/start-runtime-compat.test.js:120` | --bootstrap-allow-ip is passed through runtime env and is not persisted to config | `assert.ok(env.BUILDERGATE_TOTP_SECRET_PATH.endsWith(path.join('server','data','totp.secret')))` 가 falsy | 환경 |
| C-6 | `tools/daemon/start-runtime-compat.test.js:190` | existing deployment artifacts still stage the latest frontend build | `Error: Staging directory escaped runtime root: C:\Work\agent-tools\builder-gate__\web` | 환경 |
| C-7 | `tools/daemon/start-runtime-compat.test.js:213` | deployment artifacts require every local asset referenced by index.html | `true !== false` | 환경 |
| C-8 | `tools/daemon/terminal-snapshot-quota.test.js:71` | terminal snapshot eviction removes old snapshots while preserving the current session save | `false !== true` | 불명 |

> C-2/C-5/C-6/C-7 은 저장소 밖의 기존 배포 디렉터리 `C:\Work\agent-tools\builder-gate__` 와 포트 24670 프로덕션 기동에 의존한다. C-3/C-4 는 같은 커맨드가 선행 실행한 `prebuild`(`ensure-node-pty-windows-hide.cjs`) 로 상태가 이미 patched 라서 기대 출력과 어긋난다(스위트 간 격리 부재).

### 3.4 그룹 F (0건)

실패 없음. 3개 파일 모두 exit 0.

---

## 4. 주의: fail 로 집계되지 않지만 red 인 것

### 4.1 `WsRouterSplitHandshake.test.ts` — `todo` 14건이 실제로 실패 중
`ℹ tests 28 / pass 14 / fail 0 / todo 14`, exit code **0**.
`todo` 로 표시된 14개가 `✖ failing tests:` 섹션에 assertion 과 함께 출력되지만 node:test 는 이를 fail 로 세지 않는다.
주석은 전부 `# Wave-1 production unified limitation characterization` 이며, 예: `WsRouter split output connection does not handle subscribe traffic` (`3 !== 1`), `WsRouter split duplicate output connection closes and removes the previous output socket` (`true !== false`).
→ **이 14건이 나중에 green 으로 바뀌어도 exit code 는 그대로 0 이다.** 이 파일에서 회귀를 보려면 exit code 가 아니라 `todo` 카운트와 `✖` 목록을 대조해야 한다.

### 4.2 A 와 B 는 disjoint
`server/src/test-runner.ts` 는 `*.test.ts` 를 디스커버리하지 않는다. 그룹 A 530건과 그룹 B 562건은 겹치지 않는다.

---

## 5. 원인 클러스터 (동일 근인으로 묶이는 실패)

| 클러스터 | 건수 | 관측된 공통 시그니처 | 분류 |
|---|---|---|---|
| **K1. `SessionManager.queueAcceptedHeadlessOutput` TypeError** | **19** (A-5~A-16, A-19, A-21 = 14 · B-2~B-6 = 5) | `TypeError: Cannot read properties of undefined (reading 'toString')` @ `server/src/services/SessionManager.ts:4391` — `sessionData.nextTerminalAuthoritySourceSeq` 가 undefined. `SessionManager.ts` 와 `test-runner.ts` 둘 다 미커밋 수정 상태 | 미커밋 작업 |
| **K2. `TerminalAuthorityProductionAdapter.js` ENOENT** | 13 | 테스트가 `readFileSync(new URL('./TerminalAuthorityProductionAdapter.js', import.meta.url))` 로 **소스 텍스트**를 읽는데, `npx tsx --test src/…` 실행 시 `import.meta.url` 이 `src/` 를 가리켜 `.js` 가 존재하지 않음(`.ts` 만 있음). import 는 tsx 가 해석하지만 `readFileSync` 는 못 함 | 환경 (실행 방식 불일치) |
| **K3. Ctrl+C / PowerShell 프롬프트 재도색이 `running` 으로 분류됨** | 4 | `'running' !== 'idle'` (A-1~A-4) | 불명 |
| **K4. WsRouter 최종 메시지가 `screen-snapshot`** | 2 | `'screen-snapshot' !== 'session:ready'` (A-17, A-20) | 불명 |
| **K5. terminal resource consumer scope 오프셋 핀 불일치** | 3 | `TerminalContainer.tsx` 의 기대 오프셋 `@127825` vs 실제 `@130025`. 해당 파일은 미커밋 수정 상태(` M frontend/src/components/Terminal/TerminalContainer.tsx`) | 미커밋 작업 |
| **K6. daemon 스위트의 외부 배포 디렉터리 의존** | 4 | `C:\Work\agent-tools\builder-gate__` 경로, 포트 24670 프로덕션 기동, EPIPE (C-2, C-5, C-6, C-7) | 환경 |
| **K7. prebuild 상태 오염** | 2 | 같은 커맨드가 선행 실행한 `prebuild` 때문에 node-pty 패치 로그가 기대와 다름 (C-3, C-4) | 환경 |
| **K8. 단발** | 5 | A-18 (replay observability counters `1 !== 0`), B-1 (Ordinal64 rollover), B-23 (authority resolver root option), C-1 (portable `publication.json` ENOENT), C-8 (snapshot eviction) | 불명 |

합계 검산: 19 + 13 + 4 + 2 + 3 + 4 + 2 + 5 = **52**. K1 이 전체 52건 중 최대 클러스터다.

**분류가 `빌드` 인 실패는 0건.** server build 는 성공했고 provenance/evidence 매니페스트 게이트는 green 이다.

---

## 6. 실행 커맨드 전문 (재현용)

셸은 Git Bash. 모든 실행 앞에 `env -u NODE_ENV` 를 붙인다.

### 그룹 A
```bash
cd /c/Work/git/_Snoworca/ProjectMaster/server
env -u NODE_ENV npx tsx src/test-runner.ts
# 결과 집계
#   grep -c '^PASS ' <log>   -> 509
#   grep -c '^FAIL ' <log>   -> 21
#   exit code                -> 1
```

### 그룹 B (37파일, 파일별 개별 실행)
```bash
cd /c/Work/git/_Snoworca/ProjectMaster/server
for f in $(ls src/benchmarks/*.test.ts src/routes/*.test.ts src/schemas/*.test.ts \
              src/services/*.test.ts src/types/*.test.ts src/utils/*.test.ts src/ws/*.test.ts); do
  env -u NODE_ENV npx tsx --test "$f"
  echo "$f exit=$?"
done
# 파일별 집계는 로그의 'ℹ tests / ℹ pass / ℹ fail / ℹ todo' 라인을 읽는다.
```

### 그룹 C
```bash
cd /c/Work/git/_Snoworca/ProjectMaster
env -u NODE_ENV npm run test:daemon
# = npm --prefix server run build && node --test tools/daemon/*.test.js
# server build(prebuild → tsc → provenance → evidence-bundle → shell-integration copy)를 선행한다.
```

### 그룹 F
```bash
cd /c/Work/git/_Snoworca/ProjectMaster
env -u NODE_ENV node --test tools/wave1/g1-decision-gate.test.mjs
env -u NODE_ENV node --test server/tools/write-fair-scheduler-evidence-bundle.test.mjs
env -u NODE_ENV node --test server/tools/ensure-node-pty-windows-hide.test.cjs
```

### 결정성 재확인 (그룹 A)
```bash
cd /c/Work/git/_Snoworca/ProjectMaster/server
env -u NODE_ENV npx tsx src/test-runner.ts > run1.log 2>&1
env -u NODE_ENV npx tsx src/test-runner.ts > run2.log 2>&1
diff <(grep '^FAIL ' run1.log | sort) <(grep '^FAIL ' run2.log | sort)   # -> 차이 없음
```

---

## 7. 이 기준선을 쓰는 법

1. 코드 작업 후 red 가 나오면, 먼저 §3 의 테스트명·메시지와 **정확히 일치**하는지 본다. 일치하면 신규 회귀가 아니다.
2. §5 의 클러스터 단위로 보라. K1(19건)·K2(13건)은 한 줄짜리 원인으로 32건을 설명한다. 이 32건이 사라지거나 늘어나는 것은 신호다.
3. `WsRouterSplitHandshake.test.ts` 는 exit code 로 판단하지 말 것 (§4.1).
4. 그룹 C 는 로컬 환경(`C:\Work\agent-tools\builder-gate__`, 포트 24670)에 의존하므로 **다른 머신에서는 실패 집합이 달라질 수 있다.** 같은 머신 내 비교에만 쓴다.
5. 이 문서는 HEAD `eb2f4f89` **+ 미커밋 워킹트리** 를 측정한 것이다. 워킹트리가 커밋되거나 폐기되면 K1·K5 는 무효가 된다.
