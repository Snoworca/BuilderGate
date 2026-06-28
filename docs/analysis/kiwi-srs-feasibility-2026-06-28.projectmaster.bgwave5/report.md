# Kiwi SRS Feasibility Report - BuilderGate Wave5

## Summary

- run-id: `2026-06-28.projectmaster.bgwave5`
- target: `0.5.5-buildergate-stability`
- evaluated requirement: `REL-BGSTAB-002`
- feasibility: high
- stability action: no-op, already `evolving`
- status action: `planned` was applied through SpecKiwi MCP after strict validation rejected `proposed` for this project.

## Rationale

Wave5 is implementable inside current server and daemon boundaries. Current code already has `SessionManager.terminateAllSessions()`, cleanup telemetry, internal shutdown routing, daemon stop state handling, and daemon stop tests. The gap is connecting graceful shutdown to bounded session cleanup evidence and making `stop-client.js` validate that evidence.

The research instruction not to create a new `FR-BGSTAB-013` is preserved: the SRS record added for Wave5 is reliability requirement `REL-BGSTAB-002`, not a new functional requirement. Existing MCP tools exposed to this session cannot mutate existing `REL-BGSTAB-001` AC/evidence/trace rows safely, so this reliability requirement records the Wave5 research and implementation contract without direct manual edits to `docs/spec/*.srs.md`.

## Evidence

- Research plan: `docs/research/2026-06-27.buildergate-wave5-shutdown-evidence-soak-plan.md`
- Wave summary: `docs/research/plug-leak/wave5.md`
- SRS: `docs/spec/30.buildergate-stability.srs.md`
- Code anchors:
  - `server/src/services/gracefulShutdown.ts`
  - `server/src/routes/internalShutdownRoutes.ts`
  - `server/src/index.ts`
  - `tools/daemon/stop-client.js`
  - `server/src/test-runner.ts`
  - `tools/daemon/stop-client.test.js`

## Gate Result

- CRITICAL: 0
- HIGH: 0 accepted / 1 rejected
- MEDIUM: 1

Rejected HIGH: an isolated SRS evaluator correctly noted that kiwi-srs generic trace-cap policy would keep `addition_site` requirements at `proposed`. In this repository, strict SpecKiwi validation rejects `Status=proposed` (`SRS-E005`) while accepting `planned`; existing BGSTAB records also contain `addition_site` traces on non-proposed requirements. Therefore `REL-BGSTAB-002` remains `planned` until implementation evidence is attached. This conflict must be revisited if the project SRS status enum is expanded.

MEDIUM: `REL-BGSTAB-002` duplicates some validation intent from `REL-BGSTAB-001`, but it is a temporary traceability workaround caused by limited MCP mutation exposure. Completion reporting must explicitly mention this.
