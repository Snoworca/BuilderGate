# SDS: 2026-07-27.pm.fair-readmission-closure-v3-internal-core-callbacks

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-internal-core-callbacks |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The prior internal-core SDS left the wave execution port ambiguous. A five-member escalation
selected fixed opaque-ticket callbacks by 3:2: only that shape can deterministically prove
pre/read/post ordering and a complete fresh retry while keeping filesystem paths, native
capabilities, and public capture inputs private. This successor restores temporal provenance
contracts without reintroducing public protected-I/O seams.

## 2. Goals / Non-goals

- Goal: Restore deterministic wave transaction, cache, retry, role, and native-worker evidence.
- Goal: Keep `captureFrozenProvenance` closed to its existing three public fields.
- Non-goal: Accept caller callbacks, paths, filesystem, guard, snapshot, writer, admission,
  test mode, expanded roots, or a new public collector export.

## 3. Architecture Decisions

- **Decision**: Use two narrow implementation-only APIs: an opaque-ticket wave cache with the
  fixed `beginWave`, `readTicket`, `finishWave`, and `digestBytes` port, and a pure manifest
  write-state evaluator / basis: opaque tickets allow direct temporal order/retry tests while
  retaining native authority in a private adapter closure / trade-off: fixed port discipline
  and a small adapter / rejected: generic workflow callbacks, a staged-data-only reducer, public
  injection, test mode, and native-only race synthesis.
- **Decision**: Opaque ticket records carry only deterministic non-path identity and byte-budget
  metadata. The internal core never receives a filesystem, path, workspace root, destination,
  capability, guard, manifest bytes, or public capture option; only the collector's private
  adapter owns ticket-to-path mapping and native effects / basis: preserve closed admission
  / trade-off: adapter controls physical lookup / rejected: exported authority-shaped seams.
- **Decision**: The wave cache is the sole transaction implementation: canonical ticket order
  and deduplication, fixed 64/8 KiB planning, begin→read-all→finish ordering, provisional
  bytes/digests, atomic commit, complete fresh retry, and defensive copies. The manifest
  evaluator is the sole role/state policy, while the private adapter performs actual lstat,
  guard, mkdir, wx, and postflight / basis: prevent core/adapter drift / rejected: final-row-only
  assertions or parallel legacy state logic.

## 4. Interfaces

- `createOpaqueWaveCache({ beginWave, readTicket, finishWave, digestBytes })` — internal-only;
  fixed opaque-ticket transaction port, no authority-bearing input or returned capability.
- `evaluateManifestWriteState(state)` — internal-only pure role/identity/stage decision; no
  filesystem, path, writer, guard, or serialized manifest input.
- private native adapter — maps real paths to opaque tickets, invokes the two APIs, and remains
  reachable only through the existing capture entry point.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN callers provide any filesystem, reparse guard, snapshot, writer, admission,
  callback, test-mode, or unsupported capture option THE SYSTEM SHALL reject before protected
  I/O; the collector SHALL not export protected-I/O or authority-minting seams, nor re-export
  the implementation-only core.
- SDS-AC-2: WHEN unordered or duplicate opaque tickets are requested THE SYSTEM SHALL form
  canonical deduplicated waves bounded to 64 tickets or 8 KiB; WHEN a read or finish fails THE
  SYSTEM SHALL atomically publish no row/cache and a later retry SHALL call a fresh begin/read
  cycle for every miss; WHEN a cache hit succeeds THE SYSTEM SHALL invoke no port callback and
  return a defensive byte copy.
- SDS-AC-3: WHEN supplied manifest state contains allowed parent/leaf roles THE SYSTEM SHALL
  require exactly the documented ensure-parent→preflight→exclusive-write→postflight transition;
  WHEN it contains directory, special, link, reparse, structural identity, or invalid leaf state
  THE SYSTEM SHALL reject before any native write/probe callback. Permitted sibling timestamp-only
  churn SHALL not invalidate an otherwise safe transaction.
- SDS-AC-4: WHEN native Workers use the capture barrier THE SYSTEM SHALL await two ready messages
  before release, surface every error, use distinct leaves, and perform creator-owned cleanup;
  all fixed admission suites including lexical, seal, internal-core, temporal, role, and Worker
  tests SHALL pass in a single gate under 120 seconds.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Closed collector boundary and no-authority dependency shape. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Opaque ticket ordering, batches, atomic retry/cache, defensive copy. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Pure role/state matrix and private adapter transition evidence. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | Ready-message barrier, sibling churn, cleanup, exhaustive gate. |

## 7. Open Questions

- The core is directly importable only by repository tests and the collector via a relative
  internal path. It is never a public capture API and cannot construct or receive native authority.
