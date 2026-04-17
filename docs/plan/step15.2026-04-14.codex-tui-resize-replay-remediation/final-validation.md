# Final Validation

## Functional Gates

- [ ] workspace bounce does not duplicate Codex prompt/status blocks
- [ ] workspace bounce does not create large artificial blank gaps
- [ ] no-op resize does not mutate PTY or replay lineage
- [ ] meaningful resize still updates geometry correctly
- [ ] refresh and reconnect still restore the authoritative screen
- [ ] hidden workspace recovery still works
- [ ] restart invalidates old snapshot lineage correctly

## Test Gates

- [ ] `server npm test` passes
- [ ] `frontend npm run build` passes
- [ ] Playwright authority suite passes
- [ ] manual Codex scenario on `https://localhost:2002` passes

## Telemetry Gates

- [ ] recent replay events are available
- [ ] simple workspace bounce does not show unexplained resize churn
- [ ] replay lineage can be explained by telemetry for one real run

## Ship Decision

The change is ready only if:

1. the manual Codex scenario is clean
2. automated regressions are green
3. telemetry confirms that replay churn now matches real geometry changes rather than UI noise
