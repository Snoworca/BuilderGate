# Phase 4 Verification

## Pass Gates

- replay refresh happens only for meaningful lineage changes
- fallback behavior does not reintroduce duplicate Codex footer blocks
- hidden-workspace and restart lineage tests remain green

## Evidence To Capture

- replay telemetry sample from a refresh or reconnect run
- regression test output for TUI footer/status stability

## Failure Signals

- fallback path still grows blank gaps or duplicates status blocks
- pre-existing authority regressions become flaky
