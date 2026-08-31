# T-PH003-02 Bounded restore state machine GREEN 보고

- Requirement: `REL-BGSTAB-009`
- Task: `T-PH003-02`
- 판정: GREEN
- 독립 재리뷰: `No findings`

## 구현 결과

기존 `createVisibleOutputRecoveryCoordinator`를 유일한 복구 권위로 유지하면서 다음 상태와 장벽을 확장했다.

- connection/session/view/xterm generation과 transaction/repair/replay token을 함께 검사한다.
- live output과 복구 중 사용자 입력을 기존 byte/chunk 한도 안에서 UTF-8 기준으로 보관한다.
- overflow는 queue generation을 폐기하고 `restoreNeeded` 및 fresh snapshot 복구 결과를 명시한다.
- live scheduler idle 뒤 authoritative snapshot을 쓰고, snapshot 이후 held tail의 모든 credit을 소진한 뒤 matching ready와 repair ACK를 통과해야 input을 해제한다.
- stale callback, stale timer, old xterm generation, superseded snapshot은 현재 transaction을 변경하지 않는다.
- write timeout은 outstanding chunk credit에 묶인 bounded timer와 empty FIFO completion probe로 판정한다.
- replay가 유발한 xterm auto-reply는 전송하지 않고 관측 가능한 suppression 결과를 남긴다.
- incomplete parser state와 pending escape tail은 ready를 금지하고 reconnect 복구로 수렴한다.
- dispose/remount/supersede는 output, timer, probe, listener accounting을 해제하며 보관 입력은 raw payload 없이 명시적으로 reject한다.
- `retainedHistoryEquivalent`는 Wave 3 권위 검증 전까지 계속 `false`다.

## 검증

- 신규 restore coordinator 계약: 9/9 PASS
- 기존 visible output recovery 회귀: 11/11 PASS
- 합산 targeted unit: 20/20 PASS
- frontend typecheck: PASS
- task-scoped ESLint: 0 errors, 0 warnings
- scoped `git diff --check`: PASS
- 전체 frontend unit 관측: 293개 중 287 PASS, 6 FAIL
  - 실패 6건은 동시 진행 중인 `T-PH003-03`의 계획된 `Remount adapter RED`뿐이다.
  - T-PH003-02 및 그 이전 회귀 실패는 없다.

독립 까칠 리뷰 1차에서 input byte cap, supersede/dispose input disposition, timer-credit binding의 HIGH 3건을 발견했다. 모두 수정하고 ASCII/CJK/emoji/empty 경계, disposition, duplicate/wrong timer identity 회귀를 보강한 뒤 같은 리뷰어에게 재평가를 받아 최종 `No findings`를 받았다.

Verification: Tier 2 automated checks and sub-agent review completed.
