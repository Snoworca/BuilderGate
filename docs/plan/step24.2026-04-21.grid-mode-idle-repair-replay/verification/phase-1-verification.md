# Phase 1 Verification

- [x] repair replay protocol message added
- [x] pending replay without resize works
- [x] ACK and queued output boundary preserved
- [x] related tests executed and green

## Evidence

- `server`: `npm run test`
- relevant regressions:
  - `WsRouter starts repair replay without geometry change`
  - `WsRouter queues output during repair replay until ACK`
