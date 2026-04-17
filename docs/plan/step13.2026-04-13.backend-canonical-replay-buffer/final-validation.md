# Final Validation Template

## Summary

- Input docs:
  - codebase
  - `docs/report/2026-04-13.workspace-switch-scrollback-root-cause.md`
  - `docs/report/2026-04-13.terminal-scrollback-preservation.md`
- Planned phases: 4
- Primary strategy: backend canonical replay buffer
- Explicitly deferred: headless terminal emulator

## Requirement Trace Matrix

| Requirement | Planned Coverage |
|-------------|------------------|
| `BG-001` | phases 2, 3, 4 |
| `FR-001` | phases 1, 2 |
| `FR-002` | phase 2 |
| `FR-003` | phase 2 |
| `FR-004` | phase 2 |
| `FR-005` | phases 1, 3 |
| `FR-006` | phase 3 |
| `FR-007` | phase 3 |
| `FR-008` | phase 4 |

## Final Approval Checklist

- [ ] Protocol contract merged
- [ ] Replay buffer semantics implemented
- [ ] Frontend cutover completed
- [ ] Regression evidence attached
- [ ] Known limitations documented

## Remaining Open Issues

- exact rendered-screen parity remains out of scope without a headless terminal emulator
- persistence across full server restart remains out of scope for this plan
