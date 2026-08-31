# Intent: 2026-07-27.pm.fair-readmission-closure-v3-internal-core

Restore the temporal provenance guarantees that became untestable after protected I/O was
made private. The step keeps the native capture boundary closed and isolates only
deterministic state transitions for direct, non-authoritative tests.
