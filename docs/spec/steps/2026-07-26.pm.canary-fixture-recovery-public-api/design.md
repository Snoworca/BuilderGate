# SDS: Canary fixture recovery through public APIs

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.canary-fixture-recovery-public-api |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

This SDS supersedes `2026-07-26.pm.canary-fixture-recovery`: its internal
SessionData object-identity contract cannot be observed through public APIs.
This step starts a new test-only harness from RED and proves only public DTO
identity and deletion behavior. It leaves the existing untracked Canary
monolith untouched and cannot verify a parent PERF acceptance criterion.

## 2. Goals / Non-goals

- Goal: create a focused test-only fixture through public
  `SessionManager.createSession`, `getSession`, and `deleteSession` only.
- Goal: observe one fake-PTY spawn and `onData` registration without inspecting
  or modifying private SessionManager state.
- Goal: preserve a new module-absence RED and a test-first commit before Green.
- Non-goal: access `sessions`, override `isCommandAvailable`, alter production
  source, or modify/import/extract the existing untracked Canary monolith.
- Non-goal: alter `PERF-BGSTAB-010` lifecycle, ACs, Verification Evidence, or
  trace links, or use this support work as browser AC-9 or admission evidence.

## 3. Architecture Decisions

- **Decision**: expose only public DTO IDs from the fixture / basis: public
  `SessionManager` APIs do not expose internal SessionData object identity /
  trade-off: this test cannot assert internal retained/headless maps /
  rejected: private-map casts, private availability overrides, or a production
  test seam.
- **Decision**: construct the fake-PTY fixture with public `platform: 'win32'`
  and `shell: 'powershell'` inputs / basis: this selects the public deterministic
  PowerShell resolution path without probing or overriding command availability /
  trade-off: the fake process models no real shell execution /
  rejected: a private `isCommandAvailable` override or a host-dependent shell.
- **Decision**: add a new public-fixture module and focused test rather than
  reuse the superseded harness / basis: the previous RED and contracts prove a
  different internal-identity requirement /
  trade-off: small isolated test-support duplication /
  rejected: retroactively editing the prior SDS or calling its evidence Green.

## 4. Interfaces

- `createPublicObservedSessionFixture(input): PublicObservedSessionFixture` —
  test-only factory that uses public `SessionManager` methods and deterministic
  fake-PTY observation only.
- `PublicObservedSessionFixture.dispose(): boolean` — public deletion result;
  it rejects if the public session remains visible or a fixture-owned callback
  is still active.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the focused public-fixture test imports its planned module
  before that module exists, THE TEST RUNNER SHALL exit non-zero with a
  module-resolution error.
- SDS-AC-2: WHEN the public fixture is created, THE SYSTEM SHALL call public
  `createSession` exactly once and the fake PTY SHALL observe exactly one spawn
  and one `onData` registration.
- SDS-AC-3: WHEN the public fixture is created, THE SYSTEM SHALL return a
  `createSession` DTO and `getSession(created.id)` SHALL return a DTO with the
  same `id`; no internal object identity or private map observation is allowed.
- SDS-AC-4: WHEN the public fixture is disposed, THE SYSTEM SHALL return a
  successful public `deleteSession` result, make `getSession(created.id)` return
  `null`, and release every fixture-owned fake-PTY data callback.
- SDS-AC-5: WHEN this superseding fixture is added, THE SYSTEM SHALL leave the
  superseded fixture path, the untracked Canary monolith, all production entry
  imports, and parent `PERF-BGSTAB-010` lifecycle rows unchanged.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | `server/src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` | Preserve the initial absent-module, non-zero RED result. |
| SDS-AC-2 | `server/src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` | Assert one public create, one fake spawn, and one `onData` registration. |
| SDS-AC-3 | `server/src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` | Assert only matching public DTO IDs and forbid internal identity assertions. |
| SDS-AC-4 | `server/src/services/TerminalResourcePolicyCanaryPublicFixture.test.ts` | Assert public delete, `getSession` absence, and callback release. |
| SDS-AC-5 | independent diff/import audit | Confirm private-internal references are absent; old monolith hash/status and parent lifecycle rows are unchanged. |

## 7. Open Questions

- The superseded SDS-AC-3 required a SessionData object identity and its prior
  RED cannot prove this public-DTO contract. It is retired rather than weakened.
- (none; the three-member decision committee unanimously approved supersession
  and this public-API design on 2026-07-26.)
