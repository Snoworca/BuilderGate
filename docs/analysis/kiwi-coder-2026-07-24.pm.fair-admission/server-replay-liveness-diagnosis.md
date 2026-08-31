# PH-002 server replay liveness diagnosis

`PERF-BGSTAB-010` remains `in_progress`; the existing baseline is not admitted. Provenance was unchanged before and after replay, and the decision-artifact verifier passed, but the specified five-file server test bundle did not complete after 124.8 seconds and produced no TAP output.

## Frozen observation

- Process chain: `102684 -> 4960 -> 36396 -> 77444`.
- All processes were `node.exe` from the ProjectMaster `server` working directory and ran the specified test bundle with `--test-timeout=0`.
- The processes were waiting with negligible CPU use and no TCP listener or child process. They were not terminated: they are not the verified BuilderGate listener on port 2222.

## Static candidates

1. `server/src/services/TerminalResourcePolicy.test.ts:1466-1474` invokes a nested `tsx` CLI with `execFileSync` and no timeout/max-buffer bound. A non-exiting child blocks that test worker synchronously.
2. The same test repeatedly scans server and frontend source with TypeScript AST inventory discovery. Concurrent `tsx` workers can delay first output, although this is not itself proof of a permanent hang.
3. The scheduler/route candidates are less likely: the fair-maintenance interval is `unref()`ed and route tests use `finally` cleanup; the no-server WebSocket fixture does not listen.

## Committee decision

Three independent research agents unanimously selected **read-only liveness diagnosis** rather than natural waiting, composite/isolated rerun, process termination, or strict-TDD behavior work. The next diagnostic must identify the blocking chain without starting a new test run or modifying source. A concrete behavior defect, if found later, starts a separate strict SDS -> RED -> GREEN scope.

## Post-fixture replay

After the fixture-only TDD repair, the exact five-file command was rerun once under the decision-approved 124-second observation policy. It finished in 15.9 seconds with 91 of 97 tests passing and six failures, so the replay remains rejected but is no longer liveness-blocked.

- Five `TerminalResourcePolicy` cases fail with `TypeError: Cannot mix BigInt and other types` at `SessionManager.queueAcceptedHeadlessOutput:4235`.
- One same-ID finalizer case fails with `TypeError: Cannot read properties of undefined (reading 'comparisonTimer')` at `SessionManager.settleRetainedTerminalTermination:6249`.
- No Node process was terminated and no second replay was run. Existing prior test process chains remained untouched.

These are concrete fail-closed follow-up candidates. They are not `PERF-BGSTAB-010` AC evidence and do not change that parent requirement's state.
