# T-PH002-02 Client-local repair state와 fresh snapshot GREEN 보고

- Requirement: `REL-BGSTAB-008`
- 범위: server screen-repair queue, recovery protocol, safe-send cancellation, 회귀 계약
- authority/UI/default 변경: 없음

## 구현 결과

- screen repair 대기 출력을 거대한 단일 문자열이 아니라 chunk deque와 UTF-8 byte 계수로 보존한다.
- byte 상한은 `Math.min(runtimePtyConfig.maxSnapshotBytes, 262_144)`, chunk 상한은 `resourceLimits.headless.pendingOutputMaxChunks`의 직접 계약을 사용한다.
- overflow, timeout, write failure가 발생하면 이전 repair token을 폐기하고 affected client만 fresh authoritative snapshot 또는 명시적 reconnect-required 상태로 전환한다.
- snapshot sequence 이하임이 입증된 prefix만 제거한다. sequence가 없거나 snapshot보다 새로운 chunk는 identity와 순서를 유지한 채 ACK 뒤 정확히 한 번 전달한다.
- fresh snapshot ACK는 tail이 0개여도 `session:ready`를 전송한다. 두 번째 overflow나 ACK timeout은 output/ready를 풀지 않고 reconnect-required로 수렴한다.
- parse failure와 authority unavailable은 fresh replay와 reconnect를 동시에 만들지 않는다.
- safe-send queue에서는 superseded repair/restore/snapshot뿐 아니라 affected session의 이전 transaction-tagged `session:ready`도 제거한다. 다른 session의 ready/output/control 순서와 output/control byte counter는 보존한다.
- telemetry에는 raw terminal payload를 넣지 않고 byte, chunk, sequence, token, reason, outcome, source만 기록한다.

## TDD 및 검증

T-PH002-01의 RED 계약을 GREEN으로 전환했다. 최종 리뷰 중 발견된 safe-send 경쟁 조건도 별도 RED로 재현했다.

```text
initial snapshot 전송
  -> bufferedAmount pressure
  -> replay ACK의 session:ready가 queue에 대기
  -> 후속 repair overflow
  -> fresh snapshot ACK 전 drain
```

수정 전에는 `restore-needed -> stale ready -> fresh snapshot` 순서로 AC-10이 실패했다. replay/repair transaction token을 ready에 부착하고 affected session의 이전 ready를 취소한 뒤 같은 테스트가 통과했다. unrelated session ready는 그대로 남는다.

최종 검증 결과:

- `npm run build`: PASS
- screen-repair filter: `21/21` PASS
- strict split contract: `5/5` PASS
- full split: `8` PASS, `0` FAIL, 기존 limitation `13` TODO
- server full regression: `507/507` PASS
- scoped `git diff --check`: PASS

## 독립 리뷰

동일한 까칠한 reviewer가 sequence coverage, zero-tail ready, 단일 recovery outcome, safe-send stale frame 취소, prior-ready backpressure race, client isolation, byte counter 및 telemetry redaction을 반복 검토했다.

중간 HIGH 5건을 모두 수정하고 회귀 테스트를 추가한 뒤 최종 판정은 정확히 `No findings`였다.

Verification: Tier 2 automated checks and sub-agent review completed.
