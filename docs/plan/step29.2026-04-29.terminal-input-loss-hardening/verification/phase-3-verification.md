# Phase 3 Verification

- [ ] replay pending input이 `queuedInputs`에 저장된다.
- [ ] ACK 후 queued output, queued input, ready 순서가 보장된다.
- [ ] stale ACK는 queued input을 flush하지 않는다.
- [ ] replay refresh는 queued input을 보존한다.
- [ ] timeout은 TTL 정책에 따라 flush 또는 explicit reject한다.
- [ ] invalid payload/sequence는 PTY에 쓰지 않고 reject한다.
- [ ] unsafe/nested/raw client metadata는 telemetry에 복사되지 않는다.
- [ ] real server reject scenario에서 `input:rejected`가 발생한다.
- [ ] `npm --prefix server run test`
