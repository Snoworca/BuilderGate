# Issue #10 premise-measurement evidence bundle

Lane: GitHub issue #10 [Orca][P3] Browser TerminalWriteCoordinator and client snapshot fence.
Branch `work/issue-2-orca-terminal-20260916`.

## Tree the measurements were taken at

Commit `9164050`. The lane brief named `160c5f5`; HEAD advanced by two commits
(`157115e`, `9164050`, both from the #9 lane) while this measurement was in progress.
`git diff --name-only 160c5f5 9164050` touches no path under `frontend/` or `server/`,
so every measurement here holds at both commits. That was checked, not assumed.

## Files

| file | what it is |
|---|---|
| `raw/P1-terminalWriteCoordinator.log` | `node --experimental-strip-types --test tests/unit/terminalWriteCoordinator.test.ts`, cwd `frontend/` |
| `raw/P1-terminalCheckpointRuntime.log` | same runner, `tests/unit/terminalCheckpointRuntime.test.ts` |
| `raw/P1-terminalSoleWriterInventory.log` | same runner, `tests/unit/terminalSoleWriterInventory.test.ts` |
| `probe/probe-ac12.v2.ts` | independent probe of AC-12(iii): are the byte and chunk caps enforced after `rollback-to-compatibility`? |
| `raw/P2-probe-ac12-v2.log` | output of that probe |
| `probe/probe-ac12.v1-invalid.ts` | the **first, invalid** version of the same probe, retained deliberately |
| `raw/P2-probe-ac12-v1-INVALID.log` | its output |

## Why the invalid probe is retained rather than deleted

v1 reported `CAP_FIRED=true` for the subject arm — a clean-looking result in the
"no defect found" direction. It was wrong twice over: its control fired on
`checkpoint-authority-conflict` rather than on the cap, so it never validated the cap
path at all; and its subject arm omitted the `settlementLedger*` options, which default
to 0 and make the very first dispatch return `overflow`, poisoning the arm before it
could reach the question. Deleting it would also delete the record that a tidy number
was produced over a question the instrument never asked.

v2 fixes both: it mirrors the committed `BOUNDED_COORDINATOR_LIMITS` fixture from
`frontend/tests/unit/terminalWriteCoordinator.test.ts:113`, and its control asserts the
cap fires **by name** (`post-checkpoint-hold-overflow`) at the arithmetically predicted
point (1 MiB / 4096 B = 256 writes). Both runs of v2 agree.

## Regenerating

From `frontend/`:

    node --experimental-strip-types --test tests/unit/<name>.test.ts
    node --experimental-strip-types ../docs/analysis/2026-09-18.issue10-write-coordinator/probe/probe-ac12.v2.ts

Read the `ℹ tests / pass / fail / todo` lines, not the exit code: a node:test file can
exit 0 with broken assertions listed under `✖ failing tests:`, and one that runs zero
tests also exits 0.

## Seal

`SHA256SUMS.txt` covers every file in this bundle except itself. Verify with
`sha256sum -c SHA256SUMS.txt` from this directory.

## Seal update — 2026-09-18, second write

`SHA256SUMS.txt` moved. The input that moved is **one added file**,
`raw/P3-coverage-discovery-blindspot.log`; no previously sealed file changed
(their individual digests are unchanged between the two seals). Recorded here
because a sealed hash moving is otherwise indistinguishable from a silent
re-blessing.

That log records a discovery gap found in **my own sweep**:
`terminalOutputScheduler.ts:2,11` re-exports `createTerminalWriteCoordinator`
from `./terminalWriteCoordinator.ts`, and the coordinator's own 63-test primary
suite reaches the factory through that re-export. The string
`terminalWriteCoordinator` occurs **zero** times in that suite, so a coverage
enumeration keyed on the module name cannot see it — nor six sibling files.
An AC can be covered by a test that whatever enumerates coverage cannot find.

## Seal update — 2026-09-18, third write

Moved inputs: **two added files**, `probe/probe-ac67911.v2.ts` and
`raw/P4-probe-ac67911-v2.log`. No previously sealed file changed.

This probe is the lane's own re-verification of the AC-6 / AC-7 / AC-11 claims
that had come from delegated measurement, run before any of them was allowed to
become an SRS criterion. Delegated measurement is adequate for a premise table
and is not adequate for a requirement.

Its own first run carried a **dead control**: the AC-6(i) arm spread `...begin()`
*after* the `type` key, so the spread reset `type` back to `checkpoint-begin`
and the arm never reached a committed checkpoint. Control and subject both
returned `recovery-required` — identical outputs, so the arm discriminated
nothing. It was caught only because both arms' results are printed rather than
a verdict. After the fix the control separates: same-epoch `{accepted:true}`
versus older-epoch `{accepted:false, reason:'stale-stream-epoch'}`.

The repair itself asserted its own match count (each anchor had to match exactly
once) before rewriting, so a replacement that silently matched nothing could not
masquerade as a successful edit.

## Seal update — 2026-09-18, fourth write

Moved input: **one added file**, `raw/P5-RED-rollback-writer-bounds.log`. No
previously sealed file changed.

That is the TDD RED run for `REL-BGSTAB-027`, captured before any production
change: `ℹ tests 5 / pass 1 / fail 4 / todo 0`, exit 1. The one pass is the
control — with a checkpoint open, the byte cap fires **by name**
(`post-checkpoint-hold-overflow`) at the arithmetically predicted write
(1 MiB / 4096 B = 256). Without that arm green the four red arms would prove
nothing, because a probe whose control is dead cannot be told apart from a
subject that is correct.

The four failures were checked for the *right* reason, not merely for failing:

| arm | assertion that failed | why it is the right reason |
|---|---|---|
| AC-1 | `admission never stopped at all` | the flood ran to its loop bound with no rejection |
| AC-2 | `admission never stopped at all` | 1-byte writes, so the byte cap cannot be what should have stopped it |
| AC-3 | `admission never stopped at all` | ledger raised far past both caps; nothing else took over |
| AC-4 | `actual: true, expected: false` | a live write at the new generation was admitted before any fresh snapshot |

One limit of AC-3 stated in advance: today the compatibility lane never stops at
all, so that arm currently fails on *"never stopped"* rather than on the
substituted reason. Its reason-discriminating assertion only becomes load-bearing
once AC-1 is green. It is not yet evidence that the ledger is not standing in for
a cap; it will be after the fix.

## Seal update — 2026-09-18, fifth write

Moved inputs: **three added files** — `raw/P6-GREEN-frontend-unit-full.log`,
`raw/P7-GREEN-rollback-writer-bounds.log`, `raw/P7-GREEN-supporting-proofs.txt`.
No previously sealed file changed.

GREEN for `REL-BGSTAB-027`: the same five-test file is now 5/5, with the control
still firing by name at the predicted write. Two things in `P7-GREEN-supporting-proofs.txt`
are load-bearing and would otherwise be unverifiable from the tree:

1. **The new test was not type-checked until it was added to the allowlist.**
   `tsconfig.test.json` carries an explicit `files` list, and a new test file is
   not picked up by it. Proven by injection both ways — before, an injected type
   error left the build at exit 0 with the file named zero times; after, exit 2
   with the compiler naming the file. The injected line was removed and the file
   restored byte-identically. The same check surfaced a real pre-existing type
   error in the test that the missing entry had been hiding.

2. **The three remaining full-suite failures are not caused by this change.**
   Measured rather than labelled: the two owning suites were run with the fix and
   again with only `terminalWriteCoordinator.ts` reverted to `5df20fc`, and the
   counts are identical in both arms (11/10/1 and 51/49/2). The file was restored
   byte-identically afterwards. They are not root-caused here; the only claim is
   that reverting this change does not remove them.

## Seal update — 2026-09-18, sixth write

Moved inputs: **two added files** — `raw/P8-guards-green.log` and
`raw/P8-mutation-testing.txt`. No previously sealed file changed.

These cover the test-only work for issue #10 AC-11 and AC-6(i), where production
was already correct and only the guard was missing. A test written against
already-correct code is green from birth, so being green says nothing about
whether it can fail. Each new assertion was therefore mutation-tested.

Three of the guards are real (M1 `clearWriteTimeout` on dispose, M2 settling the
in-flight token, M3 the `stale-stream-epoch` rejection) — deleting each turns the
suite red.

**One is not, and it is recorded rather than quietly kept.** The late-callback
test survives deletion of the `disposed` term, survives weakening the
`activeMutation !== mutation` early return, and survives **deleting both guards
as a group**. The group deletion is the decisive step, because one-at-a-time
deletion cannot separate "nothing verifies this" from "a redundant sibling
enforces it"; the group run rules the second out. Dispose has already drained the
queue, nulled `activeMutation` and settled every token, so a late callback has
nothing left to disturb. AC-11(iv) is not falsifiable through the public surface
on the dispose path.

That test is renamed to say it is a non-discriminating characterization and
carries the measurement in its own comment. It is not counted as coverage. It is
kept because deleting it would also delete the record that the question was asked.

## Seal update — 2026-09-18, seventh write

Moved inputs: **two added files** — `raw/P9-defectB-green.log` and
`raw/P9-defectB-mutation-testing.txt`. No previously sealed file changed.

Defect B: the two cap-boundary guards were strengthened and each was
mutation-verified against the specific defect it previously admitted. Production
was not changed at either site; both mutations were applied only to measure the
predicate and then reverted byte-identically.

The point of both edits is the same one: an assertion that is true of the correct
behaviour **and** of the defect is not a guard. The stronger predicate for the
first site already existed in this repo on a sibling arm and had simply never
been pointed at the cap.

## Seal update — 2026-09-18, eighth write

Moved inputs: **five added files** — `probe/probe-ac4-settings-reachability.ts`,
`probe/probe-ac4-checkpoint-pacing.ts`, `raw/P10-ac4-settings-reachability.log`,
`raw/P10-ac4-checkpoint-pacing.log`, `raw/P10-ac4-findings.txt`. No previously
sealed file changed.

AC-4 measured by execution rather than by grep, each arm with a control that
fires. It **narrows this lane's own earlier claim**: "the frame CPU budget is
never wired" was too strong. The live lane does enforce a 7 ms deadline at its
default, so on AC-4's terms ("commonly applied") that half is satisfied; what is
missing there is operator configurability, which AC-4 does not ask for.

The genuine AC-4 gap is the checkpoint lane, and it is now demonstrated rather
than inferred: the same 131072-byte body produces exactly 5 physical writes
whether each write costs 0 ms or 1000 ms of simulated clock, while the control
confirms the two arms really did differ in elapsed time (0 vs 5000). The write
count is a pure function of body size. No frame budget and no input yield reach
that lane.
