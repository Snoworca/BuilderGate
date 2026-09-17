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
원인은 제품이 아니라 테스트 픽스처다. 프런트는 `hasValidAuthorityProof` 를 통과하지 못하는
`screen-repair:restore-needed` 를 `visible_output_resync_restore_invalid_proof_ignored` 로 버리고
reconnect 로 수렴하는데, spec 의 `buildRestoreNeeded` 가 `authorityEpoch`·`authorityRevision`·
`coversThroughSeq` 를 싣지 않아 stale barrier 가 아예 engage 되지 않았다. 후속 `screen-snapshot`
주입도 `...initialSnapshot` 을 펼친 뒤 `seq` 만 바꿔 `coversThroughSeq` 가 어긋났다.

실제 서버는 이 세 필드를 보낸다 — `tools/issue5-probe-authority.mjs` 로 실 서버 wire 를 캡처해
확인했다(`authorityEpoch` 문자열, `authorityRevision` 정수, `coversThroughSeq === seq`).
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
| HTTPS E2E | `handleScreenRepairRestoreNeeded` 가 stale/resync transaction 을 만들지 않고 early return | AC-4·AC-8 둘 다 FAIL (`raw/e2e-mutation-nobarrier.log`) |

즉 수리된 E2E 는 제품 회귀를 실제로 잡는다.

## 4. 실행 기록 (전체 명령줄·cwd·exit code)

`<WT>` = `/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916`

| # | cwd | 명령 | exit | 산출물 |
| --- | --- | --- | --- | --- |
| 1 | `<WT>/server` | `npx tsx src/test-runner.ts` | 1 | `raw/server-runner-baseline.log` — 538 PASS / 3 FAIL |
| 2 | `<WT>/server` | `npx tsx src/test-runner.ts` (giant-flush 변형 적용 상태) | 1 | `raw/server-runner-mutation-giantflush.log` — 위 3건 + repair 계약 5건 FAIL |
| 3 | `<WT>/server` | `npx tsx --test src/ws/WsRouterSplitHandshake.test.ts` | 0 | `raw/server-split-handshake.log` — tests 28 / pass 15 / fail 0 / todo 13 |
| 4 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/visibleOutputRecovery.test.ts tests/unit/visibleOutputRecoveryByteSeam.test.ts tests/unit/visibleOutputSegmentContiguity.test.ts tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/terminalViewRecoveryContract.test.ts` | 0 | `raw/fe-baseline.log` — 124/124 PASS |
| 5 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/*.test.ts` | 1 | `raw/fe-unit-full.log` — tests 1258 / pass 1255 / fail 3 |
| 6 | `<WT>/frontend` | `node --experimental-strip-types --test tests/unit/terminalHiddenOutput.test.ts tests/unit/workspaceOwnershipMigration.test.ts` (변경분 stash 후 `e901676` 상태) | 1 | `raw/fe-unit-baseline-3fails.log` — 동일 3건 재현 → 선재 확인 |
| 7 | `<WT>/frontend` | `npx playwright test tests/e2e/wave2-screen-repair-resync.spec.ts --config playwright.issue5-noserver.config.ts --project "Desktop Chrome"` (수정 전) | 1 | `raw/e2e-wave2-screen-repair-resync-run2.log` — 2 FAIL, `restore-needed-invalid-authority-proof` |
| 8 | `<WT>/frontend` | 위와 동일 + `-g "AC-4"` (restore-needed proof 만 수정한 중간 상태) | 1 | `raw/e2e-ac4-step1.log` — barrier 는 engage, snapshot proof 불일치로 뒤에서 실패 |
| 9 | `<WT>/frontend` | 7번과 동일 (변형 적용 상태) | 1 | `raw/e2e-mutation-nobarrier.log` — 2 FAIL |
| 10 | `<WT>/frontend` | 7번과 동일 (최종) | 0 | `raw/e2e-green-final.log` — 2 PASS |
| 11 | `<WT>/frontend` | `npx tsc -p tsconfig.test.json --noEmit` | 0 | `raw/typecheck-tests-2.log` — spec 을 allowlist 에 넣은 뒤 |
| 12 | `<WT>/frontend` | `npx eslint tests/e2e/wave2-screen-repair-resync.spec.ts playwright.issue5-noserver.config.ts` | 0 | `raw/eslint-scoped.log` |
| 13 | `<WT>/frontend` | 7번과 동일 (최종 동결 트리, 10번과 별개 실행) | 0 | `raw/e2e-frozen-tree.log` — 2 PASS |

11·12 번의 로그는 **빈 파일이다.** `tsc --noEmit` 과 `eslint` 는 성공 시 아무것도 출력하지 않으므로
그 자체로는 무엇도 증명하지 못한다. 근거는 위 표의 exit code 다. 11 번의 등재 여부는 별도로
`npx tsc -p tsconfig.test.json --listFiles | grep -c wave2-screen-repair-resync.spec.ts` = 1 로 확인했다.

10 번과 13 번은 같은 명령의 서로 다른 실행이며 바이트가 다르다(소요 시간 기록이 다르다).
13 번이 커밋되는 트리에 대한 실행이다.

7~10 번은 모두 lane 이 직접 기동해 소유한 `https://localhost:2222` 외부 listener 를 사용했다.
`playwright.issue5-noserver.config.ts` 는 기본 config 의 `webServer` 를 `undefined` 로 덮어
Playwright 가 어떤 서버도 자동 기동하지 못하게 한다.

## 5. 포트·프로세스 안전

- `raw/netstat-pre-20260917T053551Z.txt` (실행 전), `raw/netstat-post-20260917T060157Z.txt`
  (E2E 종료 직후), `raw/netstat-final-20260917T060212Z.txt` (2222 종료 후) — 세 시점 모두 TCP
  2001/2002 는 Windows PID `30596` 이 LISTENING 이다. 이 lane 은 그 프로세스에 어떤 신호도 보내지
  않았고 `stop.bat` 을 쓰지 않았다. 각 캡처는 자기 시점만 증명한다.
- 2222 서버는 `NODE_ENV=production PORT=2222 node dist/index.js` 로 `<WT>/server` 에서 직접 기동했고
  (`env -u BUILDERGATE_ROOT -u BUILDERGATE_SERVER_ROOT -u BUILDERGATE_HOME -u BUILDERGATE_DATA_DIR`),
  `/health` 가 돌려준 `pid`(WSL PID 440877) 와 `/proc/440877/cmdline`·`cwd`·`exe` 로 이 체크아웃
  소유임을 확인한 뒤 그 PID 하나만 `kill` 했다. `netstat.exe` 의 PID 열은 WSL 릴레이의 Windows PID
  이므로 소유 판정에 쓰지 않았다. 종료 후 2222 는 비어 있다. 남긴 백그라운드 프로세스는 없다.

## 6. 산출물에 남은 제약

- 위 1·2번 로그는 `[TOTP] Manual entry key:` 줄이 실제 secret 을 찍으므로(GitHub issue #80)
  커밋본에서 그 값만 `<redacted: GitHub issue 80>` 로 치환했다. 다른 바이트는 실행 원본 그대로다.
- 5번의 FAIL 3건(`terminalHiddenOutput.test.ts` 의 `REL-BGSTAB-012 settles ledger and holds stale
  view through drain`, `workspaceOwnershipMigration.test.ts` 의 B2 inventory 2건)은 6번에서 기준
  트리 재현으로 선재임을 증명했다. 이 lane 의 범위가 아니며 수정하지 않았다.
- 3번의 todo 13건은 exit code 0 뒤에 `✖ failing tests:` 로 찍히는 Wave-1 unified limitation
  characterization 이다. 현재 실행의 관측값이며 과거 기록을 재라벨링하지 않는다.
- 이 lane 은 retained-history 복구 완료를 주장하지 않는다. `retainedHistoryEquivalent` 는 계속
  `false` 이고, 전체 retained-state 수렴은 #11/#12/#14 공동 gate 소유다.

## 7. 도구

- `tools/issue5-seed-terminal.mjs` — spec 이 전제하는 "workspace 에 터미널 1개"를 만든다.
  기본 workspace 에 터미널이 없으면 `+ Add Terminal` 을 한 번 누르고 렌더를 기다린다.
- `tools/issue5-probe-authority.mjs` — 실 서버의 `screen-snapshot` wire 를 캡처해 authority proof
  필드 유무를 출력한다. 위 2절의 근거다.

두 스크립트는 `@playwright/test` 를 해석해야 하므로 `<WT>/frontend` 에 복사해 실행한다.
