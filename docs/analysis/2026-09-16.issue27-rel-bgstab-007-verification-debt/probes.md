# Mutation probes — issue #27 / REL-BGSTAB-007

Baseline HEAD: `a395550`, branch `work/issue-2-orca-terminal-20260916`.
All probes were applied transiently, run, then reverted. None is committed.
Every command ran with **cwd = `server/`**.

Purpose: issue #27 asserts two tests are vacuous. A claim of vacuity is only
settled by injecting the defect the test claims to catch and observing whether
the test goes red. Reading the source is not enough.

## PROBE-A — is the remount test failure-capable on `streamEpoch`?

Target: `RetainedTerminalAuthority.test.ts`, test
`Retained server model shadow and driver lease RED contract — REL-BGSTAB-007 AC-10`.

Injected into `server/src/services/SessionManager.ts`,
`registerRetainedTerminalClientView`, inside the `previous?.viewGeneration !== viewGeneration` branch:

```ts
retained.streamEpoch = String(BigInt(retained.streamEpoch) + 1n); // MUTATION-PROBE-A
```

Command:
`npx tsx --test --test-name-pattern 'REL-BGSTAB-007 AC-10' src/services/RetainedTerminalAuthority.test.ts`

Result: **FAIL (1 fail / 0 pass)** → the test detects a remount that starts a new stream epoch.

## PROBE-B — is it failure-capable on checkpoint content?

Injected into `server/src/services/SessionManager.ts`,
`unregisterRetainedTerminalClientView`, right after `retained.clients.delete(clientId);`:

```ts
if (data?.headless) this.initializeHeadlessState(sessionId, data); // MUTATION-PROBE-B: remount wipes model
```

Command: same as PROBE-A.

Result: **FAIL (1 fail / 0 pass)** → the test detects a remount that wipes the server model.

**Conclusion (A+B): the remount test is NOT vacuous.** Issue #27's stated mechanism
("두 번 읽는 대상이 같은 세션 객체") is also wrong:
`SessionManager.buildRetainedTerminalAuthorityState` (`SessionManager.ts:7556`) constructs a
fresh object per call and re-serialises the checkpoint from the live headless terminal
(`SessionManager.ts:7592-7597`), so `before` and `after` are independent snapshots.

## PROBE-C — is the AC-8 poisoned-cache parity assertion vacuous?

Structural basis: before this lane's change, the implementation was
`async recoverView() {` with **zero parameters** (`TerminalAuthorityController.ts:1357`),
whose body called `options.loadAuthoritativeRecovery()` with no arguments. The declared
interface (`:238`) took an `input`, so the argument was accepted by the type system and
then discarded at runtime.

Probe: remove the contrast entirely — make both calls identical — in
`TerminalAuthorityController.test.ts`, test
`Single-authority promotion and rollback epoch RED contract — MIG-BGSTAB-002 AC-4`:

```ts
const poisoned = await harness.controller.recoverView({ connectionId: 'reload-absent', viewGeneration: 1, cacheState: 'absent' }); // PROBE-C
```

Command:
`npx tsx --test --test-name-pattern 'MIG-BGSTAB-002 AC-4' src/services/TerminalAuthorityController.test.ts`

Result: **PASS (1 pass / 0 fail)** → deleting the whole absent/poisoned contrast changes
nothing. `assert.deepEqual(absent, poisoned)` compared two invocations of the same nullary
function and could not fail for any input.

**Conclusion: the AC-8 parity assertion WAS vacuous.** Repaired in this lane.

Note on attribution: that test is titled `MIG-BGSTAB-002 AC-4`, not `REL-BGSTAB-007 AC-8`.
Issue #27 attributes it to REL-BGSTAB-007 AC-8. The recorded mismatch is deliberate —
the assertion does carry AC-8's cache-parity obligation, but the test's own identity is MIG.

## PROBE-D — does the repaired parity assertion have teeth?

After the repair, the harness gained an opt-in fault:
`createHarness(contract, { poisonAuthoritativeRecoveryOnCacheState: true })` makes the
authoritative recovery port honour the browser's local cache state — exactly what AC-8 forbids.

Probe: enable that fault inside the *parity* test (not the negative control):

```ts
const harness = createHarness(contract, { poisonAuthoritativeRecoveryOnCacheState: true }); // PROBE-D
```

Command: same as PROBE-C.

Result: **FAIL (1 fail / 0 pass)**, `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal`.

**Conclusion: the repaired assertion detects a cache-sensitive recovery.** The committed
negative-control test `Cache-poisoned authoritative recovery parity is failure-capable —
REL-BGSTAB-007 AC-8` keeps this property under permanent guard, so the assertion cannot
silently go vacuous again.

## Regression framing

### node:test file-level arm (`TerminalAuthorityController.test.ts`)

`TerminalAuthorityController.test.ts` carries **12 pre-existing failures** on this branch.
Proven pre-existing by stashing only the two files this lane changed and re-running:
baseline `tests 147 / pass 135 / fail 12`, with-change `tests 148 / pass 136 / fail 12`,
and the failing-name sets are identical (`raw/failing-set.baseline.txt` vs
`raw/failing-set.with-change.txt`). **Each of those two files contains exactly 12 lines,
one per failing test name.** (Earlier revisions of these artifacts also carried the
captured `✖ failing tests:` banner line, which made them 13 lines and invited a reader
counting lines to read "13 failures"; the banner has been stripped.)

One additional name, `MIG-BGSTAB-002 production promotion deadline follows the configured
browser ACK contract exactly once`, failed in a single early full-file run. It did **not**
recur in three subsequent full-file runs with the change (`raw/*.with-change-run{1,2,3}.log`)
and passes in isolation three times on both arms. Classified load-dependent, not a
regression — it is a deadline/timing test and the observation is concurrent-run only.

### Monolithic runner arm (`server/src/test-runner.ts`)

Command (cwd = `server/`): `npx tsx src/test-runner.ts`.

Measured four times — twice at HEAD and twice at baseline, where "baseline" is the
`HEAD~2` version of the two files this lane changed, restored into the worktree:

| Arm | Run | Artifact | Result |
|---|---|---|---|
| HEAD | 1 | `raw/monolithic-runner.head-run1.log` | 538 PASS / 3 test(s) failed |
| HEAD | 2 | `raw/monolithic-runner.head-run2.log` | 538 PASS / 3 test(s) failed |
| baseline | 1 | `raw/monolithic-runner.baseline-run1.log` | 538 PASS / 3 test(s) failed |
| baseline | 2 | `raw/monolithic-runner.baseline-run2.log` | 538 PASS / 3 test(s) failed |

The three failing names are identical across all four runs:
`SessionManager keeps PowerShell prompt redraw idle in heuristic mode`,
`SessionManager powershell shell bootstrap avoids delayed prompt-hook injection`,
`authRoutes twoFactor.externalOnly: localhost bypass skips TOTP (bugfix)`.

**The failure count is not stable run-to-run.** Earlier in the same session two runs of
this same runner reported **4** failed; all four artifact-backed runs above reported **3**.
No claim of stability is made here — only that the four runs captured as artifacts agree
at 3, and that an earlier unretained observation disagreed at 4. The delta between the
HEAD and baseline arms is zero in every retained run, which is the only comparison this
arm is used for.

The monolithic runner is self-contained and **does not discover `*.test.ts`**, so the
test this lane added to `TerminalAuthorityController.test.ts` cannot change its totals.
Its 538/3 figure is therefore a same-total control, not coverage of the change.
