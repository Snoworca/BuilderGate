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

## Seal update — 2026-09-18, ninth write

Moved inputs: **two added files** — `raw/P11-ac9-full-unit.log` and
`raw/P11-ac9-mutation-testing.txt`. No previously sealed file changed.

AC-9(ii). This retracts a claim this lane carried from its premise table: **"no
test asserts zero loss" was wrong**, and it was search-derived. Injecting real
loss defects reddens committed tests — four of them for dropped post-checkpoint
output, one for a truncated snapshot body.

The accurate statement is narrower and more useful: loss is covered for both
modes tried, but **only incidentally**, by tests named for other properties
(watermark/drain semantics, and pacing). The property had no named owner, so
rewriting the pacing test would have silently unguarded snapshot-body loss.

The new `terminalSnapshotLiveHandoverIntegrity.test.ts` gives it one, asserting
loss, duplication and ordering over **one** byte stream rather than in the three
separate lanes where they had been covered piecemeal.

Its **first draft was green and exercised the wrong path** — live writes
dispatched after `checkpoint-commit` never enter the post-checkpoint hold, so
three of four mutations survived. Moving them before the commit fixed the
scenario and all four are now caught. Without mutation testing this lane would
have shipped a green test that asserted nothing about the handover it names.

## Seal update — 2026-09-18, tenth write

Moved inputs: **two added files** — `raw/P12-liveness-guard-green.log` and
`raw/P12-ac4-gate.txt`. No previously sealed file changed.

The orchestrator gated AC-4 (b) on landing a test that observes the failure mode
the pacing change risks — a **hung or torn** terminal, not an unpaced one — and
made an inability to build one the signal to defer (b) rather than the size of
the change. **The gate is satisfied**: the new liveness guard reddens on a real
stall with `ready never opened — the lane stalled`, and pins write-kind ordering
so a tear is red too. It asserts its own precondition (ready closed before the
drain) so that convergence cannot be satisfied vacuously.

The finding worth carrying: the **first** stall injection survived and looked
like a weak guard. It was a **dead mutation** — it targeted two `pump()` sites
that do not govern the checkpoint slice loop, and the tell was that the
observable event log came back byte-identical to the unmutated run, which a real
stall cannot produce. A surviving mutation means either a weak test or a
mutation that never reached the path, and the two are separated by checking the
mutation changed behaviour at all. A dead mutation is a dead control.

## Seal update — 2026-09-18, eleventh write

Moved input: **one repaired file**, `raw/P12-ac4-gate.txt`. Nothing else changed.

Naming the cause, because a moved seal is otherwise indistinguishable from a
silent re-blessing: the tenth write produced that file with an unquoted
backtick-wrapped `pump()` inside a shell `echo`, so the shell ran it as a command
substitution, emitted an error, and **swallowed the token** — the sealed line
read "the two  calls at lines 990 and 1044". The seal was computed over that
damaged text. This write restores the missing token and re-seals.

The damage was visible only because the shell also printed a syntax error and the
file was re-read afterwards. A quieter substitution would have sealed silently.
Evidence written through `echo` is subject to the shell's own expansions; a
quoted heredoc is not.

## Seal update — 2026-09-18, twelfth write

Moved inputs: **three added files** — `probe/probe-ac8-dirty-clear.ts`,
`raw/P13-ac8-dirty-clear.log`, `raw/P13-ac8-findings.txt`. No previously sealed
file changed.

AC-8(ii), the last read-only verdict in this lane, now partly executed. The clear
itself is measured, with a positive control (the input really was dirty) and a
negative control (an already-clean state passes through by identity, so clearing
is a real transition rather than the function's only mode).

Two things are deliberately kept separate from that measurement:

1. That the local-snapshot path **reaches** the clear with no ACK is still read
   from source — the React component was not executed. The adjacent branch is
   conformant, setting `provisionalLocalState = true` and returning without
   finishing recovery when a resync is active.
2. Whether `hiddenOutputState.skipped` is within `REL-BGSTAB-025` AC-1's meaning
   of "dirty" is a **specification question, not a measurement**. AC-1 governs
   the retained-state local snapshot cache; `hiddenOutputState` tracks output
   skipped while the view was hidden. They may be the same dirty or two unrelated
   ones, and this lane does not record a violation on the strength of a name
   match — the `policyIdentity` trap in the other direction.

The probe's own first version invented its fixture fields and asked the question
of a shape the code never sees. A fixture whose fields are guessed cannot pose
the question it claims to; the corrected version is what is sealed, with the
first version's error recorded in its header.

## Seal update — 2026-09-18, thirteenth write

Moved inputs: **two added files** — `raw/P14-ac4b-full-unit.log` and
`raw/P14-ac4b-findings.txt`. No previously sealed file changed.

AC-4 (b) implemented under the orchestrator's gate, TDD-first. The RED carried a
**negative control** — an unconfigured coordinator must be unchanged — without
which both subjects would have been satisfied by an implementation that defers
unconditionally and changed behaviour for every caller that opted into nothing.

One limit is recorded rather than left implicit: the coordinator behaviour is
executed, but that the production wiring reaches the lane **at runtime** rests on
a typecheck and a read of the call site. Present-in-source and applied-at-runtime
are different claims — the same distinction `#95` drew for `#101`. Browser-level
confirmation belongs to the Playwright step.

## Seal update — 2026-09-18, fourteenth write

Moved inputs: **two added files** — `probe/probe-ac8-recovery-trigger.ts` and
`raw/P15-ac8-recovery-trigger.log`. No previously sealed file changed.

AC-8(ii) resolved on the orchestrator's reduction: not "is this the same word",
but "does clearing the bit remove a system-visible indication that output is
unaccounted for". **It does.** The hidden-output recovery trigger at
`TerminalContainer.tsx:3713-3715` is gated on `isVisible && skipped`, so once the
bit is cleared a later visibility transition no longer re-attempts recovery.

Measured by applying the real guard predicate to the real clear function's
output, across three dirty shapes: armed `true` → `false` in every case. A
negative control (never-dirty state) is already `false`, so the transition is
real; a positive control shows the predicate can return `true`, so "disarmed"
carries information.

Stated limit: the guard predicate is **transcribed** from the call site and the
React component was not executed. The composition is measured; the call site is
read.

Recorded as `REL-BGSTAB-025` VE-2, a counterexample against a `planned`
requirement. **No AC checked, no status changed** — this is not a withdrawal of a
verification claim but a record against a contract that is not yet implemented.
The fix belongs to that requirement; this lane changed no code for it.

## Seal update — 2026-09-18, fifteenth write

Moved inputs: **two added files** — `raw/P16-browser-verification.txt` and
`browser/issue10-ac4b-runtime-marker.png`. No previously sealed file changed.

Browser verification at `https://localhost:2222` against a server built and
booted from this checkout. What it establishes and what it does not are kept
apart:

**Established.** The app built from these changes loads over HTTPS, authenticates
and mounts a terminal, so `TerminalView` executed its coordinator construction
site in a real browser; and a deterministic round trip through the modified
sole-writer coordinator produced **exactly two** occurrences of a unique marker —
the shell's echo and the command output. The count is the assertion: loss would
show zero or one, duplication three or more.

**Not established — the residual.** The AC-4(b) pacing wiring could not be
exercised, because `WsRouter.ts:2515-2522` advertises `authorityMode: 'legacy'`
and `checkpointDeliveryActive: false` when no authority view is promoted, which
is every ordinary session today. The live server log recorded zero checkpoint
activity, with the control that the log had 49 lines. Server checkpoint authority
is inactive **by design** — `REL-BGSTAB-007` is `planned`, promotion is gated to
PH-004/PH-005 under #11 and #12 — so a browser cannot today tell a coordinator
that honours the frame budget from one that ignores it. The residual is recorded
in `P16` rather than left implicit, and its cause is architectural rather than a
flaky probe.

One tool note worth the same treatment as `#100`: the Playwright MCP browser
resolves output paths against **its own workspace root**, and wrote the screenshot
into the **main worktree**, not this one. It was untracked there, was moved into
this bundle, and main was left clean. Another tool whose root is not the worktree
the work is happening in.

## Seal update — 2026-09-18, sixteenth write

Moved inputs: **two added files** — `raw/P17-review-round.txt` and
`raw/P17-postreview-full-unit.log`. No previously sealed file changed.

**This entry supersedes a claim in the tenth-write seal above rather than editing
it.** That entry said "the gate is satisfied: the new liveness guard reddens on a
real stall". The stall was real and the guard did redden, but the guard builds its
coordinator with **no budget and no yield**, so it never enters
`deferCheckpointFrame` and cannot observe a defect inside the deferral — which is
the risk the gate was about. The injection was made at the pre-pacing `pump()`
site, at a tree where the defer branch did not yet exist. The risk **is** covered,
by `terminalCheckpointLanePacing`, whose arms enable pacing and assert
`pendingCommands === 0` after quiescence including when the predicate or the
scheduler throws. The mis-attribution is corrected in the production comment and
both test headers.

A hostile self-review over the whole lane returned eight findings, and **two of
the HIGHs were defects this lane introduced**: the compatibility guard charged the
checkpoint body to the compatibility budget and latched a recovery on a healthy
view, and a throwing yield predicate or scheduler dropped the checkpoint
continuation outright. Both are fixed, each with a regression arm confirmed to
discriminate by reverting the fix and watching it redden. `P17-review-round.txt`
carries the full disposition, including three drafts of test arms that were wrong
before they were right.

## Seal update — 2026-09-18, seventeenth write

Moved inputs: **two added files** — `raw/P18-rereview-round.txt` and
`raw/P18-postrereview-full-unit.log`. No previously sealed file changed.

A second hostile round reviewed the fix diff with the prior findings supplied as
titles only. It verdicted all eight as resolved (or, for FND-008, deliberately
not) and mutation-tested the two HIGH fixes itself rather than accepting them.

It then found **four new defects, every one introduced by the fixes**, and two of
those are the *same defect class as the finding they were fixing*: the efficiency
fix removed the bound that made the scan cheap, and the comment written to correct
an overclaim itself overclaimed. All four are now fixed. The severity gate was met
before they were — 0 CRITICAL, 0 HIGH — so these were repaired because they were
real, not because a gate demanded it.

One is disclosed as uncovered: RND-003's repair moved the frame-deadline clear to
where a checkpoint's drain begins, and the pacing suite builds one checkpoint per
coordinator, so neither the original carry-over nor this repair is visible to it.
