# Phase 4 Verification

## Completion Checklist

- [ ] resize invalidates authoritative snapshot cache
- [ ] alt-screen current-state replay is verified
- [ ] delete and restart clear replay lineage
- [ ] orphan recovery behavior is documented

## Test Evidence Required

- [ ] resize regression test
- [ ] alt-screen regression test
- [ ] delete or restart cleanup test
- [ ] workspace delete cleanup test

## Quality Gate

- [ ] no stale session lineage survives restart
- [ ] workspace lifecycle paths are covered
- [ ] full server restart limits are documented explicitly
