# Wave 3 PH-100 current baseline revalidation — 2026-08-01

## Scope

- Plan: `docs/plans/2026-08-01.projectmaster.wave3-closeout.plan.md` v0.5.2.
- This was a read-only measurement of the user-owned baseline, run by two independent verification agents.
- No source, test, SRS, Wave, service, or process state was changed. Results are not lifecycle-closeout evidence.

## Result matrix

| Task / requirement | Result | Current conclusion |
| --- | --- | --- |
| T-PH100-01 / OBS-BGSTAB-005 | failed | AC-6 manifest fingerprint drift: `TerminalView.tsx` signature and `TerminalContainer.tsx` (`@127825` expected, `@130025` actual). The detector works; the sealed inventory is stale. The command stopped before its server suite. |
| T-PH100-02 / REL-BGSTAB-010 | failed, 42/46 pass | Named REL acceptance tests passed; composite failed on OBS inventory and a PERF canonical-resolver expectation. No REL runtime defect is proven by this run. |
| T-PH100-03 / FR-BGSTAB-022 | failed, 198/201 pass | Checkpoint runtime expectations omit actual `ready:false`; this is consistent with the AC-5 ready barrier. A separate PERF assertion expects `supportsHiddenDataGapRecovery:false` while source advertises `true`; this is not an FR-only failure. |
| T-PH100-04 / REL-BGSTAB-011 | failed, 55/56 pass | Populated Ordinal64 rollover changes oldest marker from expected `7:6` to `8:0` and loses retained records. The v0.5.2 repair task tracks canonical rollover under `REL-BGSTAB-007 AC-4`; it must not be misattributed to REL-011 AC-2/4. |
| T-PH100-05 / MIG-BGSTAB-002 | failed, server 25/38 pass | Static assertions look for absent `TerminalAuthorityProductionAdapter.js`; the source is `.ts`. Frontend tests did not run after the failing server stage, so MIG acceptance cannot be closed. |
| T-PH100-06 / OBS-BGSTAB-006 | failed | Evidence self-test has a stale test-name identity allowlist, including later REL-007/REL-012 names. It stopped before diagnostic fixtures; no runtime authority defect is proven. |
| T-PH100-07 / REL-BGSTAB-014 | passed, 65/65 | Current daemon identity/sentinel/stop-client regression command passed. This is current evidence only; it does not itself close lifecycle records. |
| T-PH100-08 / REL-BGSTAB-015 | passed, 1/1 | Public fixture passed, but it does not cover all six unchecked SRS ACs or full monolith/PERF regression. |

## Required follow-up gates

- `REL-BGSTAB-007 AC-4` rollover repair is a real behavior fix and must begin in an allowlisted remediation worktree with a test-only RED commit before source change.
- OBS-BGSTAB-005, OBS-BGSTAB-006, MIG-BGSTAB-002, REL-BGSTAB-014, and REL-BGSTAB-015 require current-evidence/tool-contract work; none may be silently treated as runtime success.
- FR-BGSTAB-022 and MIG-BGSTAB-002 runtime/test changes remain blocked at `T-PH120-04` until the user chooses the `ready:false` wire contract: omit the field or send explicit `false` during recovery.
- PH-100 is failed/blocked, not complete. No requirement lifecycle field was updated.
