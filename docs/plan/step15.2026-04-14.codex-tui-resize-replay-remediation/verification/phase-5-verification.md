# Phase 5 Verification

## Pass Gates

- server tests pass
- frontend build passes
- authority E2E passes
- real Codex bounce validation is recorded without duplicate redraw or blank-gap growth

## Evidence To Capture

- `server npm test`
- `frontend npm run build`
- `playwright` result for updated authority suite
- manual validation notes for the real Codex session

## Failure Signals

- telemetry still shows unexplained replay churn during simple workspace bounce
- manual Codex validation still reproduces duplicated prompt/status blocks
