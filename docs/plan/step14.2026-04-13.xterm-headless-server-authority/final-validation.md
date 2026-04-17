# Final Validation Template

## Summary

- Input docs:
  - codebase
  - `docs/report/2026-04-13.server-side-terminal-emulation-research.md`
  - `docs/plan/step14.2026-04-13.xterm-headless-server-authority/00-3.investigation-synthesis.md`
- Planned phases: 5
- Primary strategy: `node-pty` plus `@xterm/headless` with server-authoritative `screen-snapshot`
- Explicitly deferred:
  - durable screen state across full server restart
  - multi-node replication

## Requirement Trace Matrix

| Requirement | Planned Coverage |
|-------------|------------------|
| `BG-001` | phases 2, 3, 4, 5 |
| `BG-002` | phases 3, 4, 5 |
| `BG-003` | phases 2, 5 |
| `FR-001` | phases 1, 2 |
| `FR-002` | phase 2 |
| `FR-003` | phases 1, 3 |
| `FR-004` | phases 1, 3 |
| `FR-005` | phase 3 |
| `FR-006` | phase 3 |
| `FR-007` | phases 3, 5 |
| `FR-008` | phases 2, 4 |
| `FR-009` | phases 1, 4 |
| `FR-010` | phases 2, 4 |
| `FR-011` | phases 1, 2 |
| `FR-012` | phase 5 |

## Final Approval Checklist

- [ ] Phase 1 proved headless serialization quality
- [ ] `SessionManager` owns authoritative headless state
- [ ] tokenized `screen-snapshot` handshake replaced raw replay
- [ ] resize, alt-screen, delete, and restart edge cases are covered
- [ ] observability and rollout evidence are attached
- [ ] Codex prompt `1부터 300까지 종 방향으로 출력하시오` was validated across workspace switching and refresh

## Remaining Open Issues

- `@xterm/headless` remains an experimental dependency and must be monitored closely after rollout
- full screen-state persistence across a full server restart remains out of scope for this migration
