# Phase 3 Verification

- [x] replay pending input이 `queuedInputs`에 저장된다.
  - 검증: `testWsRouterQueuesInputWhileReplayPendingAndFlushesAfterAck`
- [x] ACK 후 queued output, queued input, ready 순서가 보장된다.
  - 검증: 기존 output ordering test 유지, ACK path에서 `flushQueuedReplayInputs(..., 'ack')`가 `session:ready`보다 먼저 실행됨.
- [x] stale ACK는 queued input을 flush하지 않는다.
  - 검증: `testWsRouterDoesNotFlushInputForStaleAck`
- [x] replay refresh는 queued input을 보존한다.
  - 검증: `testWsRouterPreservesInputQueueAcrossReplayRefresh`
- [x] timeout은 TTL 정책에 따라 flush 또는 explicit reject한다.
  - 검증: `testWsRouterFlushesSafeInputOnReplayTimeout`, `testWsRouterRejectsExpiredReplayInputOnAck`, `testWsRouterRejectsExpiredReplayInputOnTimeout`
- [x] invalid payload/sequence는 PTY에 쓰지 않고 reject한다.
  - 검증: `testWsRouterRejectsInvalidInputPayload`, `testWsRouterRejectsInvalidInputSequenceRange`
- [x] unsafe/nested/raw client metadata는 telemetry에 복사되지 않는다.
  - 검증: `testWsRouterSanitizesClientInputMetadata`
- [x] real server reject scenario에서 `input:rejected`가 발생한다.
  - 검증: `testWsRouterEmitsInputRejectedForRealServerScenarios`
- [x] `input:rejected`가 frontend terminal debug capture까지 전달된다.
  - 검증: `TC-7209: server input rejection is routed into terminal debug capture`
- [x] `npm --prefix server run test`

## 실행한 검증

- `npm --prefix server run build` PASS
- `npm --prefix frontend run build` PASS
- `npm --prefix server run test` PASS, 176 tests
- `npx playwright test tests/e2e/terminal-keyboard-regression.spec.ts --project="Desktop Chrome" --grep "TC-7209" --workers=1` PASS

## 구현 메모

- `ClientWsMessage.input`은 optional `inputSeqStart`/`inputSeqEnd`를 포함한다.
- `ServerWsMessage`에 `input:rejected`를 추가했고, `WebSocketContext`가 `server_input_rejected` debug event로 기록한다.
- `WsRouter`는 input message를 type cast로 신뢰하지 않고 payload/sequence/metadata whitelist 검증 후 write 또는 queue한다.
- Noncanonical `inputSeq` 단일 필드는 `invalid-sequence`로 reject된다.
- Queue mode에서 replay pending input은 64 KiB UTF-8 byte budget, 3000 ms TTL로 보관된다.
- Timeout path는 Enter 포함 input을 `timeout-enter-safety`로 reject하고, Enter 없는 TTL 유효 input만 flush한다.
