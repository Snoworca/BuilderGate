# SDS: Canary fixture liveness

| Field | Value |
| --- | --- |
| Document Type | sds |
| Task | 2026-07-24.pm.canary-fixture-liveness |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

`PERF-BGSTAB-010` server replay stops in the Canary test because its gated-write helper replaces a complete `HeadlessTerminalState` with a partial fake. Session finalization then throws before resolving the headless close signal and releasing CWD watchers. This step changes only the Canary test fixture and its tests; it is prerequisite infrastructure for later AC-7/AC-8 replay, not evidence that either AC is satisfied.

## 2. Goals / Non-goals

- Goal: retain every state member required by `disposeHeadlessTerminal` while gating terminal writes in Canary tests.
- Goal: make fixture-owned session cleanup observable and finite without leaving held write callbacks or watchers.
- Goal: add a genuine failing regression test before the fixture implementation changes.
- Non-goal: change `SessionManager`, `headlessTerminal`, protocol, scheduler, defaults, or runtime policy.
- Non-goal: check any `PERF-BGSTAB-010` AC or promote its status from this step.

## 3. Architecture Decisions

- **Decision**: wrap the existing terminal write behavior while retaining the complete actual `HeadlessTerminalState` / basis: finalization requires retained-metrics and cursor state / trade-off: fixture setup is less minimal / rejected: production null guards would hide an invalid test fixture.
- **Decision**: prove cleanup with a bounded test-local resource ledger, a same-path `fs.watchFile` sentinel, and explicit held-write release / basis: session-map deletion and file removal alone cannot show that `unwatchFile(path)` released the real watcher / trade-off: one bounded polling interval in fixture tests / rejected: Node internal handle inspection, production seams, or waiting for a runner timeout.
- **Decision**: create held writes by invoking the real `createSession` fake-PTY `onData` handler and bound every fixture chain wait / basis: direct terminal calls do not exercise `PTY onData -> headlessWriteChain`, and unbounded test cleanup hides the hang location / trade-off: test fixture exposes one captured data handler / rejected: native PTY processes or an unbounded `await` in cleanup.
- **Decision**: use two-stage test fixture cleanup: if normal public cleanup fails, release only fixture-owned gate, watcher, CWD file, original terminal, and session-map resources, then rethrow the original failure / basis: a failing test must still let the runner exit and report its original error / trade-off: explicit test-only fallback bookkeeping / rejected: swallowing cleanup failures or restoring the partial fake fixture.
- **Decision**: migrate Canary cases that exercise terminal-authority ordering or retained finalization from manual private-map `SessionData` construction to real `createSession` with an in-process fake PTY / basis: the manual builder drifted from required BigInt authority and retained-terminal initialization / trade-off: explicit fixture cleanup for real sessions / rejected: adding only the currently missing private fields and waiting for the next drift.
- **Decision**: keep this as a tdd-mode step under `PERF-BGSTAB-010` / basis: it restores verification infrastructure for its cleanup/fallback evidence / trade-off: post-hoc step promotion is separate from the parent requirement / rejected: a speculative new production SRS requirement.

## 4. Interfaces

- `enableGatedHeadlessWrites(session): GatedHeadlessWrites` — test-only helper; preserves the complete session headless state and controls only terminal write completion.
- `GatedHeadlessWrites.releaseNext(): boolean` — releases exactly one held fixture-owned write callback.
- `GatedHeadlessWrites.dispose(): void` — releases remaining held callbacks and restores or disposes only fixture-owned resources.
- `FixtureResourceLedger.assertReleased(): void` — test-only assertion that fixture-owned session cleanup, CWD file cleanup, and held callbacks have settled.
- `FixtureCwdWatchProbe.assertUnregistered(): Promise<void>` — test-only same-path sentinel that proves public finalization removed all watchers for the fixture CWD path within a bounded interval.
- `FixtureHeadlessChain.assertSettlesWithin(): Promise<void>` — test-only bounded assertion that reports the fixture phase and retained counters instead of leaving a test runner hung.
- `createGatedRealSessionFixture(...)` — test-only real-session factory using `createSession` and an in-process fake PTY; affected policy/finalizer cases seed only their required pending-output state after constructor initialization.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the Canary gated-write helper is applied to a session with a complete headless state, THE SYSTEM SHALL retain every state member that `disposeHeadlessTerminal` requires while intercepting only terminal write completion.
- SDS-AC-2: WHEN real fake-PTY `onData` creates a gated headless write, THE SYSTEM SHALL release the held callback, settle the corresponding headless write chain within the test bound, and complete public fixture cleanup without a disposal TypeError.
- SDS-AC-3: WHEN a Canary fixture test finishes through success, assertion-failure, or normal-public-cleanup-failure cleanup, THE SYSTEM SHALL observe no retained fixture session and prove that public finalization or test-only emergency cleanup removed all watchers for the fixture CWD path by a same-path sentinel within a bounded polling interval; emergency cleanup SHALL preserve the original normal cleanup error.
- SDS-AC-4: WHEN this correction is applied, THE SYSTEM SHALL leave production source, protocol contracts, and `PERF-BGSTAB-010` lifecycle/AC state unchanged.
- SDS-AC-5: WHEN a Canary policy or finalizer test exercises terminal-authority sequencing or retained-terminal cleanup, THE SYSTEM SHALL use a real `createSession` fixture with an in-process fake PTY rather than directly injecting a manually reconstructed `SessionData` into the private session map.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
| --- | --- | --- |
| SDS-AC-1 | `server/src/services/TerminalResourcePolicyCanary.test.ts` | Use real `createSession` with an in-process fake PTY, apply the helper, then assert public finalization succeeds. |
| SDS-AC-2 | `server/src/services/TerminalResourcePolicyCanary.test.ts` | Invoke the captured fake-PTY `onData`, hold the real session write chain, then prove bounded release before public finalization. |
| SDS-AC-3 | `server/src/services/TerminalResourcePolicyCanary.test.ts` | Use a test-local ledger and same-path `fs.watchFile` sentinel to prove sessions, callbacks, CWD files, and all CWD watchers are released in success, assertion-failure, and forced normal-cleanup-failure cleanup without swallowing the original error. |
| SDS-AC-4 | independent diff review | Verify the completed diff changes only the Canary test fixture and test evidence, never production behavior or the parent requirement lifecycle. |
| SDS-AC-5 | `server/src/services/TerminalResourcePolicyCanary.test.ts` | Migrate the six affected authority and same-ID-finalizer cases to the real-session fixture and verify that no BigInt-mixing or missing retained-terminal property error remains. |

## 7. Open Questions

- (none; the three-member readiness committee unanimously authorized this fixture-only scope on 2026-07-24.)
