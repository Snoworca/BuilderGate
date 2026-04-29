# Phase 2 Verification

- [x] helper textarea는 restore/replay/server-not-ready 중 disabled 되지 않는다.
- [x] `term.options.disableStdin`은 restore/replay/server-not-ready 중 `false`다.
- [x] helper textarea `readOnly`는 restore/replay/server-not-ready 중 `false`다.
- [x] transient not-ready onData가 queue된다.
- [x] queued input은 enqueue 당시 `sessionGeneration`을 저장하고 mismatch 시 reject된다.
- [x] transportReady true 전환 시 queued input이 FIFO로 flush된다.
- [x] TTL 초과 input은 실행되지 않고 explicit reject telemetry를 남긴다.
- [x] Space/Backspace dead branch가 제거되거나 호출 불가능함이 테스트된다.
- [x] `terminal-korean-ime.spec.ts`
- [x] `terminal-paste.spec.ts`
- [x] `terminal-mobile-scroll.spec.ts`
- [x] `npm --prefix frontend run build`
- [x] `npm --prefix server run test`
- [x] `npm run test:docs`
- [x] `node --test tools/daemon/build-daemon-exe.test.js`
- [x] `npx playwright test tests/e2e/terminal-keyboard-regression.spec.ts tests/e2e/terminal-korean-ime.spec.ts tests/e2e/terminal-paste.spec.ts tests/e2e/terminal-mobile-scroll.spec.ts --project="Desktop Chrome" --workers=1`
- [x] `npx playwright test tests/e2e/terminal-mobile-scroll.spec.ts --project="Mobile Safari" --workers=1`
- [x] `git diff --check`
- [x] Phase completion reviewer: `No findings`

## Notes

- `terminal-mobile-scroll.spec.ts`는 로컬 workspace 슬롯 포화로 409가 발생할 수 있어 test-prefixed stale workspace eviction을 반복형으로 보강했다.
- `terminal-mobile-scroll.spec.ts`는 모바일 WebKit reload 직후 터미널 DOM attach가 지연될 수 있어 fresh workspace 활성화 단계에 1회 reload 복구를 추가했다.
- `TerminalContainer`는 delayed session handler가 stale `wsStatus='reconnecting'` closure를 보지 않도록 최신 WebSocket status를 ref에서 읽는다.
- `ws-connected`, reconnect TTL, disconnected 경로는 `server-error`, `session-exited`, `workspace-or-session-changed`, `auth-expired` 같은 explicit closed reason을 clear/overwrite하지 않는다.
- `npm --prefix frontend run lint`는 실행했으나 기존 전역 lint debt로 실패했다. 이번 Phase 변경 파일 외의 기존 `no-explicit-any`, React compiler/ref 규칙 위반이 다수 포함되어 별도 정리 범위로 둔다.
