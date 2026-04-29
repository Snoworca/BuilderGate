# Phase 5 Verification

- [ ] IME state가 `idle -> composing -> committing -> settling -> idle`로 전이한다.
- [ ] composition 중 repair replay가 defer된다.
- [ ] composition 중 closed/error/session/auth/workspace state는 defer되지 않고 reject/close 처리된다.
- [ ] final xterm onData가 있으면 fallback이 실행되지 않는다.
- [ ] 모든 IME timer가 `compositionSeq`와 `sessionGeneration` mismatch에서 no-op 처리된다.
- [ ] 빠른 `compositionend -> compositionstart`에서 이전 settle/deferred timer가 새 composition을 건드리지 않는다.
- [ ] fallback은 기본값에서 observe-only다.
- [ ] synthetic composition + Space/Backspace/Enter E2E 통과.
- [ ] 실제 Windows Korean IME 수동 검증 10회 반복 누락 0회.
