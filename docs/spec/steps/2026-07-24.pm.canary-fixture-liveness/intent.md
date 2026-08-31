# Intent: 2026-07-24.pm.canary-fixture-liveness

Repair only the `TerminalResourcePolicyCanary` test fixture that replaces a complete `HeadlessTerminalState` with an incomplete fake. The fake makes the production cleanup path throw before test-owned sessions and CWD watchers are released, leaving the existing fair-delivery replay unable to complete. The step preserves production behavior and restores a finite, observable test cleanup path so `PERF-BGSTAB-010` evidence can later be replayed fail-closed.
