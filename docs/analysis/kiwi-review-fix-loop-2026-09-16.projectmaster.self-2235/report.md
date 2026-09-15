---
run_id: 2026-09-16.projectmaster.self-2235
mode: self
mode_flags: ["--auto"]
pr_url: null
findings_total: 22
classified: { immediate_fix: 8, discussion_needed: 0, rejected: 0 }
fix_iter: 3
recheck_iter: 3
regression_pass: true
closed_reqs_count: null
pr_responded: false
---

# kiwi-review-fix-loop — issue #24 / REL-BGSTAB-022

Self mode over `e7c162c..99fb015` plus the fixes applied on top (1084 lines reviewed,
430 more added across three fix rounds). Reviewer and fixer were separate
subagents in every round; the main session orchestrated only.

## Rounds

| round | reviewer findings | fixed |
| --- | --- | --- |
| 1 | CRITICAL 2, HIGH 2, MEDIUM 6, LOW 3 | FND-001, FND-002, FND-003, FND-004 |
| 2 | CRITICAL 0, HIGH 2, MEDIUM 2, LOW 3 | FND-101, FND-102 |
| 3 | CRITICAL 0, HIGH 1, MEDIUM 3, LOW 3 | FND-201, FND-203, FND-204, FND-205, FND-206, FND-207 |
| final | **CRITICAL 0, HIGH 0, MEDIUM 1, LOW 1** | gate PASSED |

## What the review actually caught

Two of the findings were real defects in the fix, not polish.

**FND-001 (CRITICAL)** — the helper made a failed backup abort the primary publish.
Every store's previous code wrapped its backup in `try { copyFile } catch {}`, so
the backup was best-effort by construction and the primary write went ahead
regardless. Routing them through one helper silently changed that: a failure
touching the *optional* backup lost the user's *required* change. Worst on the
platform the requirement targets — a peer holding the `.bak` open in its
`recoverFromBackup()` is exactly how a Windows `EPERM` on the backup rename
arises. Restored to best-effort, now with a warning rather than silence, and
pinned by three tests.

**FND-002 (CRITICAL)** — the regression gate could be falsely green. A test file
that hangs contributes no failure lines, so a change that deadlocked a suite read
as "no new failures". Follow-ups FND-101 and FND-102 closed two more paths to the
same outcome: a missing `failing` field read as zero failures, and a suite that
stops registering tests exits 0 having run nothing — the trap this repository's
own `CLAUDE.md` documents for `node --test` children inheriting
`NODE_TEST_CONTEXT`. The gate now records per-file test counts and refuses to
compare when a count drops, when a summary cannot be parsed, when either side has
a harness error, or when the after run did not cover a file the baseline ran.

**FND-003 and FND-004 (HIGH)** — two assertions claimed more than they checked.
The error-type test only asserted "not an AppError" for four rows, which any
unexpected throw satisfies; measured by replacing the injected error with an
unrelated `TypeError`, every row stayed green. And the seven-store table
discarded its backup observation with `void backupExists;`, so nothing anywhere
asserted a backup is ever written.

**FND-201 (HIGH)** — a gate test could not distinguish a deliberate refusal from
a crash in the gate itself. Closed as a class: the test helper now knows the
banners the gate can refuse under and fails loudly on a non-zero exit carrying
none of them. Verified by injection — with the tool replaced by an immediate
throw, 8 of 26 cases survive, and all 8 are pure-function cases that never spawn
it.

## Regression

Baseline re-captured at `e7c162c` in a detached worktree using the current
capture tool, so both sides carry per-file counts and the strict path runs:

- baseline 31 files / 17 failing → after 33 files / 16 failing
- no new failures; 1 no longer failing; 2 files added (the new suites)
- gate exit 0, no `GATE UNUSABLE`, no `TEST COUNT DROPPED`, no `UNVERIFIED DIMENSION`

`npx tsc --noEmit` clean. New suites: `atomicStoreWrite.test.ts` 10/10,
`StorePublishCrossInstance.test.ts` 8/8, `issue24-regression-diff.test.mjs` 26/26.

## Reviewer's closing judgement

The change implements REL-BGSTAB-022. All nine acceptance criteria were checked
against the code by a reviewer reading the requirement fresh. No `.tmp`,
`copyFile` or bare `fs.rename` publish path survives in any of the seven stores.

## Residual, carried and not gating

- **FND-202 (LOW)** — the capture does not filter `NODE_TEST_*` from its children,
  so a nested run still exits 0 rather than failing early. The falsely-green
  consequence is closed downstream: no summary yields a null count, which makes
  the gate unusable rather than green. Left alone deliberately — the tree was
  frozen for the final verdict and changing it afterwards would invalidate that
  verdict.

## Deviation from the skill

`--close-reqs` was not passed and no speckiwi mutation was made from this skill
(§0.8). REL-BGSTAB-022 stays at `Status=planned`; promoting it is not this
skill's call.
