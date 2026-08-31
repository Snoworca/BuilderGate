# T-PH002-04 프런트 visible-output 복구 GREEN 보고

- Requirement: `REL-BGSTAB-008`
- 범위: additive 복구 프로토콜, visible recovery coordinator, xterm mutation fence, WebSocket grace ordering, 실제 브라우저 회귀
- 기존 UI·기본 transport·입력 상태 불변식 변경: 없음

## 구현 결과

프런트가 `screen-repair:restore-needed`를 받으면 client/session 단위 recovery transaction을 생성하고 현재 터미널을 stale로 유지한다. 이후 출력은 일반 `term.write()`로 우회하지 않고 UTF-8 byte/chunk 상한이 있는 coordinator에 보존된다. snapshot sequence 이하임이 확인된 chunk만 제거하며, 정상 wire에 sequence가 없으면 값을 만들지 않고 unknown tail로 보존한다.

복구 완료 조건은 다음 두 가지가 모두 충족되는 경우뿐이다.

1. repair/replay token, connection/session generation, 선언된 snapshot sequence가 모두 일치하는 authoritative snapshot이 실제 xterm에 적용됨
2. snapshot 이후의 held tail이 awaitable `writeAndWait()`를 통해 순서대로 모두 drain됨

`retainedHistoryEquivalent`는 계속 `false`다. 이 작업은 viewport 복구를 전체 retained-history 동등성으로 과장하지 않는다.

## 실패 및 경합 차단

coordinator 상태에 외부에서 읽을 수 있는 `terminalFailed`를 추가했다. overflow, reconnect-required, repair rejection, parser/reset 실패, terminal write 실패, connection close가 발생하면 transaction을 seal하고 payload/accounting을 해제하며 늦은 output, snapshot, ready, write callback을 모두 no-op으로 만든다.

터미널 자체의 비동기 변경도 하나의 mutation fence로 직렬화했다.

- legacy screen repair와 hidden local restore는 speculative mutation이다.
- authoritative snapshot은 기존 speculative 작업 뒤에 실행되며 이후 speculative 작업을 차단한다.
- matching 여부를 handler 진입 시, IME 대기 뒤 xterm reset 직전, authoritative await 뒤, ACK 직전에 다시 확인한다.
- authoritative 적용이 reject되거나 `false`를 반환하면 성공 ACK나 barrier 해제가 아니라 명시적인 `recovery-failed`/stale 상태로 남는다.

따라서 `restore-needed -> reconnect-required -> 늦은 동일 token/sequence authoritative snapshot` 순서에서도 snapshot 본문은 화면에 기록되지 않고 `screen-snapshot:ready`도 전송되지 않는다.

## Grace, hidden 및 fallback 정책

WebSocket grace buffer는 출력 문자열을 합치지 않고 원래 message와 chunk identity를 순서대로 보존한다. flush 시 restore/reconnect를 subscribed-ready보다 먼저 전달해 input barrier가 readiness 승격보다 앞서 설치된다. 동일 restore-needed는 idempotent하게 무시하며 이미 받은 output을 지우지 않는다.

hidden dirty/skipped와 local viewport restore는 authoritative state가 아니라 provisional state다. fallback snapshot도 성공 ACK하지 않는다. 서버의 기존 bounded ACK timeout이 reconnect-required로 수렴하게 하며, stale/input barrier와 hidden metadata를 유지한다. standalone `split`/`split-shadow` parity는 아직 입증되지 않았으므로 effective unified limitation을 그대로 노출하고 활성화하지 않는다.

## TDD 및 검증

T-PH002-03 RED는 unit `14 PASS / 6 FAIL`, 실제 routed-WebSocket E2E `0 PASS / 2 FAIL`에서 시작했다. 구현 및 리뷰 중 fault callback resurrection, drained accounting, grace 순서, legacy/hidden mutation race, current snapshot dedup, failed transaction의 late authoritative snapshot을 각각 회귀 계약으로 추가했다.

마지막 결함은 production 수정 전에 targeted unit `30 PASS / 1 FAIL`로 재현했다. 수정 후 결과는 다음과 같다.

- targeted unit: `31/31` PASS
- frontend typecheck: PASS
- frontend production build 및 server asset staging: PASS
- Playwright AC-4/AC-8 (`https://localhost:2222`): `2/2` PASS
- scoped ESLint: 오류 `0`, 기존 warning `5`
- full server split characterization: `8` PASS, `0` FAIL, 알려진 limitation `13` TODO
- `git diff --check`: PASS

AC-8은 실제 화면에서 늦은 authoritative marker가 나타나지 않고 동일 replay token ACK도 없음을 검증한다.

## 독립 리뷰

같은 까칠한 reviewer가 grace ordering, transaction sealing, generation/token/sequence fence, legacy·hidden·authoritative mutation 순서, 적용 실패, post-await 및 ACK 전 재검사를 반복 검토했다. 모든 finding을 수정하고 회귀 테스트를 추가한 뒤 최종 판정은 정확히 `No findings`였다.

Verification: Tier 2 automated checks and sub-agent review completed.
