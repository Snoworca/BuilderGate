# Phase 4 Verification

- [ ] `WebSocketContext.send()` 실패가 호출자에게 반환된다.
- [ ] reconnect 중 input이 outbox에 들어간다.
- [ ] outbox entry는 enqueue 당시 `sessionGeneration`을 저장하고 mismatch 시 reject된다.
- [ ] reconnect 후 session ready에서 FIFO flush된다.
- [ ] microbatcher가 printable run만 합치고 control boundary는 보존한다.
- [ ] paste, auto-repeat space, Enter ordering이 깨지지 않는다.
- [ ] `terminal-keyboard-regression.spec.ts`
- [ ] `terminal-paste.spec.ts`
