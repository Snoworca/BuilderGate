# Public fixture RED evidence

This focused test ran while the planned public-fixture module was absent and
before any implementation for that module was added.

| Field | Value |
|---|---|
| Command | `cd server && npx.cmd --no-install tsx --test src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` |
| Exit code | `1` |
| Test summary | `tests 1`, `pass 0`, `fail 1` |
| Failure code | `ERR_MODULE_NOT_FOUND` |
| Missing module | `src/services/TerminalResourcePolicyCanaryPublicFixture.fixture.js` |

This is recovery test-support evidence only. It does not close or promote a
parent `PERF-BGSTAB-010` acceptance criterion.
