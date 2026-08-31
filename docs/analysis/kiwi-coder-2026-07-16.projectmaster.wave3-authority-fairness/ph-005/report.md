# PH-005 Single-authority promotion and rollback epoch

## Scope

- Requirement: `MIG-BGSTAB-002`
- Tasks: `T-PH005-01` through `T-PH005-07`
- Rollout: capability-negotiated, limited-session promotion only; no UI or product-default change and no legacy physical deletion.

## Final evidence

`authority-promotion-decision.json` records an `ACCEPT` verdict with exact input hashes and no missing or mismatched inputs.

- Compatibility: 39/39
- Focused authority contracts: 12/12
- Route guards: 5/5
- Extended regression: 59/59
- HTTPS E2E at `https://localhost:2222`: 6/6
- Registered assertions: 13/13

The evidence covers capability/no-local-cache promotion, ordered epoch handoff, single snapshot/query/side-effect authority, poisoned-cache recovery, ordered rollback, lossless delivery, and the AI TUI idle invariant.

## Review and caveat

Independent final correctness and scope/minimality reviews returned `No findings`. The retry-exhausted checkpoint-ready path now invokes the existing fail-safe rollback path. The frontend write watchdog remains a bounded recovery trigger rather than a promise that all checkpoint writes complete before its deadline; this timing boundary is documented in `ph005-ac4-timing-report.md`.

## Linked artifacts

- `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/authority-promotion-decision.json`
- `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/ph005-ac4-timing-report.md`

## Workflow reconciliation

The historical PM checkpoint retained superseded plan and sidecar hashes and blocked its official task-status mutation. The failed guarded mutation and confirmed repair record are retained by SpecKiwi; the current hashes and PH-005 task completion projection were updated in the UTF-8 local workflow state. Historical JSONL diagnostics remain an unrelated legacy tooling limitation.
