# Phase 3 Verification

## Pass Gates

- server no-op resize returns without PTY mutation
- `screenSeq` does not change on unchanged geometry
- authoritative snapshot generation waits for the intended drain boundary

## Evidence To Capture

- unit or integration test proving no-op resize behavior
- test proving snapshot/live-output overlap is removed for a TUI-style sequence

## Failure Signals

- `refreshReplaySnapshots()` still runs on unchanged geometry
- the same marker frame can appear in both snapshot and live output
