# PowerShell resolution RED evidence

The AC-6 test was added before the fixture exposed the fake PTY's received
spawn command or arguments.

| Field | Value |
|---|---|
| Command | `cd server && npx.cmd --no-install tsx --test src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` |
| Exit code | `1` |
| Test summary | `tests 1`, `pass 0`, `fail 1` |
| Failure | `fixture.spawnCommand` was `undefined`, expected `powershell.exe` |

This evidence verifies only the new test-support resolution observation. It
does not close or promote any parent `PERF-BGSTAB-010` criterion.
