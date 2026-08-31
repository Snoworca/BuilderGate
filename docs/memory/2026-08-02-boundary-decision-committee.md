# Boundary Decision Committee Record — 2026-08-02

## Scope

- Governance change requested by the user; Requirement ID: N/A (repository agent-governance documentation, not a runtime behavior change).
- This record is an incident/decision log. It is not SRS verification evidence, a workflow completion record, or a Phase completion claim.
- The `Autonomous Boundary Decision Committee` exception permits this narrowly-scoped operational audit record to use `N/A`; it neither changes a requirement nor creates an alternate requirements source.

## Trigger facts

- `OBS-BGSTAB-005` planned files were present as user-owned untracked files in the original worktree and absent from the isolated implementation worktree.
- A workflow operation reported `confirmed`, but the canonical durable worklog read-back did not contain the corresponding recent `PH110` event.
- `REL-BGSTAB-014` evidence was produced in an isolated worktree, so evidence and completion claims require an explicit worktree boundary rather than cross-worktree reuse.

## Raw evidence snapshot

### Canonical workflow workspace and read-back

- MCP and workflow workspace response: `C:\Work\git\_Snoworca\ProjectMaster`; active target: `wave-3`; MCP response metadata: `generatedAt=2026-08-01T22:51:52.613Z`; workflow response metadata: `generatedAt=2026-08-01T22:51:57.177Z`.
- Canonical run: `2026-08-01.projectmaster.wave3-closeout`. The adoption boundary task is `T-PH110-04` (`OBS-BGSTAB-005`, AC-6); the related blocked closure tasks are `T-PH110-02`, `T-PH110-03`, `T-PH110-07`, `T-PH110-08`, `T-PH110-09`, `T-PH110-11`, `T-PH110-12`, and `T-PH110-13`.
- Durable read-back source: `.kiwi/sessions/2026-08-01.projectmaster.wave3-closeout/worklog.jsonl`; 14 lines; SHA-256 `af4e584d3e58c96d96ebb03e2d473cf75b070036a4095c9668c9f2a1ff793686`. It has two `T-PH110-01` records (lines 13–14) and zero records for every listed blocked task, including `T-PH110-04`.
- The corresponding missing `workflow_worklog_emit` event payload and idempotency key are not recoverable from a durable source. This is itself an audit finding: no retry or repair may be attempted until a new canonical event snapshot supplies both values.
- `workflow_doctor` reported `blocking=true`, outcome `invalid_artifact`, while its nested validation reported `outcome=ok`; response metadata was `generatedAt=2026-08-01T22:55:25.577Z`. Its recorded artifact hashes were: plan `0930624dfde38f102543fbf143fcce4c3a13b3949a6722944ad481aaeb9919de`; sidecar `21c7672a670391d23be8ff5209eae9ac62721a1efe51c2743b73650fc25ee628`; PM state `cdc2e67086b3c74a81d50fae46c6ec90d2d7d6b8c0951529489efc1ec71e47a4`; pipeline `2747605b557b6c7b1d0fdabc423e1e0a027ee6ae90cbc21bf382307d32960c1e`.

### Worktree and source ownership snapshot

| Field | Original user worktree | Isolated rebuild worktree |
| --- | --- | --- |
| Root | `C:\Work\git\_Snoworca\ProjectMaster` | `C:\Work\git\_Snoworca\ProjectMaster-wave3-rebuild` |
| Git common dir | `.git` | `C:/Work/git/_Snoworca/ProjectMaster/.git` |
| Branch | `work/mcp-session-orchestration-20260709` | `codex/wave3-remediation` |
| HEAD | `ab272be8219e165c7187ec8ebd098ffaff4e3a99` | `c1157ab5ae42e025064abfc0766893d60ab8c515` |
| `git status --porcelain=v1` fingerprint | `7f96bf6d7592f9c65a6118892d8163150032f04bf7a22a1ed8b7e33506034776` (292 lines) | `58a244904559e17ed25b624abe8c806e289a02094eb8e1c651f576eecda3e169` (8 lines) |

| Original user-owned untracked path | SHA-256 | Isolated rebuild state |
| --- | --- | --- |
| `C:\Work\git\_Snoworca\ProjectMaster\server\src\services\TerminalResourcePolicyInventory.ts` | `5a14b19d0bba43737fdd3408bd5b7efaa4bdfc9fd9cbd69b86c957eded87bb09` | absent |
| `C:\Work\git\_Snoworca\ProjectMaster\docs\analysis\kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness\terminal-resource-consumer-manifest.json` | `1d6dcff51115ed5760cf6a9f30a169060d052d46feaf465ec1d205d79f5bd155` | absent |
| `C:\Work\git\_Snoworca\ProjectMaster\server\src\services\TerminalResourcePolicy.test.ts` | `c346d218767b52635b5e18ebecb72470be550f42791a8b3a8ef5b53be838c255` | absent |
| `C:\Work\git\_Snoworca\ProjectMaster\tools\wave3\terminal-resource-consumer-manifest.test.mjs` | `19269f9a6ec9bd70cc8c12629a5c1dbef13e678296f1d94bb8100a78fa41d3e4` | absent |

## Independent decision inputs

1. **Preservation and ownership review**: source worktree files must remain untouched; adoption requires explicit provenance, hashes, isolated handling, and unanimous approval.
2. **Workflow integrity review**: `confirmed` is not durable completion. Event read-back, a single canonical retry, constrained repair, and then supported `blocked` status are the only automatic recovery path.
3. **Lifecycle and safety review**: worktree identity must be explicit; no evidence may cross the boundary without canonical re-verification. Existing port/process safeguards remain fail-closed.

The first two inputs were newly commissioned independent reviews. The third input was an already-completed independent lifecycle review because the agent-thread capacity did not permit a fresh third review of the same raw evidence. Therefore this record is a two-review, fail-closed preservation action only, not a completed three-member adoption, repair, or closure decision. A fresh three-member committee must be automatically convened before any future adoption, repair, SRS promotion, or closure.

## Decision

- Do not adopt, stage, copy, commit, move, delete, or overwrite the user-owned untracked executable source or tests from the original worktree.
- Preserve those files in place. When the related work is eligible, recreate it in the canonical worktree from the approved SRS using strict TDD; do not retrospectively label pre-existing files as TDD-derived evidence.
- Do not close `PH110` or promote related SRS/phase status while durable workflow read-back is missing.
- For a missing durable workflow event: this incident has no durable event payload/idempotency key, so repair is not authorized. For a future complete snapshot, emit and read back the canonical event, retry once with the same idempotency, use only a supported repair after dry-run and a fresh three-member approval, then leave the task `blocked` if read-back still fails.
- Do not manually edit workflow logs, PM records, SRS lifecycle metadata, checklists, or completed-work logs to simulate persistence.
- Treat the `REL-BGSTAB-014` isolated-worktree result only within its explicitly recorded worktree boundary; re-run canonical verification before it is used as canonical evidence elsewhere.

## Safety constraints retained

- The Orca reference checkout remains read-only.
- No `git reset`, `git clean`, or broad process termination is authorized by this decision.
- Existing SRS stability, verification, TDD, and Phase review gates remain mandatory.

## Wave 3 resume committee — 2026-08-02

### Fresh raw facts

- Official `get_next_work_order` and `workflow_resume_hint` select `T-PH110-02` (`REL-BGSTAB-007`), while the PM task itself is `blocked`.
- `workflow_doctor` reports top-level `blocking=true` with `invalid_artifact`; its nested task validation reports `ok`. The canonical worklog has 14 lines and no durable event for `T-PH110-02` or the other blocked PH110 tasks.
- The original user worktree contains 292 dirty entries, and the existing rebuild worktree has 8 dirty entries. Neither is a permitted implementation location.

### Three independent votes

| Role | Decision | Rationale summary |
| --- | --- | --- |
| Preservation and ownership | C | Preserve both dirty worktrees; a new code worktree cannot cure missing durable task authority. |
| Audit and workflow integrity | C | Reconcile the official workflow contradiction before any TDD, SRS, or closure mutation. |
| SRS, TDD, and delivery | C | Resolve the blocked-task/persistence conflict before establishing a strict TDD unit. |

**Unanimous action:** use only official workflow diagnostics, one canonical idempotent emit/read-back attempt, and a constrained dry-run repair. Do not edit code or task/SRS status until durable read-back succeeds. If it does not, retain the `blocked` state and record the failure; the later TDD restart must use a new clean dedicated worktree.

## Workflow-recovery outcome and PM tool-gap — 2026-08-02

### Durable recovery evidence

- The first recovery event was emitted through MCP `workflow_worklog_emit` with a unique event `run_id` (`2026-08-02.projectmaster.wave3-closeout.t-ph110-02-workflow-recovery`) while keeping the canonical workflow run as `2026-08-01.projectmaster.wave3-closeout`.
- The guarded write returned `written=true`; MCP `workflow_worklog_tail` then read back that exact event at durable line 15. This resolved the earlier false `confirmed`/no-append condition for this new event only.
- Source-inspection evidence for the former false confirmation is the installed SpecKiwi `dist/core/workflow/mutation.js` lines 346–350 (SHA-256 `fe9a6794855d55fad63e5c51da439d95079d7884cdde940f364b216ded041c76`): JSONL duplicate detection uses `skill|event.run_id`, returns `confirmed`, and does not append on a match. Reusing the canonical workflow run as the event run ID therefore matched a prior record and prevented an append. No external tool package was modified.

### PM lifecycle inconsistency

- The official `workflow_task_status_set` authorization rule permits `pm_task_status_update` only for owner `kiwi-pm` or `pm`; a `codex`-owner attempt was rejected with `SRS-E070` and made no write.
- Retrying as owner `kiwi-pm` in dry-run mode succeeded, but readback of its generated state showed `T-PH110-02` already marked `in_progress` while retaining a historical `ended_at`, an obsolete summary that says persistence is blocked, and aggregate `stats.running=0`.
- The installed supported PM mutation can change only `tasks[].status`; it cannot clear `ended_at`, replace the stale summary, or recalculate aggregate statistics. No supported guarded mutation exists for the complete PM lifecycle repair. Direct PM JSON editing remains prohibited.

### Constrained repair record decision

- A guarded `workflow_repair_record` dry-run, journal key `00122816ceb0c51d81a4bd058c82f0a9e6c4aa43a2973136617e3f1c159c20de`, succeeded with no diagnostics. It would append exactly one `CORRECTION` event that supersedes only the obsolete persistence-pending statement.
- The fresh three-person committee split on applying it: preservation/ownership and workflow/audit approved the append-only audit correction; lifecycle review rejected it as insufficient because it cannot make PM state coherent. The 3/3 requirement for an actual repair was therefore not met, and no actual repair record was written.
- No new worktree, test run, production source change, SRS mutation, task completion, or Phase/Wave completion claim is authorized from this state. The required next action is a supported SpecKiwi PM-state reconciliation capability (or an explicit governing-policy change), followed by a new unanimous boundary review.
