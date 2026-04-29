# Phase 2 Verification

- [ ] helper textarea는 restore/replay/server-not-ready 중 disabled 되지 않는다.
- [ ] `term.options.disableStdin`은 restore/replay/server-not-ready 중 `false`다.
- [ ] helper textarea `readOnly`는 restore/replay/server-not-ready 중 `false`다.
- [ ] transient not-ready onData가 queue된다.
- [ ] queued input은 enqueue 당시 `sessionGeneration`을 저장하고 mismatch 시 reject된다.
- [ ] transportReady true 전환 시 queued input이 FIFO로 flush된다.
- [ ] TTL 초과 input은 실행되지 않고 explicit reject telemetry를 남긴다.
- [ ] Space/Backspace dead branch가 제거되거나 호출 불가능함이 테스트된다.
- [ ] `terminal-korean-ime.spec.ts`
- [ ] `terminal-paste.spec.ts`
- [ ] `terminal-mobile-scroll.spec.ts`
