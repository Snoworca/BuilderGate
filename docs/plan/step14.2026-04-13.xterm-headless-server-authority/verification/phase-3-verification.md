# Phase 3 Verification

## Completion Checklist

- [ ] `screen-snapshot` is delivered before live output
- [ ] replay tokens are enforced
- [ ] stale acknowledgements are rejected
- [ ] frontend uses server snapshot first

## Test Evidence Required

- [ ] router ordering test
- [ ] stale-ack test
- [ ] reconnect token test
- [ ] frontend replay-first test

## Quality Gate

- [ ] no live output can bypass the replay gate
- [ ] local snapshot is no longer primary
- [ ] duplicate subscribe remains idempotent
