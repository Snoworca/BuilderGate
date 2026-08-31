# Wave 3 reentry baseline — 2026-08-01

## Scope and authority

- Active target: `wave-3`; work mode: `sdd`.
- This is a provenance record only. It is not historical strict-TDD, implementation, verification, or lifecycle-closeout evidence.
- `C:\Work\git\_Snoworca\ProjectMaster` remains the user-owned external baseline. Do not reset, delete, stage, or overwrite its existing changes during reentry.
- `C:\Work\git-none\orca` is read-only reference material and was not modified.

## Sealed source baseline

| Item | Value |
| --- | --- |
| Source worktree | `C:\Work\git\_Snoworca\ProjectMaster` |
| Branch / HEAD | `work/mcp-session-orchestration-20260709` / `ab272be8219e165c7187ec8ebd098ffaff4e3a99` |
| `git status --porcelain=v1 -uall` at intake | 83 tracked entries, 876 untracked file entries, 959 total |
| Recovery-only full freeze | `C:\Work\git\_Snoworca\ProjectMaster-wave3-reentry` |
| Clean reentry input | `C:\Work\git\_Snoworca\ProjectMaster-wave3-rebuild` on `codex/wave3-rebuild-base` at the same HEAD |

The clean reentry input contains only the already-approved SRS/planning overlays and the explicitly copied Wave 3 planning artifacts. It is not a reconstruction of the user-owned untracked runtime/test implementation.

## Explicit planning allowlist copied to clean input

| Artifact | SHA-256 |
| --- | --- |
| `docs/plans/2026-08-01.projectmaster.wave3-closeout.plan.md` | `A671A8954CB23216FBAB48E9827AC0A4317B4248A7A30E41D958317139C74D88` |
| `docs/plans/2026-08-01.projectmaster.wave3-closeout.sidecar.json` | `60D828A74D87303214E1534A509FA2EDC887CF59E9DE19EB9EDB21E5D57C75ED` |
| `docs/plans/2026-08-01.projectmaster.wave3-closeout.validator.json` | `B5195D346E01BC644A2B1793927684CAFFE83D03575C4CFA43C24BC04A1C0AAC` |
| `docs/analysis/kiwi-planner-2026-08-01.projectmaster.wave3-closeout/inventory.json` | copied only after source-to-target SHA equality verification |

Excluded from a future remediation copy unless a specific TDD task allowlists and hashes them: generated analysis trees, stale July PM/session state, runtime artifacts, and all other user-owned tracked or untracked changes.

## Current evidence posture

- Wave 3 plan v0.5.2 covers 11 non-discarded requirements and 79 acceptance criteria; independent plan review returned `No findings`.
- PH-100 revalidation identified real and evidence-contract failures. None is treated as complete. The next planned repair order is reentry intake, current revalidation, foundations, policy/authority, promotion, fair delivery, hidden recovery, then guarded closeout.
- The `ready:false` wire-shape choice is intentionally unresolved. `T-PH120-04` is the blocking user-decision gate; no FR-BGSTAB-022 or MIG-BGSTAB-002 runtime/test behavior change may pass it without that decision.

## Verification

- Source and clean-input copies of the four planning artifacts were compared by SHA-256 after the v0.5.2 sync.
- Independent plan review after the v0.5.2 remediation: `No findings`.
- This record intentionally does not update SRS lifecycle fields or replay the stale 2026-07-28 PM session.
