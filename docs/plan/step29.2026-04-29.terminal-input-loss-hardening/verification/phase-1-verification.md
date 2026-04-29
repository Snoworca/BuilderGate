# Phase 1 Verification

- [x] Hangul printable metadata가 원문 없이 기록된다.
- [x] safe control preview 기존 동작이 유지된다.
- [x] xterm/helper textarea event tape가 debug capture enabled에서만 동작한다.
- [x] `xterm_data_dropped_not_ready`, `ws_input_dropped_not_ready`, `input_blocked`, `ws_send_rejected_not_open`가 metadata를 포함한다.
- [x] `inputReliabilityMode`가 기본 `observe`로 노출되고, localhost 테스트 override가 가능하다.
- [x] `captureSeq`와 `compositionSeq`가 관측 전용 metadata로 전파된다.
- [x] `KeyboardEvent.code`와 printable/Hangul raw value가 debug capture에 저장되지 않는다.
- [x] `npm --prefix server run build`
- [x] `npm --prefix frontend run build`
- [x] `npm --prefix server run test`
- [x] `npx playwright test tests/e2e/terminal-keyboard-regression.spec.ts tests/e2e/terminal-korean-ime.spec.ts --project="Desktop Chrome" --workers=1`
- [x] `git diff --check`
- [x] Phase completion reviewer 재검토: `No findings`

## Notes

- Phase 1은 관측성 기준선이므로 실제 입력 손실 완화 동작은 Phase 2 이후 범위다.
- Playwright E2E는 기존 로컬 테스트 workspace 포화 상태를 피하기 위해 test-prefixed stale workspace 정리 경로를 함께 검증했다.
