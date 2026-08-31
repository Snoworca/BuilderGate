# T-PH002-03 Frontend stale/resync barrier RED 증거

- Requirement: `REL-BGSTAB-008`
- 범위: frontend recovery 동작 계약 6개와 `https://localhost:2222` 실 WebSocket 경유 E2E 계약 2개
- production 변경: 없음
- 정확한 신규 test symbol: AC-2, AC-3, AC-4, AC-5, AC-6, AC-8, AC-10, AC-11의 8개

## 결론

현재 frontend에는 client/session scope, token/generation fence, bounded held-tail scheduler drain, explicit stale/fresh-snapshot outcome을 함께 소유하는 recovery coordinator가 없다. 따라서 신규 unit 계약 6개는 coordinator seam 부재로, E2E 계약 2개는 `screen-repair:restore-needed`를 소비하지 않아 input barrier가 열리지 않는 제품 계약 부재로 RED가 재현된다.

수집 오류나 로그인 실패를 RED로 오인하지 않았다. Playwright `--list`는 2개 테스트를 정상 수집했고, exact E2E 실행은 로그인·실 WebSocket proxy·초기 authoritative snapshot·local viewport snapshot 전제조건을 통과한 뒤 AC-4/AC-8 고유 서명으로만 실패했다. 새로고침 뒤에는 이전 연결과 구분되는 현재 WebSocket connection generation에서 subscribe가 다시 발생했음도 확인한다. 최종 단독 실행의 infrastructure error는 0건이다.

## 기존 기준선

`frontend`에서 기존 테스트 이름만 선택해 실행했다.

```powershell
node --experimental-strip-types --test --test-name-pattern="^(TerminalContainer|visible output recovery)" tests/unit/visibleOutputRecovery.test.ts tests/unit/terminalContainerRecoveryContract.test.ts
```

- Exit: `0`
- Pass/Fail: `14/0`

기존 `TerminalContainer retries queued input after visible output recovery finishes` source-contract의 고정 inspection window는 대상 토큰 직전 3글자에서 끝나고 있었다. 검사를 약화하지 않고 `finishIndex + 900`을 `finishIndex + 1000`으로 넓혔으며, 이 보정 뒤 기존 14개가 모두 통과했다.

## Unit RED

```powershell
node --experimental-strip-types --test tests/unit/visibleOutputRecovery.test.ts tests/unit/terminalContainerRecoveryContract.test.ts
```

- Exit: `1` — 계획의 `expected_exit: 1`과 일치
- 전체 Pass/Fail: `14/6`
- 기존 테스트: `14/14` 통과
- 신규 계약: `6/6`이 각 AC 고유 서명으로 실패

동적 production seam은 test fixture가 동작을 대신 구현하지 않는다. production의 `createVisibleOutputRecoveryCoordinator` export를 요구하고 실제 UTF-8 payload, byte/chunk cap, client/session scope, token/generation, scheduler callback을 주입한다. GREEN 구현 뒤에는 다음을 행동으로 검증한다.

- snapshot coverage prefix 제거와 held tail 객체 identity/order 보존
- 모든 scheduler write callback drain 뒤에만 ready/input 해제, duplicate callback no-op
- byte/chunk N-1/N/N+1을 실제 UTF-8 payload로 산출
- overflow 시 affected view만 abort/stale, pending direct/giant flush 0
- failure/timeout/reoverflow/parser failure/empty reason에서 success ACK 0과 explicit outcome
- stale transaction/repair/replay/generation, duplicate signal, close/dispose callback no-op
- client A overflow 중 client B scheduler delivery와 ready 독립
- production unified는 bounded scheduler로 drain하고, split-shadow/split requested input은 실제 event를 무시하면서 `effective=unified`, `splitActivationEnabled=false`, `parity=unresolved`, `standalone-split-unavailable` limitation outcome을 보존

## HTTPS E2E RED

수집 검증:

```powershell
npx playwright test tests/e2e/wave2-screen-repair-resync.spec.ts --project "Desktop Chrome" --list
```

- Exit: `0`
- Collected: `2`

exact 실행:

```powershell
npx playwright test tests/e2e/wave2-screen-repair-resync.spec.ts --project "Desktop Chrome"
```

- Exit: `1` — 계획의 `expected_exit: 1`과 일치
- Pass/Fail: `0/2`
- Infrastructure error: `0`
- AC-4: real WebSocket route proxy에서 restore-needed 뒤 barrier 부재로 고유 RED. ASCII/CJK/emoji/완결 ANSI로 구성한 covered prefix 4개와 post-snapshot tail 5개를 모두 snapshot 전에 주입하고, 9개 전부가 stale barrier에 보류되어 DOM에 노출되지 않아야 한다. authoritative snapshot 뒤에는 snapshot coverage와 tail이 정확히 한 번씩 순서대로 나타나야 한다.
- AC-8: temporary tab으로 target을 실제 hidden 처리하고 injected output의 `hidden_output_skipped`와 양수 skipped bytes를 먼저 확인한 뒤 restore-needed barrier 부재로 고유 RED. 임시 탭 helper는 setup 응답 유실도 이름 기반 bounded discovery로 회수한다. `finally` cleanup은 workspace 복구·임시 탭 탐색·알고 있는 임시 탭 삭제·최종 상태 GET을 서로 독립적으로 모두 시도한 뒤 오류를 집계하며, 원 view mode/active tab과 임시 탭 부재를 최종 검증한다.

E2E proxy는 브라우저 WebSocket을 가짜 transport로 대체하지 않는다. `page.routeWebSocket`이 실제 BuilderGate `/ws`에 `connectToServer()`로 연결해 양방향 프레임을 그대로 전달하고, server result fault만 page 방향으로 주입한다. debug capture가 활성화되지 않으면 명시적인 E2E precondition failure로 종료하며, snapshot은 session/mode/truncation/source/data/sequence를 모두 만족하는 authoritative frame만 인정한다.

## 독립 검토 수정 이력

첫 검토의 수집 오류, 자명한 multi-client/boundary 단언, source slice 과적합, silent empty outcome, AC-8 hidden dirty/skipped 누락, AC-10 scheduler/split 행동 누락을 모두 수정했다. 두 번째 검토의 stale replay token·duplicate signal, failure success ACK 관측점, split-shadow/split 입력 누락도 모두 수정했다. 세 번째 검토의 vacuous hidden 상태와 split limitation 단언은 실제 hidden output 및 split recovery event를 먼저 발생시키는 행동 계약으로 교체했다.

후속 E2E 검토에서 setup 응답 유실 rollback, reload 후 current connection generation 증명, debug capture 사전조건, authoritative snapshot 판별, 완전한 prefix/tail 문자군을 보강했다. 마지막 검토의 cleanup 독립 실행·오류 집계와 snapshot 전 9개 전체 보류 요구도 반영했다. 같은 까칠한 E2E 리뷰어가 최종 수정본을 재검토했고 정확히 `No findings`를 반환했다. Sidecar의 실제 8개 서명은 루트 작업에서 동기화됐다.

## 정적 검증

- 대상 4개 파일 ESLint: exit `0`
- frontend TypeScript build check: exit `0`
- raw terminal payload를 evidence에 저장하지 않음
