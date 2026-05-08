# Terminal Screen Repair V2 Research Synthesis

## Inputs

- SRS: `docs/srs/buildergate.srs.md`
- Research: `docs/research/2026-05-08.terminal-screen-repair-v2-recommended-implementation.md`
- Plan: `docs/plan/2026-05-08.terminal-screen-repair-v2.plan.md`

## Decision

Recommended implementation is a dedicated `screen-repair` protocol that sends only the current headless viewport as a bounded row patch. Full `screen-snapshot` restore remains reserved for subscribe, resubscribe, and reconnect flows.

## Non-Negotiables

- Do not reduce xterm scrollback.
- Do not disable repair.
- Do not rely on external Codex flags.
- Do not apply Grid/workspace repair through `term.reset()` or full snapshot write.
- Do not fallback from degraded headless repair to full snapshot replay.
- Do not build the repair patch from `SerializeAddon.serialize({ scrollback: 0 })`; derive rows from viewport buffer lines and cell attributes.
- Do not apply a repair patch when normal/alternate buffer type differs.
- Do not drop queued output on repair apply failure or ACK timeout.
- Do not reuse the replay queue helper if it tail-trims queued output; repair overflow must abort observably and flush output without silent truncation.

## Plan Coverage

- Protocol split: TASK-P1-001.
- Viewport-only server payload: TASK-P1-002.
- Queue and ACK lifecycle: TASK-P1-003.
- Non-destructive frontend apply and request-side readiness: TASK-P2-001.
- Grid/workspace/tile-resize repair routing and duplicate automatic request suppression: TASK-P2-002 and TASK-P2-003.
- Regression coverage: TASK-P3-001 through TASK-P3-003.
