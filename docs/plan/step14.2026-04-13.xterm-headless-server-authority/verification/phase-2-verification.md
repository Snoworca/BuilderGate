# Phase 2 Verification

## Completion Checklist

- [ ] each session owns a headless terminal
- [ ] cached authoritative snapshot exists
- [ ] degraded-session behavior is defined
- [ ] config migration is implemented

## Test Evidence Required

- [ ] cache reuse test
- [ ] degraded-session test
- [ ] config migration test

## Quality Gate

- [ ] no raw replay buffer remains the source of truth
- [ ] memory bounds are explicit
- [ ] cleanup paths are still intact
