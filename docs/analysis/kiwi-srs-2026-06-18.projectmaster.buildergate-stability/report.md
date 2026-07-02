# kiwi-srs Dry-Run Report: BuilderGate Stability

Run ID: `2026-06-18.projectmaster.buildergate-stability`

Mode: `dry-run`

## Decision

The researched BuilderGate stability work should be modeled as a new SpecKiwi scope, not appended to the active AI TUI recovery target.

- Recommended target: `0.5.5-buildergate-stability`
- Recommended scope: `BuilderGate Stability`
- Recommended prefix: `BGSTAB`
- Proposed document: `docs/spec/30.buildergate-stability.srs.md`

## Why Live Mutation Is Paused

SpecKiwi MCP is available and `validate_spec` passes, but the active target is `0.5.4-ai-tui-recovery`. A dry-run `add_requirement` for `BGSTAB` failed with `MUTATION_DENIED: Unknown scope: BGSTAB`.

Kiwi rules require target/scope confirmation before creating a new SRS scope. Therefore this run produced a dry-run SRS proposal under this analysis directory and did not edit `docs/spec`.

## Proposed Requirement Set

| ID | Title | Type | Status | Feasibility |
|---|---|---|---|---|
| FR-BGSTAB-001 | Runtime resource limits for terminal stability | functional | proposed | high |
| FR-BGSTAB-002 | Browser WebSocket input backpressure | functional | proposed | high |
| FR-BGSTAB-003 | Visible terminal output scheduling and recovery | functional | proposed | high |
| FR-BGSTAB-004 | Terminal snapshot storage budgets and tombstone expiry | functional | proposed | high |
| FR-BGSTAB-005 | Terminal runtime residency limits | functional | proposed | high |
| FR-BGSTAB-006 | Split WebSocket handshake and channel isolation | functional | proposed | high |
| FR-BGSTAB-007 | Split WebSocket terminal payload routing and failure recovery | functional | proposed | high |
| REL-BGSTAB-001 | Stability validation and non-2002 operational verification | reliability | proposed | medium |

## Evidence

- Completion report: `docs/research/2026-06-17.buildergate-remaining-stability-work-implementation-completion-report.md`
- Focused server split transport tests: `25/25 pass`
- Server full tests: `270 test(s) passed`
- Focused frontend stability tests: `44/44 pass`
- Frontend typecheck/build: pass
- Final sub-agent review from the implementation loop: `No findings`

## Remaining Gate

Live `kiwi-srs` mutation needs a target/scope decision:

1. Create new target/scope `0.5.5-buildergate-stability` / `BGSTAB` and apply this SRS proposal.
2. Or explicitly approve adding these requirements to the active `0.5.4-ai-tui-recovery` target despite the scope mismatch.
3. Or keep SRS mutation paused and proceed only with code review/validation.
