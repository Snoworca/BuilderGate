# SDS: 2026-07-26.pm.canary-fixture-recovery

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.canary-fixture-recovery |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

The prior Canary fixture step cannot be completed as strict TDD because its large
test file is untracked and has no recoverable RED/test-first evidence. This step
creates a new, small, test-only fixture harness from a fresh RED. It does not
modify, import, extract from, or claim provenance for the existing Canary
monolith, and it cannot satisfy any parent PERF acceptance criterion by itself.

## 2. Goals / Non-goals

- Goal: create a focused test-only harness that observes one public
  `SessionManager.createSession` call using an in-process fake PTY.
- Goal: prove the harness records one fake-PTY spawn, one `onData` registration,
  the actual created session identity, and bounded public cleanup.
- Goal: capture a genuine missing-module RED before the harness is added.
- Non-goal: modify production source, protocol behavior, scheduler behavior, or
  the existing untracked `TerminalResourcePolicyCanary.test.ts` monolith.
- Non-goal: alter `PERF-BGSTAB-010` Status, AC state, Verification Evidence,
  trace links, or use this test-support work as fair-delivery admission evidence.

## 3. Architecture Decisions

- **Decision**: add a self-contained test-only harness beside the focused test /
  basis: the existing helper is private to an untracked 3,000+ line monolith /
  trade-off: narrow intentional duplication of fake-PTY observation /
  rejected: modifying, extracting, or deleting user-owned untracked code to
  recreate a retrospective RED.
- **Decision**: use public `createSession` and `deleteSession` around an
  in-process fake PTY / basis: this exercises the constructor path and makes
  cleanup observable without a native process /
  trade-off: test setup includes deterministic fake PTY bookkeeping /
  rejected: private session-map injection or production cleanup seams.

## 4. Interfaces

- `createObservedHeadlessSessionFixture(input): ObservedHeadlessSessionFixture`
  — test-only factory that creates one headless session through public
  `SessionManager.createSession` and exposes immutable observation counters.
- `ObservedHeadlessSessionFixture.dispose(): Promise<void>` — calls public
  `deleteSession`, settles within the test bound, and rejects when its owned
  session remains registered.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the focused recovery test imports the planned harness before it
  exists, THE TEST RUNNER SHALL fail with a module-resolution error and a
  non-zero exit status.
- SDS-AC-2: WHEN the recovery harness creates a fixture, THE SYSTEM SHALL call
  public `SessionManager.createSession` exactly once and the in-process fake PTY
  SHALL observe exactly one spawn and one `onData` registration.
- SDS-AC-3: WHEN the fixture is returned, THE SYSTEM SHALL expose the exact
  session created by the public constructor rather than a manually injected
  private-map value.
- SDS-AC-4: WHEN the fixture is disposed, THE SYSTEM SHALL invoke public
  `deleteSession`, settle within the test bound, and leave no owned session or
  unreleased fake-PTY callback.
- SDS-AC-5: WHEN this recovery harness is added, THE SYSTEM SHALL leave
  production imports, the existing untracked Canary monolith, and the parent
  `PERF-BGSTAB-010` lifecycle and acceptance state unchanged.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | `server/src/services/TerminalResourcePolicyCanaryRecovery.test.ts` | Import the planned absent harness and preserve the non-zero module-resolution RED result. |
| SDS-AC-2 | `server/src/services/TerminalResourcePolicyCanaryRecovery.test.ts` | Assert one public create, one fake-PTY spawn, and one `onData` registration. |
| SDS-AC-3 | `server/src/services/TerminalResourcePolicyCanaryRecovery.test.ts` | Assert the observed state is the identity stored after public construction. |
| SDS-AC-4 | `server/src/services/TerminalResourcePolicyCanaryRecovery.test.ts` | Assert bounded public delete cleanup, no owned session, and no held callback. |
| SDS-AC-5 | independent diff and import audit | Confirm only the new test and test-only harness change; confirm the old monolith hash and parent SRS lifecycle rows are unchanged. |

## 7. Open Questions

- (none; the three-member decision committee unanimously selected this isolated
  harness on 2026-07-26. The narrow test-support design is self-agreed.)
