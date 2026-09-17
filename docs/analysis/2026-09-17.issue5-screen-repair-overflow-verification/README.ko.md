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
터미널을 만들지 않는다. workspace 에 터미널이 없으면 `waitForTerminal` 에서 타임아웃하며, 이것이
첫 실행(`raw/e2e-wave2-screen-repair-resync.log`)의 실패 원인이다 — authority proof 와 무관하다.
**이것은 spec 의 전제이지 결함이 아니라고 판단해 코드를 바꾸지 않았다.** 자체 시드를 넣었다가
철회한 경위와 근거는 §4 에 적는다. 전제를 만족시키는 도구와 그 실행 기록은
`tools/issue5-seed-terminal.mjs` 와 `raw/seed-before-final.log` 로 남긴다.

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
| HTTPS E2E | `handleScreenRepairRestoreNeeded` 가 stale/resync transaction 을 만들지 않고 early return | AC-4·AC-8 둘 다 FAIL — `raw/e2e-mutation-nobarrier.log`(선언 줄 447/594, **커밋되는 spec**). 같은 변형을 철회한 리비전에서 돌린 `raw/e2e-mutation-nobarrier-selfseeded.log`(463/610)와 `raw/e2e-mutation-final.log`(538/685)도 남기지만 커밋본 증거가 아니다 |

즉 수리된 E2E 는 제품 회귀를 실제로 잡는다.

## 4. 실행 기록 (전체 명령줄·cwd·exit code)

`<WT>` = `/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916`

| # | cwd | 명령 | exit | 산출물 |
| --- | --- | --- | --- | --- |
| 1 | `<WT>/server` | `npx tsx src/test-runner.ts` | 1 | `raw/server-runner-baseline.log` — 538 PASS / 3 FAIL |
| 2 | `<WT>/server` | `npx tsx src/test-runner.ts` (giant-flush 변형 적용 상태) | 1 | `raw/server-runner-mutation-giantflush.log` — 위 3건 + repair 계약 5건 FAIL |
| 3 | `<WT>/server` | `npx tsx --test src/ws/WsRouterSplitHandshake.test.ts` | 0 | `raw/server-split-handshake.log` — tests 28 / pass 15 / fail 0 / todo 13 (Wave-1 12 + Wave-3 1) |
| 4 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/visibleOutputRecovery.test.ts tests/unit/visibleOutputRecoveryByteSeam.test.ts tests/unit/visibleOutputSegmentContiguity.test.ts tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/terminalViewRecoveryContract.test.ts` | 0 | `raw/fe-baseline.log` — 124/124 PASS |
| 5 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/*.test.ts` | 1 | `raw/fe-unit-full.log` — tests 1258 / pass 1255 / fail 3. **커밋되는 spec** 에 대한 실행이다 |
| 6 | `<WT>/frontend` | 5번과 동일 (철회한 시드 실험 spec) | 1 | `raw/fe-unit-full-final.log` — 같은 1258/1255/3 |
| 7 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/terminalHiddenOutput.test.ts tests/unit/workspaceOwnershipMigration.test.ts` (변경분 stash 후 `e901676` 상태) | 1 | `raw/fe-unit-baseline-3fails.log` — 동일 3건 재현 → 선재 확인 |
| 8 | `<WT>/frontend` | `npx playwright test tests/e2e/wave2-screen-repair-resync.spec.ts --config playwright.external-server.config.ts --project "Desktop Chrome"` (수정 전 spec, workspace 에 터미널 없음) | 1 | `raw/e2e-wave2-screen-repair-resync.log` — 2 FAIL, `waitForTerminal` 타임아웃 |
| 9 | `<WT>/frontend` | 8번과 동일 (수정 전 spec, 터미널을 시드한 뒤) | 1 | `raw/e2e-wave2-screen-repair-resync-run2.log` — 2 FAIL, `restore-needed-invalid-authority-proof` |
| 10 | `<WT>/frontend` | 8번과 동일 + `-g "AC-4"` (restore-needed proof 만 수정한 중간 상태) | 1 | `raw/e2e-ac4-step1.log` — AC-4 만 실행, 1 failed. 로그에 남은 것은 두 시도 모두의 `RED AC-4: restore-needed did not engage the stale barrier, or snapshot-covered prefix/tail was lost, duplicated, or reordered` 한 줄뿐이다. 그 메시지는 선언형(disjunctive)이라 어느 쪽인지 가려주지 않는다 — 당시 barrier 는 engage 됐고 snapshot proof 가 어긋나 뒤에서 실패했다고 판단했으나 그 판단의 근거였던 진단 출력은 커밋하지 않았다 |
| 11 | `<WT>/frontend` | 8번과 동일 (**커밋되는 spec**) | 0 | `raw/e2e-green-prefreeze.log` — 2 PASS |
| 12 | `<WT>/frontend` | 8번과 동일 (**커밋되는 spec**, 11번과 별개 실행) | 0 | `raw/e2e-frozen-tree-preseeding.log` — 2 PASS |
| 13 | `<WT>/frontend` | 8번과 동일 (**커밋되는 spec** + 프런트 변형) | 1 | `raw/e2e-mutation-nobarrier.log` — 2 FAIL |
| 14 | `<WT>/frontend` | `node ./issue5-probe-authority.mjs` (`tools/` 사본을 frontend 로 복사해 실행) | 0 | `raw/probe-authority.log` — 실 서버 `screen-snapshot` 이 `authorityEpoch`·`authorityRevision`·`coversThroughSeq` 를 실음 |
| 15 | `<WT>/frontend` | `node ./issue5-seed-terminal.mjs` | 0 | `raw/seed-before-final.log` — spec 의 전제(터미널 1개)를 만든다 |
| 16 | `<WT>/frontend` | 8번을 4회 반복 (**커밋되는 spec**, 15번으로 갓 만든 터미널 위에서) | 0 ×4 | `raw/e2e-final-committed-4x.log` — 네 run 모두 exit 0, 그러나 1차 시도 실패 5건. 아래 불안정성 절 참조 |
| 17 | `<WT>/frontend` | `npx tsc -p tsconfig.test.json --noEmit` / `npx eslint <spec> <config>` / `npx tsc -p tsconfig.test.json --listFiles \| grep <spec>` / `npx tsc -b` (철회한 리비전 `960ac67` 에서 캡처) | 0 / 0 / 0 / 0 | `raw/typecheck-lint-registration.log` — **커밋본 증거가 아니다** |
| 18 | `<WT>/frontend` | 17번과 같은 네 명령 + 선언 줄 확인 (`a02c7a4` 에서 캡처. 이후 커밋은 `docs/` 와 `kiwi/` 만 건드리므로 `git diff a02c7a4..HEAD -- frontend/` 가 비어 있다) | 0 / 0 / 0 / 0 / 0 | `raw/typecheck-lint-head.log` — 커밋되는 spec 에 대한 실행이며 447/594 를 함께 찍는다 |

`raw/typecheck-tests-2.log` 와 `raw/eslint-scoped.log` 는 **0바이트이며 아무것도 증명하지 못한다.**
같은 명령의 입증력 있는 실행은 17번이다. 두 파일은 당시 제출된 산출물이라는 기록으로만 남긴다.

8~16 번은 모두 lane 이 직접 기동해 소유한 `https://localhost:2222` 외부 listener 를 사용했다.
`playwright.external-server.config.ts` 는 기본 config 의 `webServer` 를 `undefined` 로 덮어
Playwright 가 어떤 서버도 자동 기동하지 못하게 한다.

### 채택하지 않은 실험 — spec 자체 시드

이 lane 은 `establishTerminalHarness` 가 터미널을 직접 시드하게 만드는 변형을 만들었다가
**철회했다.** 그 변형의 실행 기록은 `raw/` 에 남아 있으나(`e2e-selfseeded.log`,
`e2e-selfseed-empty.log`, `e2e-selfseed-repeat.log`, `e2e-stability-4x.log`,
`e2e-stability-committed-6x.log`, `e2e-stability-quiescent-6x.log`, `e2e-frozen-tree-r2.log`,
`e2e-mutation-nobarrier-selfseeded.log`, `e2e-mutation-final.log`, `e2e-final-green.log`,
`teardown-before-selfseeded.log`, `fe-unit-full-final.log`) **커밋된 spec 에 대한 증거가 아니다.**
철회 이유는 둘이다.

1. 소유권을 생성 응답의 id 가 아니라 전체 tab 목록의 차집합으로 잡았다. `/api/workspaces` 읽기가
   한 번이라도 실패하면 기존 tab 전부가 "내가 만든 것"으로 분류되어 `afterEach` 가 사용자의
   터미널을 지울 수 있다. 공유 listener 에서 파괴적이며 `CLAUDE.md` 의 E2E 소유권 규칙에 어긋난다.
2. hydration 신호로 쓴 sidebar 선택 표시는 `.xterm-screen` 보다 먼저 뜬다. 터미널이 이미 있는
   workspace 에서는 early-return 을 건너뛰고 시드 분기로 들어가는데, 그 상태에는 `EmptyState` 가
   없고 tab bar 의 버튼 이름도 달라 20초 poll 을 태우고 실패한다. 남아 있는 실행 중 이 분기를
   실제로 밟은 것은 없다.

대신 spec 의 전제를 기록으로 남기고 도구(`tools/issue5-seed-terminal.mjs`)와 그 실행
(`raw/seed-before-final.log`)을 함께 둔다.

### 1차 시도 불안정성 — 갓 만든 터미널 위에서 재현된다

16번은 4회 실행이고 회마다 test 2개이므로 **1차 시도는 8회**다. 그중 **5회가 실패하고 모두
`retries: 1` 에서 통과했다.** 네 run 모두 exit 0 이다. `retries: 1` 은 이 저장소
`playwright.config.ts` 의 기존 설정이다. 내역은 다음과 같다.

| iteration | 실패한 test | 1차 시도 실패 메시지 |
| --- | --- | --- |
| 1 | AC-8 | `RED AC-8: restore-needed did not engage the stale barrier, or provisional local restore cleared hidden dirty/skipped/stale or promoted retained equivalence` |
| 2 | AC-8 | 위와 동일 |
| 3 | AC-4 | `RED AC-4: restore-needed did not engage the stale barrier, or snapshot-covered prefix/tail was lost, duplicated, or reordered` |
| 3 | AC-8 | `E2E precondition failed: target did not become actually hidden/dirty/skipped` |
| 4 | AC-8 | 위와 동일 |

즉 **RED 계약 단언 자체가 3회, precondition 이 2회**다. 계약 단언이 깨진다는 것은 stale barrier 가
때때로 engage 되지 않는다는 뜻이며 픽스처 준비 문제보다 무거운 진술이다.

`compatibility-post-ack-failed:convergence-timeout` 디버그 이벤트는 **iteration 3 의 진단 덤프에만**
찍혔다 — 그 덤프는 네 줄이고 그중 **첫·셋째·넷째** 줄에 그 접미사가 붙는다(로그 24·26·27행).
**둘째** 줄(25행)은 접미사 없는 `compatibility-post-ack-failed` 다. 첫 줄은 `source:` 키이고
나머지 셋은 `reason:` 키다. 다섯 실패 전체의 동반 증상으로 읽지 않는다.

**이 lane 의 변경이 원인이 아니다.** 16번이 돌린 spec 은 커밋본이고(테스트 선언 줄 447/594 가
`git show HEAD:…` 와 일치한다), **같은 spec** 이 11·12번에서 1차 시도에 2 PASS 했다. 즉 spec 바이트는
양쪽이 같으므로 차이는 spec 밖의 무엇인가다. 그 무엇인가가 무엇인지는 아래와 같이 기록되어 있지 않다.

**단, 변수를 분리하지는 못했다.** 16번의 "갓 만든 터미널" 전제는 `tools/issue5-seed-terminal.mjs`
가 `+ Add Terminal` 을 눌렀다는 것에 기댄다. 그 도구는 이 lane 이 spec 헬퍼를 철회한 이유와 같은
순간 `count()` 경합을 그대로 갖고 있고 서버 tab 수가 늘었는지 확인하지 않는다 — 클릭이 no-op 이고
이미 있던 터미널이 보였을 가능성을 배제하지 못한다. 대조군인 11·12번 로그에는 헤더가 없어 터미널의
나이가 기록되어 있지 않다. 즉 n=2 대 n=4 의 비교이고 독립변수가 양쪽 모두 기록되지 않았다.

그러므로 "session 이 갓 생성된 것이 원인" 은 **가설이지 확인된 인과가 아니다.** 확실한 것은 두
가지뿐이다 — 이 실패들은 커밋되는 spec(447/594)에서 관측되었고, 같은 spec 의 다른 두 실행은 1차
시도에 통과했다. 1회 green 으로 flake 라고 부르지 않기 위해 위 표를 그대로 남기고 별도 결함으로
보고한다.

### 산출물의 헤더 유무 — 무엇이 바이트로 남았는가

**§4 의 제목은 "전체 명령줄·cwd·exit code" 지만, 그것이 파일 안에 기계로 적혀 있는 것은 일부다.**
`raw/` 의 37개 산출물 중 `# cwd:`·`# command:`·`# exit=` 헤더를 가진 것은 **16개**, 없는 것은
**21개**다.

헤더가 있는 16개 — `e2e-final-committed-4x.log`, `e2e-final-green.log`, `e2e-frozen-tree-r2.log`,
`e2e-mutation-final.log`, `e2e-mutation-nobarrier-selfseeded.log`, `e2e-selfseed-empty.log`,
`e2e-selfseed-repeat.log`, `e2e-selfseeded.log`, `e2e-stability-4x.log`,
`e2e-stability-committed-6x.log`, `e2e-stability-quiescent-6x.log`, `probe-authority.log`,
`seed-before-final.log`, `teardown-before-selfseeded.log`, `typecheck-lint-head.log`,
`typecheck-lint-registration.log`.

나머지 21개에는 헤더가 없다 — 위 표의 **1~13번 산출물 전부**(`server-runner-baseline.log`,
`server-runner-mutation-giantflush.log`, `server-split-handshake.log`, `fe-baseline.log`,
`fe-unit-full.log`, `fe-unit-full-final.log`, `fe-unit-baseline-3fails.log`,
`e2e-wave2-screen-repair-resync.log`, `e2e-wave2-screen-repair-resync-run2.log`,
`e2e-ac4-step1.log`, `e2e-green-prefreeze.log`, `e2e-frozen-tree-preseeding.log`,
`e2e-mutation-nobarrier.log`) 와 netstat 캡처 6개, 0바이트 2개다. **이 행들의 cwd·명령줄·exit code
는 표의 산문 진술일 뿐이다.**

각 로그가 바이트로 지탱하는 것은 이렇다. E2E 로그는 Playwright 가 찍는 test 선언 줄로 리비전이
판별되고 말미 요약(`2 passed` / `2 failed`)이 결과를 준다. 1·2번은 말미의 `N test(s) failed` 줄이
exit code 1 을 뒷받침한다. frontend unit 로그는 B2 inventory 덤프가 spec 의 tab 조작 fetch 줄
번호를 찍으므로 그것으로 리비전을 되짚을 수 있다(아래 표 참조). 3번은 node:test 요약이
28/15/0/13 을 준다. 그 밖의 것 — 어느 디렉터리에서 어떤 인자로 돌렸는지 — 은 이 문서의 진술이다.

frontend unit 로그의 리비전은 이렇게 확인된다. spec 의 tab 조작 fetch 줄 번호는 리비전마다 다르다:
`e901676` 은 POST 256 / DELETE 359, `b7155dc`(= 커밋본) 은 POST 297 / DELETE 400,
`f719502` 는 DELETE 216 / POST 382 / DELETE 485 다. 커밋된 덤프는 `fe-unit-full.log` 297·400,
`fe-unit-full-final.log` 216·382·485, `fe-unit-baseline-3fails.log` 256·359 이므로 표의 5·6·7번
귀속과 일치한다.

### 기각한 리뷰 finding — 근거를 남긴다

한 리뷰 라운드가 표의 6·7번 귀속이 서로 뒤바뀌었다고 지적했다(`fe-unit-baseline-3fails.log` 가
`f719502` 이고 `fe-unit-full-final.log` 가 `e901676` 이라는 주장). **바이트로 확인한 결과 그 지적이
두 파일을 맞바꾼 것이고 표가 맞다.** 바로 위 문단의 대조가 근거이며, 리비전별 실제 줄 번호는
`git show <rev>:frontend/tests/e2e/wave2-screen-repair-resync.spec.ts` 로 확인했다 — `e901676`
POST 256, `b7155dc` POST 297, `f719502` DELETE 216 · POST 382. 따라서 선재 3건의 기준 트리 재현
근거(7번)는 유효하다.

### 산출물의 spec 판별 — 테스트 선언 줄로 대조한다

`raw/` 의 Playwright 로그는 test 선언 줄 번호를 찍으므로, 어느 리비전에서 돌았는지 바이트로
판별할 수 있다. 커밋별 선언 줄은 다음과 같다.

| 리비전 | AC-4 / AC-8 선언 줄 |
| --- | --- |
| `e901676` (변경 전) | 406 / 551 |
| `b7155dc` (커밋되는 spec. spec 바이트는 HEAD 까지 불변) | **447 / 594** |
| `960ac67` (1차 시드 실험) | 463 / 610 |
| `f719502` (2차 시드 실험) | 538 / 685 |
| 커밋되지 않은 중간본 | 543 / 690, 564 / 711 |

커밋되는 spec(447/594)에 대한 로그는 `raw/e2e-green-prefreeze.log`,
`raw/e2e-frozen-tree-preseeding.log`, `raw/e2e-mutation-nobarrier.log`,
`raw/e2e-final-committed-4x.log` 넷이다. 위 표의 11·12·13·16번이 그것이다.
`raw/e2e-ac4-step1.log` 도 447 을 찍지만 AC-4 만 돌린 중간 상태 실행이다.

⚠️ **다섯 개의 로그가 헤더에서 스스로를 "committed spec" 이라 부르지만 사실이 아니다.**
`raw/e2e-mutation-final.log`, `raw/e2e-stability-committed-6x.log`, `raw/e2e-final-green.log` 는
철회한 리비전 `f719502`(538/685)에서, `raw/e2e-selfseed-empty.log` 와
`raw/e2e-selfseed-repeat.log`(543/690)는 커밋되지 않은 중간본에서 돌았다. 그 헤더는 당시 내가 손으로
쓴 문장이며 캡처된 출력이 아니다. 캡처 바이트를 고쳐 쓰지 않기 위해 원문은 그대로 두고 **다섯 파일
모두 끝에 정정 한 줄을 덧붙였다.** 판별 근거는 위 선언 줄 표다.
`raw/e2e-stability-committed-6x.log` 는 파일 이름에도 `committed` 가 들어 있으나 같은 이유로 커밋본
증거가 아니다.

`raw/e2e-final-committed-4x.log` 의 헤더에 있는 "the spec does not create terminals" 는 **전제로
필요한 터미널을 spec 이 스스로 만들지 않는다** 는 뜻이다. 커밋되는 spec 은 AC-8 안에서
`hideTargetBehindTemporaryTab` 이 임시 tab 을 POST 로 만들고 자기가 받은 id 로 DELETE 한다 — 그것은
생성 응답 id 로 소유권을 잡는 기존 코드이며 이 lane 이 건드리지 않았다. 보고서와 §4 의 같은 표현도
이 뜻이다.

## 5. 포트·프로세스 안전

- 2222 서버는 `NODE_ENV=production PORT=2222 node dist/index.js` 로 `<WT>/server` 에서 직접
  기동했고 (`env -u BUILDERGATE_ROOT -u BUILDERGATE_SERVER_ROOT -u BUILDERGATE_HOME -u
  BUILDERGATE_DATA_DIR`), **네 번 기동해 네 번 종료했다** — WSL PID 440877, 447639, 451255,
  471222. 매번 `/health` 가 돌려준 `pid` 가 그 PID 와 같은지, `/proc/<pid>/cwd` 가 이 체크아웃의
  `server/` 인지 확인한 뒤 그 PID 하나만 `kill` 했다. `netstat.exe` 의 PID 열은 WSL 릴레이의
  Windows PID 이므로 소유 판정에 쓰지 않았다. 마지막 종료 뒤 2222 는 비어 있고 남긴 백그라운드
  프로세스는 없다.
- netstat 캡처는 여섯 시점이다:
  `raw/netstat-final-20260917T060212Z.txt`
  `raw/netstat-final-20260917T062552Z.txt`
  `raw/netstat-final-20260917T071712Z.txt`
  `raw/netstat-final-20260917T073812Z.txt`
  `raw/netstat-post-20260917T060157Z.txt`
  `raw/netstat-pre-20260917T053551Z.txt`
  모든 시점에서 TCP 2001/2002 는 Windows PID `30596` 이 LISTENING 이다. 이 lane 은 그 프로세스에
  어떤 신호도 보내지 않았고 `stop.bat` 을 쓰지 않았다. 각 캡처는 자기 시점만 증명한다.

## 6. 산출물에 남은 제약

- **1·2번 로그(`server-runner-baseline.log`, `server-runner-mutation-giantflush.log`)는 실행 후
  편집되었다.** GitHub issue #80 때문에 두 가지를 지웠다. (a) `[TOTP] Manual entry key:` 의 값을
  `<redacted: GitHub issue 80>` 로 치환했다(파일당 5줄). (b) 그 바로 위의 `Google Authenticator
  QR Code:` ASCII 블록은 같은 secret 을 `otpauth://` URI 로 인코딩하므로 **파일당 5블록 100줄,
  합계 200줄을 제거하고** 자리마다 제거 사실을 적은 한 줄을 남겼다. 그 두 종류를 뺀 나머지 바이트는
  실행 원본 그대로이며, 편집 전후로 `PASS` 538 / `FAIL` 3 (1번)과 `PASS` 533 / `FAIL` 8 (2번), 그리고
  실패 test 이름 목록이 동일함을 대조해 확인했다.
- 5·6번의 FAIL 3건(`terminalHiddenOutput.test.ts` 의 `REL-BGSTAB-012 settles ledger and holds
  stale view through drain`, `workspaceOwnershipMigration.test.ts` 의 B2 inventory 2건)은 7번에서
  기준 트리 재현으로 선재임을 증명했다. 이 lane 의 범위가 아니며 수정하지 않았다.
- 3번의 todo 13건은 exit code 0 뒤에 `✖ failing tests:` 로 찍힌다. 12건이 Wave-1 production
  unified limitation characterization, 1건이 Wave-3 split client-group routing 이다. 현재 실행의
  관측값이며 과거 기록을 재라벨링하지 않는다.
- **VE-8 이 덮지 못하는 범위**: 이 E2E 는 모든 프레임을 주입하므로 서버의 cap 초과·token abort
  경로를 구동하지 않는다. 그 obligation(SRS AC-3)은 VE-7 이 가리키는 서버 계약이 소유한다. 또한
  `truncated:false` 완전 payload 만 주입하므로 SRS AC-4 의 incomplete parser/ANSI tail 절반은
  다루지 않는다 — 그 절반은 `SessionManagerPartialEscapeTail.test.ts` 가 이미 소유하며 이 lane 은
  재실행하지 않았다.
- spec 은 workspace 에 터미널이 하나 있어야 돈다. 이것은 전제이며 이 lane 은 코드로 바꾸지
  않았다(§4 의 철회 절). 재현하려면 15번을 먼저 돌린다.
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
  **정확히는** `+ Add Terminal` 버튼이 보이면 한 번 누르고 `.xterm-screen` 이 뜨기를 기다린다.
  버튼이 없을 때 찍는 `terminal already present` 는 "터미널이 있다" 가 아니라 "버튼이 없다" 는
  뜻이며, 누른 뒤 서버 tab 수가 늘었는지 확인하지 않는다(§4 의 같은 지적 참조). 만들기만 하고
  지우지 않으므로 파괴적 소유권 위험은 없다. `raw/seed-before-final.log` 의 손으로 쓴 `# purpose:`
  줄은 이 정정 이전의 서술(`create it if the empty state is showing`)이라 같은 계열의 부정확한
  헤더이며, 다른 다섯 건과 같은 방식으로 파일 끝에 정정 한 줄을 덧붙였다.
- `tools/issue5-probe-authority.mjs` — 실 서버의 `screen-snapshot` wire 를 캡처해 authority proof
  필드 유무를 출력한다. 위 2절의 근거이며 출력은 `raw/probe-authority.log` 다.
- ~~`tools/issue5-teardown-terminal.mjs`~~ — **제거했다.** workspace 의 터미널 탭을 소유권 확인 없이
  전부 닫는 도구였고, 철회한 자체 시드 실험에서 시드 분기를 강제하려고 공유 listener 에 대해 **한 번
  실제로 실행했다**(`raw/teardown-before-selfseeded.log`, `tabs 1 … tabs left: 0`). 그 실행이 닫은
  tab 이 이 lane 소유였는지는 기록되어 있지 않다.

  이 lane 은 spec 자체 시드 헬퍼를 "소유권을 생성 응답 id 가 아니라 차집합으로 잡는다" 는 이유로
  철회했는데, 이 도구는 소유권을 아예 보지 않으므로 같은 기준에서 더 나쁘다. 같은 잣대를 자기
  산출물에도 적용해 번들에서 지운다. 실행 기록(`raw/teardown-before-selfseeded.log`)은 그 실행이
  있었다는 사실을 지우지 않기 위해 남긴다. 커밋되는 spec 은 이 도구를 필요로 하지 않는다.

`tools/issue5-seed-terminal.mjs` 가 spec 의 전제를 만드는 정규 도구다. 산출물이 남은 사용례는
15번뿐이며, 9번에서 터미널을 시드했다는 것은 이 문서의 진술이다.

남은 두 스크립트는 `@playwright/test` 를 해석해야 하므로 `<WT>/frontend` 에 복사해 실행한다.

