# Phase 4 Verification

- [x] `WebSocketContext.send()` 실패가 호출자에게 반환된다.
- [x] reconnect 또는 transient send failure 중 input이 transport outbox에 들어간다.
- [x] outbox entry는 enqueue 당시 `sessionGeneration`을 저장하고 mismatch 시 reject된다.
- [x] reconnect/session ready 이후 FIFO flush된다.
- [x] microbatcher가 printable run만 합치고 control boundary는 보존한다.
- [x] paste, auto-repeat space, Enter ordering이 깨지지 않는다.
- [x] `terminal-keyboard-regression.spec.ts`
- [x] `terminal-paste.spec.ts`

## 구현 요약

- `frontend/src/contexts/WebSocketContext.tsx`
  - `send()`가 `SendResult`를 반환한다.
  - input 전송 실패는 `not-open`, `missing-token`, `stale-socket`으로 구분된다.
  - localhost debug capture에서 다음 input send 실패를 강제하는 테스트 훅을 추가했다.
- `frontend/src/utils/terminalInputSequencer.ts`
  - `TerminalContainer` 소유 input sequence range를 생성한다.
  - 8ms 창에서 단일 printable chunk만 coalesce하고, Enter/control/escape/paste-like multi-character chunk는 boundary로 즉시 flush한다.
  - 서버 sequence span 한계인 1024를 넘기기 전에 pending printable run을 split/flush한다.
- `frontend/src/components/Terminal/TerminalContainer.tsx`
  - `sessionReady=false` 또는 `send()` 실패 시 ref 기반 transport outbox에 queue한다.
  - queue entry는 `sessionGeneration`, TTL, UTF-8 byte length, `inputSeqStart/inputSeqEnd`를 보존한다.
  - TTL, overflow, context mismatch, closed/error state는 `transport_input_rejected`로 남긴다.
  - `stale-socket` send failure는 늦은 flush를 막기 위해 즉시 `transport-closed`로 reject한다.
  - observe mode에서는 기존 동작을 유지하면서 `transport_input_would_queue`/`transport_input_would_reject`를 기록한다.
- `server/src/services/SessionManager.ts`, `server/src/ws/WsRouter.ts`
  - PTY input debug capture에 `inputSeqStart/inputSeqEnd`를 포함해 browser debug, WS message, server debug를 연결한다.

## 검증 결과

- `npm --prefix frontend run build`: PASS
- `npm --prefix server run build`: PASS
- `npm --prefix server run test`: PASS, 176 tests
- `node --import ./server/node_modules/tsx/dist/loader.mjs --test ./frontend/tests/unit/terminalInputSequencer.test.ts`: PASS, 2 tests
- `npx playwright test tests/e2e/terminal-keyboard-regression.spec.ts --project="Desktop Chrome" --workers=1`: PASS, 13 tests
- `npx playwright test tests/e2e/terminal-paste.spec.ts --project="Desktop Chrome" --workers=1`: PASS, 2 tests

2026-04-30 review fix 이후:

- `npx playwright test tests/e2e/terminal-keyboard-regression.spec.ts --project="Desktop Chrome" --workers=1`: PASS, 13 tests

## 추가 회귀 테스트

- `TC-7210`: printable rapid input이 coalesced range로 전송되고 Enter가 다음 sequence boundary로 보존된다.
- `TC-7211`: queue mode에서 강제 WebSocket input send 실패가 transport outbox에 queue된 뒤 retry flush되어 입력이 보존된다.
- `TC-7212`: `stale-socket` send failure는 queue/flush되지 않고 `transport-closed`로 reject된다.
- `TC-7213`: Hangul `insertText` 직후 Space가 transport reject 없이 관측되고 debug에 원문을 남기지 않는다.
- `terminalInputSequencer.test.ts`: 1024/1025 sequence span split과 control boundary 순서를 검증한다.

## Review

- Phase 4 reviewer 재검토 결과: `No findings`
