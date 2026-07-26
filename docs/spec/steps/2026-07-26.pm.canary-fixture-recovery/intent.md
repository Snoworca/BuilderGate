# Intent: 2026-07-26.pm.canary-fixture-recovery

Create a fresh, independently verifiable test-only session fixture harness after
the prior untracked Canary fixture step was abandoned for missing durable TDD
evidence. The harness will start with a real missing-module RED and verify public
session creation, fake-PTY registration, and bounded cleanup without touching
the existing untracked Canary monolith, production code, or parent PERF
lifecycle state.
