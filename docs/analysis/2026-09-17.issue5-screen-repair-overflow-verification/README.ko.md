# Issue #5 — screen-repair overflow 수렴 재검증과 HTTPS E2E 계약 복구

- 대상 요구사항: `REL-BGSTAB-008`
- GitHub issue: https://github.com/Snoworca/BuilderGate/issues/5
- 검증 기준 트리: `e901676` (전제 확인과 baseline 측정), 변경 후 트리는 본 번들을 담은 커밋
- 실행 호스트: WSL2 (Linux), 외부 listener 는 `https://localhost:2222` 하나

## 1. 전제 확인 결과

이슈가 요구한 동작 변경 자체는 Wave 2 PH-002 에서 이미 반영되어 있었고, `e901676` 에서
서버·프런트 양쪽 모두 재현된다.

- `WsRouter.appendScreenRepairQueuedOutput` 의 cap 초과 분기는 누적 chunk 를 flush 하지 않고
  `startScreenRepairSnapshotRecovery` 로 `screen-repair:restore-needed` + fresh snapshot
  transaction 을 시작한다. 누적 문자열을 만드는 join 은 repair 경로에 존재하지 않는다.
- `getScreenRepairQueuePolicy()` 는 `getReplayQueueLimit()`(= `Math.min(runtimePtyConfig.maxSnapshotBytes, 262_144)`)
  과 `resourceLimits.headless.pendingOutputMaxChunks` 를 `source: 'compatibility-cap'` 으로 재사용한다.
  이슈 본문이 선언한 compatibility-cap 예외와 SRS AC-1 의 서술이 현재 소스와 일치한다.
- 프런트는 `retainedHistoryEquivalent` 를 항상 `false` 로 유지한 채 `currentViewTransactionReady`
  만 승급하며, local/fallback restore 는 `provisionalLocalState` 로 남는다.

## 2. 이번 실행이 실제로 고친 것

`frontend/tests/e2e/wave2-screen-repair-resync.spec.ts` 가 `e901676` 에서 **두 건 모두 실패한다.**
원인은 제품이 아니라 테스트 픽스처이며, **둘이다.**

첫째, spec 은 `establishTerminalHarness` 에서 로그인 후 곧바로 `waitForTerminal` 을 기다릴 뿐
터미널을 만들지 않았다. workspace 에 터미널이 없으면 `waitForTerminal` 에서 타임아웃하며, 이것이
첫 실행(`raw/e2e-wave2-screen-repair-resync.log`)의 실패 원인이다 — authority proof 와 무관하다.

`ensureSeededTerminal()` 이 그 빈자리를 메운다. 다만 `login()` 은 `.workspace-screen` 이 보이면
바로 돌아오고 App 은 workspace 목록을 받기 전에 그 컨테이너를 그린다. 그 창에서는 workspace 가
없을 때의 `EmptyState` 가 `+ Add Terminal` 을 들고 떠 있는데 `handleAddTab` 이 읽는
`activeWorkspaceId` 가 아직 null 이라 클릭이 조용히 아무 일도 하지 않는다. 반대로 터미널이 이미
있는 workspace 에서는 hydration 이 끝나는 순간 그 버튼이 사라져, 순간 `count()` 로 분기하면 곧
사라질 요소를 클릭하게 된다. 그래서 헬퍼는 **터미널이 보이거나 workspace 가 선택될 때까지 기다린
뒤에** 분기하고, 시드한 다음에는 서버가 아는 tab 목록이 실제로 늘었는지 확인한다. 시드한 tab 은
`workspaceId/tabId` 로 기억해 `afterEach` 에서 되돌려준다.

`raw/e2e-selfseed-empty.log` 는 workspace 를 비운 상태(`raw/teardown-before-selfseeded.log` 가
`tabs left: 0` 을 찍는다)에서 시작해 2건 PASS 함을 보인다.

둘째, 프런트는 `hasValidAuthorityProof` 를 통과하지 못하는
`screen-repair:restore-needed` 를 `visible_output_resync_restore_invalid_proof_ignored` 로 버리고
reconnect 로 수렴하는데, spec 의 `buildRestoreNeeded` 가 `authorityEpoch`·`authorityRevision`·
`coversThroughSeq` 를 싣지 않아 stale barrier 가 아예 engage 되지 않았다. 후속 `screen-snapshot`
주입도 `...initialSnapshot` 을 펼친 뒤 `seq` 만 바꿔 `coversThroughSeq` 가 어긋났다.

실제 서버는 이 세 필드를 보낸다 — `tools/issue5-probe-authority.mjs` 로 실 서버 wire 를 캡처해
확인했고 그 출력이 `raw/probe-authority.log` 다(`authorityEpoch` 문자열, `authorityRevision` 정수,
`coversThroughSeq === seq`).
따라서 수정 방향은 spec 을 프로덕션 wire 형태에 다시 맞추는 것이며, 단언을 약화하지 않는다.
`resyncAuthorityProof()` 는 관측된 authoritative snapshot 에서 proof 를 파생하고, proof 필드가
없으면 precondition 으로 실패한다.

결과적으로 `REL-BGSTAB-008` VE-5 의 "HTTPS resync 2/2 PASS" 는 이 수정 이전에는 현재 트리에서
재현되지 않았다.

## 3. 게이트 비공허성(non-vacuity)

두 축 모두 프로덕션 소스를 변형해 red 를 확인했고, 확인 후 원본을 바이트 복원했다.

| 축 | 변형 | 결과 |
| --- | --- | --- |
| 서버 계약 | `appendScreenRepairQueuedOutput` 의 overflow 분기를 Wave 2 이전의 giant concatenation flush 로 되돌림 | `Repair queue·protocol RED 계약 — AC-1/AC-3/AC-5/AC-7/AC-10` 5건 전부 FAIL (`raw/server-runner-mutation-giantflush.log`) |
| HTTPS E2E | `handleScreenRepairRestoreNeeded` 가 stale/resync transaction 을 만들지 않고 early return | AC-4·AC-8 둘 다 FAIL (`raw/e2e-mutation-final.log`, 커밋되는 spec 에 대한 실행). `raw/e2e-mutation-nobarrier.log` 와 `raw/e2e-mutation-nobarrier-selfseeded.log` 는 각각 시드 도입 전·중간 spec 에 대한 같은 변형의 실행이다 |

즉 수리된 E2E 는 제품 회귀를 실제로 잡는다.

## 4. 실행 기록 (전체 명령줄·cwd·exit code)

`<WT>` = `/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916`

| # | cwd | 명령 | exit | 산출물 |
| --- | --- | --- | --- | --- |
| 1 | `<WT>/server` | `npx tsx src/test-runner.ts` | 1 | `raw/server-runner-baseline.log` — 538 PASS / 3 FAIL |
| 2 | `<WT>/server` | `npx tsx src/test-runner.ts` (giant-flush 변형 적용 상태) | 1 | `raw/server-runner-mutation-giantflush.log` — 위 3건 + repair 계약 5건 FAIL |
| 3 | `<WT>/server` | `npx tsx --test src/ws/WsRouterSplitHandshake.test.ts` | 0 | `raw/server-split-handshake.log` — tests 28 / pass 15 / fail 0 / todo 13 |
| 4 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/visibleOutputRecovery.test.ts tests/unit/visibleOutputRecoveryByteSeam.test.ts tests/unit/visibleOutputSegmentContiguity.test.ts tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/terminalViewRecoveryContract.test.ts` | 0 | `raw/fe-baseline.log` — 124/124 PASS |
| 5 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/*.test.ts` (시드 도입 전 spec) | 1 | `raw/fe-unit-full.log` — tests 1258 / pass 1255 / fail 3 |
| 6 | `<WT>/frontend` | 5번과 동일 (**커밋되는 spec**) | 1 | `raw/fe-unit-full-final.log` — tests 1258 / pass 1255 / fail 3, 같은 3건 |
| 7 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/terminalHiddenOutput.test.ts tests/unit/workspaceOwnershipMigration.test.ts` (변경분 stash 후 `e901676` 상태) | 1 | `raw/fe-unit-baseline-3fails.log` — 동일 3건 재현 → 선재 확인 |
| 8 | `<WT>/frontend` | `npx playwright test tests/e2e/wave2-screen-repair-resync.spec.ts --config playwright.external-server.config.ts --project "Desktop Chrome"` (수정 전 spec, workspace 에 터미널 없음) | 1 | `raw/e2e-wave2-screen-repair-resync.log` — 2 FAIL, `waitForTerminal` 타임아웃 |
| 9 | `<WT>/frontend` | 8번과 동일 (수정 전 spec, 터미널을 외부에서 시드한 뒤) | 1 | `raw/e2e-wave2-screen-repair-resync-run2.log` — 2 FAIL, `restore-needed-invalid-authority-proof` |
| 10 | `<WT>/frontend` | 8번과 동일 + `-g "AC-4"` (restore-needed proof 만 수정한 중간 상태) | 1 | `raw/e2e-ac4-step1.log` — barrier 는 engage, snapshot proof 불일치로 뒤에서 실패 |
| 11 | `<WT>/frontend` | 8번과 동일 (proof 수정 후, 시드 도입 전 spec) | 0 | `raw/e2e-green-prefreeze.log` — 2 PASS |
| 12 | `<WT>/frontend` | 8번과 동일 (proof 수정 후, 시드 도입 전 spec, 11번과 별개 실행) | 0 | `raw/e2e-frozen-tree-preseeding.log` — 2 PASS |
| 13 | `<WT>/frontend` | `node ./issue5-probe-authority.mjs` (`tools/` 사본을 frontend 로 복사해 실행) | 0 | `raw/probe-authority.log` — 실 서버 `screen-snapshot` 이 `authorityEpoch`·`authorityRevision`·`coversThroughSeq` 를 실음 |
| 14 | `<WT>/frontend` | `node ./issue5-teardown-terminal.mjs` | 0 | `raw/teardown-before-selfseeded.log` — `tabs left: 0`, empty state 확인 |
| 15 | `<WT>/frontend` | 8번과 동일 (첫 시드 도입 spec, workspace 를 비운 뒤) | 0 | `raw/e2e-selfseeded.log` — 2 PASS |
| 16 | `<WT>/frontend` | 8번과 동일 (첫 시드 도입 spec, 변형 되돌린 뒤) | 0 | `raw/e2e-frozen-tree-r2.log` — 2 PASS |
| 17 | `<WT>/frontend` | 8번과 동일 (첫 시드 도입 spec + 프런트 변형) | 1 | `raw/e2e-mutation-nobarrier-selfseeded.log` — 2 FAIL |
| 18 | `<WT>/frontend` | 8번과 동일 (hydration 대기를 넣은 spec, workspace 를 비운 뒤) | 0 | `raw/e2e-selfseed-empty.log` — 2 PASS, 시드 분기 실행 |
| 19 | `<WT>/frontend` | 8번과 동일 (teardown 없이 곧바로 2회차) | 0 | `raw/e2e-selfseed-repeat.log` — 2 PASS, 단 AC-8 은 1차 시도 실패 후 재시도 통과 |
| 20 | `<WT>/frontend` | 8번을 4회 반복 | 0 ×4 | `raw/e2e-stability-4x.log` — 8/8 1차 시도 통과 |
| 21 | `<WT>/frontend` | 8번과 동일 (**커밋되는 spec** + 프런트 변형) | 1 | `raw/e2e-mutation-final.log` — 2 FAIL |
| 22 | `<WT>/frontend` | 8번과 동일 (**커밋되는 spec**, 변형 되돌리고 재빌드) | 0 | `raw/e2e-final-green.log` — 통과, AC-8 은 1차 시도 실패 후 재시도 통과 |
| 23 | `<WT>/frontend` | 8번을 6회 반복 (quiescence 대기를 시험한 spec) | 0 ×6 | `raw/e2e-stability-quiescent-6x.log` — 6회 중 3회에서 AC-8 1차 시도 실패. 이 대기는 **채택하지 않았다** |
| 24 | `<WT>/frontend` | 8번을 6회 반복 (**커밋되는 spec**) | 0 ×6 | `raw/e2e-stability-committed-6x.log` — 6회 중 5회 1차 시도 통과, 1회 AC-8 재시도 |
| 25 | `<WT>/frontend` | `npx tsc -p tsconfig.test.json --noEmit` / `npx eslint <spec> <config>` / `npx tsc -p tsconfig.test.json --listFiles \| grep <spec>` / `npx tsc -b` | 0 / 0 / 0 / 0 | `raw/typecheck-lint-registration.log` — 네 명령의 명령줄·cwd·exit code 와 listFiles 매칭 경로 |

`raw/typecheck-tests-2.log` 와 `raw/eslint-scoped.log` 는 **0바이트이며 아무것도 증명하지 못한다.**
같은 명령의 입증력 있는 실행은 25번이다. 두 파일은 당시 제출된 산출물이라는 기록으로만 남긴다.

8~24 번은 모두 lane 이 직접 기동해 소유한 `https://localhost:2222` 외부 listener 를 사용했다.
`playwright.external-server.config.ts` 는 기본 config 의 `webServer` 를 `undefined` 로 덮어
Playwright 가 어떤 서버도 자동 기동하지 못하게 한다.

### AC-8 의 1차 시도 불안정성 — 관측된 그대로

커밋되는 spec 으로 돌린 10회(19·20·22·24번) 중 **2회에서 AC-8 이 1차 시도에 실패하고 재시도에서
통과했다.** 실패 지점은 그 test 안의 precondition 이며 메시지는
`E2E precondition failed: target did not become actually hidden/dirty/skipped` 다. 세 번째 실패
경로는 관측되지 않았다. 모두 다른 작업 없이 단독으로 돌린 실행이며, `retries: 1` 은 이 저장소의
`playwright.config.ts` 가 원래 갖고 있던 설정이라 run 자체는 exit 0 으로 끝난다.

시드 도입 전 spec 으로 돌린 4회(11·12번 및 그 이전 두 실행)에서는 이 실패를 보지 못했다. 따라서
test 마다 새 session 을 만드는 이 변경과 상관이 있다고 본다. 단 원인을 특정하지는 못했다 —
막 생성된 터미널이 조용해질 때까지 기다리는 방법(23번)을 시험했더니 **6회 중 3회로 오히려 나빠져**
채택하지 않았다. 1회 green 으로 flake 라고 부르지 않기 위해 위 수치를 그대로 남기고, 이 항목은
별도 결함으로 보고한다.

## 5. 포트·프로세스 안전

- 2222 서버는 세 번 기동해 앞의 둘을 종료했다(WSL PID 440877, 447639, 451255). 세 번째는 이
  lane 이 검증을 마친 뒤 종료하며, 종료 여부는 보고에 남긴다.
- `raw/netstat-pre-20260917T053551Z.txt` (첫 기동 전), `raw/netstat-post-20260917T060157Z.txt`
  (1차 E2E 종료 직후), `raw/netstat-final-20260917T060212Z.txt` (1차 2222 종료 후),
  `raw/netstat-final-20260917T062552Z.txt` (2차 2222 종료 후) — 네 시점 모두 TCP
  2001/2002 는 Windows PID `30596` 이 LISTENING 이다. 이 lane 은 그 프로세스에 어떤 신호도 보내지
  않았고 `stop.bat` 을 쓰지 않았다. 각 캡처는 자기 시점만 증명한다.
- 2222 서버는 `NODE_ENV=production PORT=2222 node dist/index.js` 로 `<WT>/server` 에서 직접 기동했고
  (`env -u BUILDERGATE_ROOT -u BUILDERGATE_SERVER_ROOT -u BUILDERGATE_HOME -u BUILDERGATE_DATA_DIR`),
  두 번 기동해 두 번 종료했다(WSL PID 440877, 447639). 매번 `/health` 가 돌려준 `pid` 와
  `/proc/<pid>/cmdline`·`cwd`·`exe` 로 이 체크아웃 소유임을 확인한 뒤 그 PID 하나만 `kill` 했다. `netstat.exe` 의 PID 열은 WSL 릴레이의 Windows PID
  이므로 소유 판정에 쓰지 않았다. 종료 후 2222 는 비어 있다. 남긴 백그라운드 프로세스는 없다.

## 6. 산출물에 남은 제약

- 위 1·2번 로그는 `[TOTP] Manual entry key:` 줄이 실제 secret 을 찍으므로(GitHub issue #80)
  커밋본에서 그 값만 `<redacted: GitHub issue 80>` 로 치환했다. 다른 바이트는 실행 원본 그대로다.
- 5번의 FAIL 3건(`terminalHiddenOutput.test.ts` 의 `REL-BGSTAB-012 settles ledger and holds stale
  view through drain`, `workspaceOwnershipMigration.test.ts` 의 B2 inventory 2건)은 6번에서 기준
  트리 재현으로 선재임을 증명했다. 이 lane 의 범위가 아니며 수정하지 않았다.
- 3번의 todo 13건은 exit code 0 뒤에 `✖ failing tests:` 로 찍히는 Wave-1 unified limitation
  characterization 이다. 현재 실행의 관측값이며 과거 기록을 재라벨링하지 않는다.
- **VE-8 이 덮지 못하는 범위**: 이 E2E 는 모든 프레임을 주입하므로 서버의 cap 초과·token abort
  경로를 구동하지 않는다. 그 obligation(SRS AC-3)은 VE-7 이 가리키는 서버 계약이 소유한다. 또한
  `truncated:false` 완전 payload 만 주입하므로 SRS AC-4 의 incomplete parser/ANSI tail 절반은
  다루지 않는다 — 그 절반은 `SessionManagerPartialEscapeTail.test.ts` 가 이미 소유하며 이 lane 은
  재실행하지 않았다.
- AC-8 test 의 late-frame 단언은 `visible_output_resync_failed_snapshot_ignored` 이벤트 대신
  replacement-generation fence 로도 충족된다. 이 절충은 이번 변경 이전부터 있던 것이며, 그 단언만
  따로 보면 VE-8 의 산문보다 약하다. 같은 블록의 `screen-snapshot:ready` 미전송과 marker 비가시
  단언은 그대로 유효하다.
- `kiwi/.status.json` 의 `lock` 블록은 손으로 released 상태(`active:false`, `metadata:null`)로
  맞췄다. `speckiwi sync-index` 는 lock 을 쥔 채 파일을 스냅샷하므로 그대로 두면 이미 끝난 mutation 을
  "진행 중"으로 단언하고 호스트명과 OS pid 까지 커밋된다. `add-change-note` 는 lock 해제 후
  재생성하지만 자기 쓰기 이전의 stale 스냅샷으로 fingerprint 를 계산해 `30.buildergate-stability.srs.md`
  해시가 어긋난다. 둘 중 어느 명령도 두 조건을 동시에 만족시키지 못한다. 커밋된 fingerprint 는
  `sync-index` 실행분이며 커밋된 spec 바이트와 대조해 확인했다.
- `kiwi/.status.json` 의 lock 이 released 인 것은 **현재 트리**에 대해서만 참이다. lock 이 active
  이던 스냅샷은 이 브랜치의 이전 커밋에 그대로 남아 있고 거기에는 작업기 호스트명과 OS pid 가 있다.
  `git log -p` 로는 보인다. 자격증명이 아니고 되돌리면 이 번들이 인용하는 커밋 해시가 전부 무효가
  되므로 history 를 다시 쓰지 않기로 했다. 판단을 기록으로 남긴다.
- 이 lane 은 retained-history 복구 완료를 주장하지 않는다. `retainedHistoryEquivalent` 는 계속
  `false` 이고, 전체 retained-state 수렴은 #11/#12/#14 공동 gate 소유다.

## 7. 도구

- `tools/issue5-seed-terminal.mjs` — spec 이 전제하는 "workspace 에 터미널 1개"를 만든다.
  기본 workspace 에 터미널이 없으면 `+ Add Terminal` 을 한 번 누르고 렌더를 기다린다.
- `tools/issue5-probe-authority.mjs` — 실 서버의 `screen-snapshot` wire 를 캡처해 authority proof
  필드 유무를 출력한다. 위 2절의 근거이며 출력은 `raw/probe-authority.log` 다.
- `tools/issue5-teardown-terminal.mjs` — workspace 의 터미널 탭을 모두 닫아 empty state 를 만든다.
  spec 의 자체 시드 분기를 실제로 통과시키기 위해 15·18 번 실행 앞에서 썼다. 출력은
  `raw/teardown-before-selfseeded.log` 다.

`tools/issue5-seed-terminal.mjs` 는 spec 이 자체 시드를 갖기 전에 쓰던 것이다. 지금은 불필요하며
9~12 번 실행의 맥락을 위해 남긴다.

세 스크립트 모두 `@playwright/test` 를 해석해야 하므로 `<WT>/frontend` 에 복사해 실행한다.

