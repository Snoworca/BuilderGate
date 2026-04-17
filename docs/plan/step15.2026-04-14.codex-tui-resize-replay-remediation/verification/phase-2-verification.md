# Phase 2 Verification

## Pass Gates

- identical geometry no longer emits redundant frontend resize messages
- workspace visibility change does not create avoidable terminal height oscillation
- no unrelated terminal interaction regressions are introduced

## Evidence To Capture

- targeted test output for resize dedupe
- manual note showing stable geometry through rapid workspace switching

## Failure Signals

- repeated identical resize messages still appear in telemetry
- terminal rows visibly jump because metadata layout still resizes the viewport
