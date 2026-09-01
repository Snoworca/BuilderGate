# 핸드오프 — 서버 러너 degradation 12건과 남은 백로그

작성: 2026-09-01

---

## 0. 다음 세션의 첫 행동

**서버 모놀리식 러너의 degradation 12건을 고친다.** 원인은 이미 특정되어 있으니 재조사하지 말고 곧바로 착수한다.

1. `cd C:\Work\git\_Snoworca\ProjectMaster\server` 에서 `npx tsx src/test-runner.ts > /tmp/base.log 2>&1` 을 돌려 **18 failed** 를 기준선으로 확보한다.
2. `grep -c "SessionManager.ts:4451" /tmp/base.log` 가 **14** 인지 확인한다. 이 값이 진단의 재확인이다.
3. 아래 "확정된 진단" 대로 고친다.
4. 완료 조건: `npx tsx src/test-runner.ts` 의 실패가 18 → **6 이하**로 줄고, 새로 생긴 실패 이름이 0건이다(`diff` 로 대조).

워크트리 분리는 사용자가 별도 세션에서 수행한다. 이 세션은 그 작업에 관여하지 않는다.

---

## 1. 최종 작업 목표

BuilderGate 의 **기존 실패 테스트(백로그 B 그룹)를 없애는 것**. 바이너리 데이터 평면 배선과 codex 워크스페이스 전환 버그는 끝났고, 지금 남은 것은 오래 빨간 상태로 방치된 계약들이다.

전체 백로그는 `C:\Work\git\_Snoworca\ProjectMaster\docs\plan\2026-09-01.remaining-work-backlog.plan.md` 에 A~E 로 정리되어 있다. A 는 완료, B 는 부분 완료다.

---

## 2. 확정된 진단 — degradation 12건의 공통 원인

**`server/src/services/SessionManager.ts:4451` 한 줄이 18건 중 14건을 던진다.**

```ts
sourceSeq: sessionData.nextTerminalAuthoritySourceSeq.toString() as Ordinal64,
```

던지는 예외는 `TypeError: Cannot read properties of undefined (reading 'toString')` 이다. 즉 `sessionData.nextTerminalAuthoritySourceSeq` 가 `undefined` 다.

확인한 사실:

| 사실 | 확인 방법 |
|---|---|
| 필드 선언은 `SessionManager.ts:854` 의 `nextTerminalAuthoritySourceSeq: bigint` | `grep -n` |
| 초기화는 `SessionManager.ts:1325` 한 곳뿐 (`createSession` 경로) | `grep -n` |
| `server/src/test-runner.ts` 안에 이 필드를 세우는 곳이 **0건** | `grep -c "nextTerminalAuthoritySourceSeq" server/src/test-runner.ts` → `0` |
| 세 개의 서로 다른 실패가 **같은 스택**(`queueAcceptedHeadlessOutput` → `SessionManager.ts:4451:61`)을 갖는다 | 러너 로그의 스택 대조 |

즉 러너의 세션 하네스가 `SessionData` 를 직접 조립하면서 이 필드를 빼먹었고, `queueHeadlessOutput` 을 타는 모든 테스트가 그 자리에서 죽는다.

**⚠️ 미검증** — 어느 하네스 함수가 그 `SessionData` 를 만드는지는 아직 특정하지 않았다. `server/src/test-runner.ts` 에서 `pendingHeadlessWrites: 0,` 을 세우는 객체 리터럴이 후보다(2026-08-31 에 `headlessApplyInFlight: 0,` 를 같은 자리 3곳에 추가한 적이 있으므로, 그 3곳이 유력하다). 다음 세션이 확인할 방법: `grep -n "pendingHeadlessWrites: 0," server/src/test-runner.ts`.

**고치는 방향 두 가지 중 하나를 고른다.**

- (A) 하네스 리터럴에 `nextTerminalAuthoritySourceSeq: 0n` 을 추가한다 — 테스트만 바뀐다.
- (B) `queueAcceptedHeadlessOutput` 이 `undefined` 를 견디게 한다 — 프로덕션이 바뀐다.

**(A) 를 먼저 검토하라.** 이 필드는 프로덕션 `createSession` 이 항상 세우므로, 프로덕션에서 `undefined` 가 되는 경로는 없다(위 grep 근거). 프로덕션에 방어 코드를 넣는 것은 존재하지 않는 상황에 대한 처리다.

다만 (A) 로 고쳤을 때 그 다음 단언이 무엇을 요구하는지는 **아직 모른다** — TypeError 가 나면서 본래 단언에 도달하지 못했기 때문이다. 12건이 전부 green 이 되리라 가정하지 마라. 두 번째 층의 실패가 드러날 수 있고, 그때는 각 테스트를 개별로 본다.

---

## 3. 현재까지 완료한 작업

`origin/main` 과 로컬 브랜치가 모두 `6b2ec15` 로 동일하다.

| 커밋 | 내용 |
|---|---|
| `5918146` | 서버 바이너리 데이터 평면 배선 + 세션 수명 결함 2건 |
| `c25d761` | 프론트 바이너리 프레임 디코딩 + 터미널 파괴 결함 3건 |
| `eb0fe96` | wave·daemon 도구 |
| `879a79c` | 설계·요구사항·보고서 문서 |
| `5dff287` | speckiwi 스킬·에이전트 설정 |
| `5f891dc` | codex 워크스페이스 전환 시 세션 종료 오진단 — 서버측 |
| `80b523c` | A 그룹 4건 (프로세스 트리 종료 · resize 검증 · 로그 회전 · 워크스페이스 누수) |
| `6b2ec15` | B 그룹 (EPIPE 서버 종료 · checkpoint fence · Ctrl+C 분류 · 신원 예산 · 계약 동기화 · E2E 직렬화) |

### 스위트 성적 (2026-09-01 실측)

| 스위트 | 실행 명령 (cwd) | 기준선 | 현재 |
|---|---|---|---|
| 서버 모놀리식 러너 | `npx tsx src/test-runner.ts` (`server/`) | 21 fail | **18 fail** |
| frontend unit | `node --experimental-strip-types --test tests/unit/*.test.ts` (`frontend/`) | 6 fail | **2 fail** (904 tests / 902 pass) |
| E2E 3개 스펙 | `npx playwright test tests/e2e/terminal-authority.spec.ts tests/e2e/header-context-menu-regression.spec.ts tests/e2e/wave1-retained-state-characterization.spec.ts --project="Desktop Chrome" --retries=0` (`frontend/`) | 7 fail | **2 fail** |
| daemon | `node --test tools/daemon/*.test.js` (루트) | 8 fail | 8 fail (전부 기존, 대조와 동일) |
| 서버 node:test 광역 | `npx tsx --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts` (`server/`) | 24 fail | 24 fail (새 실패 0건) |

⚠️ 광역 node:test 의 건수는 부하성 flake 때문에 실행마다 24~25 사이에서 흔들린다. `docs/plan/2026-09-01.remaining-work-backlog.plan.md` 의 B4 는 25건으로 적혀 있는데 그것도 같은 실행 편차다. **건수를 회귀 신호로 쓰지 말고 실패 이름 집합을 `diff` 로 대조하라.**

빌드는 2026-09-01 에 `npm run build` 를 server·frontend 양쪽에서 돌려 **둘 다 exit 0** 이었다.

---

## 4. 관련 문서 (절대경로)

| 문서 | 용도 |
|---|---|
| `C:\Work\git\_Snoworca\ProjectMaster\docs\plan\2026-09-01.remaining-work-backlog.plan.md` | 백로그 A~E 전체. 재고정 절차 부록 포함 |
| `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-08-29-binary-data-plane-s4-wired.md` | 직전 핸드오프 (바이너리 데이터 평면 S4) |
| `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-08-27-binary-data-plane-s4-completion.md` | 8개 순수 모듈의 설계 근거 |
| `C:\Work\git\_Snoworca\ProjectMaster\CLAUDE.md` | 테스트 표면이 어디에 흩어져 있는지, exit code 를 믿을 수 없는 파일이 어느 것인지 |

---

## 5. 확정된 결정 — 재논의하지 말 것

- **커밋 범위**: 관심사별로 나눠 `git commit -F <메시지파일> -- <경로>` 형태로 커밋한다. 인덱스 전체를 커밋하지 않는다.
- **커밋에서 제외하는 미추적 7개**: `CLAUDE.local.md`, `.codex/config.toml`, `t1_verdict_1.txt`, `t1_verdict_2.txt`, `t2_verdict_1.txt`, `t2_verdict_2.txt`, `t2_verdict_incomplete_True.txt`.
- **E2E 는 `workers: 1`**. `frontend/playwright.config.ts` 에 고정했다. 이 스펙들은 서버 전역 상태를 단언하므로 파일 병렬 실행이 성립하지 않는다.
- **`MIN_COLS` / `MIN_ROWS` 는 강제하지 않는다.** 좁은 터미널을 넓히면 브라우저가 그리지 않는 폭에서 PTY 가 줄바꿈한다.
- **신원 조회 양쪽 절반은 10초 공통 기본값을 쓴다.** 두 절반이 서로 못 맞추는 예산을 갖는 것이 원래 결함이었다.
- **모든 회귀 판정에 대조를 붙인다.** 수정을 되돌려 같은 스위트를 돌리고 실패 집합을 `diff` 로 비교한다. 대조 없는 green/red 판정은 채택하지 않는다.

---

## 6. 남은 작업 전체

### B 그룹 (진행 중)

| 항목 | 상태 |
|---|---|
| 서버 러너 degradation 12건 | **다음 세션의 첫 작업.** 진단 완료 |
| 서버 러너 나머지 6건 | Ctrl+C 4번째 1건(`keeps PowerShell prompt redraw idle in heuristic mode`, 다른 원인) + WsRouter 5건 |
| frontend unit 2건 | 미구현 계약. 클라이언트가 `supportsHiddenDataGapRecovery: true` 를 선언하는데 `frontend/src/utils/terminalHiddenOutput.ts` 에 `dataGapPending` 원장이 없다. **원장을 구현할지, 선언을 `false` 로 내릴지 사용자 결정 필요** |
| E2E wave1 2건 | **원인 미확정.** 실패 문구는 `authority recovery live websocket input seam is unavailable` 이다. 그 seam 들(`__buildergateAuthorityRecoverySendInput` 등)은 `frontend/src` 에 없지만 **없어도 된다** — 스펙이 `installAuthorityRecoveryObservation()` 안에서 직접 정의해 `frontend/tests/e2e/wave1-retained-state-characterization.spec.ts:862-863` 의 `addInitScript` / `evaluate` 로 주입한다(정의는 `:626`·`:629`·`:839`). 따라서 프로덕션에 seam 을 추가할 일이 아니라, **주입이 왜 적용되지 않는지**를 찾아야 한다. 다음 세션이 확인할 것: 그 주입이 `page.reload()` 뒤에도 살아남는지, `installAuthorityRecoveryObservation()` 이 실패 경로에서 호출되기는 하는지 |

### C 그룹 — 테스트 인프라 신뢰성

- `tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs` 가 공허하게 통과한다(`NODE_TEST_CONTEXT` 상속으로 형제 0개 실행 후 exit 0).
- `server/src/ws/WsRouterSplitHandshake.test.ts` 의 todo 14건이 실제로는 깨진 단언인데 exit 0.
- `server/src/services/TerminalAuthorityProductionRegression.test.ts` 는 `npx tsx --test src/…` 로 green 이 될 수 없다(`dist/` 전용).
- `frontend/tests/e2e/busy-agent-workspace-bounce.spec.ts` 가 codex 기동 타이밍에 취약하다(10회 중 1회 배너 미출력).

### D 그룹 — 바이너리 데이터 평면 사다리

현재 기본값 `json`. S5 회계 재벤치 → `binary-optin`, S6 혼합 버전 → `binary` 기본값, S7 legacy 제거, C6 마이크로벤치.

### E 그룹 — 문서

`CLAUDE.local.md` 규칙 1 에 따라 **사용자가 직접 지시할 때만** 손댄다.

---

## 7. 다음 세션 지시서 (상세)

### 시작 상태 확인

```bash
cd C:\Work\git\_Snoworca\ProjectMaster
git status --porcelain
git log --oneline -1            # 6b2ec15 여야 한다
```

`git status --porcelain` 의 기대값은 **미추적 8개 + 수정 1개**다. 위의 제외 대상 7개에 더해
`docs/next/2026-09-01-server-runner-degradation-backlog.md`(이 문서 자신)가 미추적이고
`docs/next/LATEST.md` 가 `M` 이다. 이 둘은 이 핸드오프가 만든 것이므로 정상이다.

그 밖의 항목이 보이거나 `HEAD` 가 `6b2ec15` 가 아니면 다른 세션이 작업한 것이니
**저장소를 믿고** 사용자에게 한 줄로 알린다.

### 알아둘 함정

- **`server/src/ws/WsRouter.ts` 는 fair-scheduler provenance 핀 파일이다.** 저장하는 즉시 capability 게이트가 닫혀 무관한 스펙이 `decision-artifact-source-digest-mismatch` 로 빨개진다. 복구 절차는 `docs/plan/2026-09-01.remaining-work-backlog.plan.md` 의 "부록 — 핀 파일과 재게시" 에 있다. 핀 6개 중 나머지 다섯은 `terminalFairnessCharacterization.ts`, `fairSchedulerAuthorityLocator.ts`, `wsSendPolicy.ts`, `TerminalResourcePolicy.ts`, `TerminalResourcePolicyCanary.ts` 다.
- **`server/src/services/SessionManager.ts` 는 핀 파일이 아니다.** degradation 작업은 대부분 이 파일과 `server/src/test-runner.ts` 안에서 끝난다.
- **광역 node:test 실행에는 부하성 flake 가 있다.** `MIG-BGSTAB-002 cleanup bounds persistent zero-view rollback admission failure` 와 `server RED — real output sequence and ready authority tokens` 는 단독 실행 시 통과한다. 광역에서 실패했다고 회귀로 판정하기 전에 단독으로 3회 돌려라.
- **dev 서버는 항상 2222.** `env -u BUILDERGATE_CONFIG_PATH -u BUILDERGATE_DAEMON_STATE_PATH -u NODE_ENV node dev.js --port 2222` 로 띄운다. 상속된 환경변수가 다른 설치본의 config 를 읽게 만든다.

### 작업 절차

1. 실패하는 테스트를 먼저 확인한다(이미 red 이므로 새로 쓸 필요 없다).
2. 최소 수정으로 green 을 만든다.
3. 수정을 되돌려 같은 스위트를 돌리고 실패 집합을 `diff` 로 비교한다.
4. `npx tsc --noEmit -p tsconfig.json` (cwd `server/`) 이 exit 0 인지 확인한다.
5. 커밋 메시지에 **어떤 형태의 시그니처도 넣지 않는다.** 제목에 `Phase N`·`Step N`·`TASK-XXX` 표식도 넣지 않는다.

---

## 8. 워크트리 분리에 대한 메모

사용자가 다음 세션에서 워크트리를 분리해 **다른 응용 기능**을 그쪽에서 구현한다. 이 세션 계열은 위의 백로그를 계속한다.

주의: 이 저장소에는 이미 워크트리가 여럿 있다(`git worktree list` 로 18개 확인). 새 워크트리는 자기 `node_modules` 를 갖지 않으면 `npx` 가 **다른 체크아웃의 바이너리를 조용히 실행**한다. 새 워크트리에서 테스트를 돌릴 계획이라면 그곳에서 `npm ci` 를 먼저 돌린다 — 이때 `env -u NODE_ENV npm ci` 로 실행해야 `NODE_ENV=production` 이 상속되어 devDependencies 가 빠지는 일을 피한다.
