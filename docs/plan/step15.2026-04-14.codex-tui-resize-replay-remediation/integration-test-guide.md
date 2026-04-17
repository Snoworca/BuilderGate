# Integration Test Guide

## Environment

- target app: `https://localhost:2002`
- redirect helper: `http://localhost:2001`
- Vite dev server: `http://localhost:2003`
- login password: `1234`

## Automated Coverage Goals

1. Server tests must prove:
   - no-op resize is ignored
   - meaningful resize still works
   - snapshot fencing removes overlap
2. Playwright must prove:
   - hidden workspace recovery still works
   - restart lineage still works
   - new resize and replay regressions stay green

## Required Manual Codex Scenario

This scenario is mandatory before the fix is considered complete.

1. Open a session terminal.
2. Launch `codex`.
3. Enter this prompt exactly:

   `1부터 500까지 종 방향으로 출력해줘`

4. Wait until the terminal clearly contains deep vertical output beyond the current viewport.
5. Open another workspace and interact with a second terminal there.
6. Rapidly switch back and forth between the two workspaces several times.
7. Verify all of the following:
   - no duplicated Codex prompt/status block appears
   - no large artificial blank vertical gap grows
   - earlier lines remain scrollable
8. Refresh on the Codex workspace.
9. Repeat the workspace bounce.
10. Verify the same invariants again.

## Optional Stress Variant

After step 7, in the Codex session submit:

`Run /review on my current changes`

This is useful because the footer/status region redraw is visually easy to detect.

## Recommended Evidence Capture

- visible terminal screenshot before bounce
- visible terminal screenshot after repeated bounce
- telemetry snapshot from `/api/sessions/telemetry`
- if needed, local terminal snapshot content for duplicate marker counting
