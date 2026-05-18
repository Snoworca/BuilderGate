# Planner Analysis Summary

## Inputs

- SPEC: `docs/srs/buildergate.srs.md`
- Code path: `.`
- Mode: `snoworca-planner --max`
- Scope decision: server scrollback lazy loading is excluded; viewport-only restore is included.

## Parallel Analysis

- Server analysis: `serializeHeadlessTerminal()` must default to viewport-only serialization and UTF-8 byte accounting. `SessionManager` degraded fallback must not send `degradedReplayBuffer` as snapshot data.
- Frontend analysis: `TerminalView` currently saves raw `serialize()` output and appends pending output. Snapshot schema v2 must reject legacy v1 and store only viewport payloads.
- Verification analysis: tests must inspect `screen-snapshot.data`, `terminal_snapshot_*`, and visible terminal text. Latest marker visibility alone does not prove full replay absence.

## Plan Output

- Markdown: `docs/plan/2026-05-15.viewport-only-terminal-snapshot.plan.md`
- JSON sidecar: `docs/plan/2026-05-15.viewport-only-terminal-snapshot.plan.md.json`

