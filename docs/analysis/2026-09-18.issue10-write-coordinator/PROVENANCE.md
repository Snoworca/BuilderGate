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
