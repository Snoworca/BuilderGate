# Phase 1 Verification

## Pass Gates

- recent replay-event telemetry exists and is bounded
- telemetry endpoint returns recent lineage events
- at least one test proves event ordering for resize and replay

## Evidence To Capture

- sample `/api/sessions/telemetry` response
- test output showing lineage event assertions

## Failure Signals

- resize events cannot be tied to `sessionId/replayToken/snapshotSeq`
- telemetry grows without an explicit bound
