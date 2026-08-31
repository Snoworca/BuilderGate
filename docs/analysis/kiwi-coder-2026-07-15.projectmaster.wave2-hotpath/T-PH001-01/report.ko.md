# T-PH001-01 UTF-8 segmented queue RED 증거

- Requirement: `PERF-BGSTAB-009`
- 범위: `frontend/tests/unit/terminalOutputScheduler.test.ts` 테스트 계약만 추가
- production 변경: 없음

## 기준선

`frontend`에서 다음 명령은 변경 전 16개 테스트를 모두 통과했다.

```powershell
node --experimental-strip-types --test tests/unit/terminalOutputScheduler.test.ts
```

- Exit: `0`
- Pass/Fail: `16/0`

## RED 결과

같은 명령을 새 계약 추가 후 실행했다.

- Exit: `1` (계획의 `expected_exit: 1`과 일치)
- 전체 Pass/Fail: `20/4`
- 기존 16개 테스트: 모두 통과
- 새 회귀 보존 계약 AC-2/AC-5/AC-6/AC-10: 통과
- 새 구조 계약 AC-1/AC-3/AC-4/AC-7: 의도한 이유로 실패

실패 signature는 다음과 같다.

1. `UTF-8 segmented queue RED AC-1: accepted ingress encode must be exactly once and prefix-loop encode must be zero`
2. `UTF-8 segmented queue RED AC-3: scheduler writes must use encoded segments/subarrays instead of string prefix copies`
3. `UTF-8 segmented queue RED AC-4: non-compacting chunk pressure must overflow instead of allocating a full pending join`
4. `UTF-8 segmented queue RED AC-7: scheduler-to-xterm staged writer must accept Uint8Array output`

따라서 현재 실패는 기존 회귀가 아니라 다음 GREEN 구현 부재를 정확히 가리킨다: injected encoder ingress 1회 사용, encoded segment/subarray writer, flush-budget 이하로 compact할 수 없는 chunk pressure의 explicit overflow, `Uint8Array` staged writer.

## 보조 검증

`git diff --check -- frontend/tests/unit/terminalOutputScheduler.test.ts`는 exit `0`이다.
