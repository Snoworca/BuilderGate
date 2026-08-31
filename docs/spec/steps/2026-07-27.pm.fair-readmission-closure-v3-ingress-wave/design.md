# SDS: 2026-07-27.pm.fair-readmission-closure-v3-ingress-wave

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-ingress-wave |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The per-path capture-local snapshot preserves guarded-read semantics but still starts two
PowerShell children for every unique source path; full regression timed out after 184
seconds. A unanimous committee selected bounded discovery waves. Each wave validates a
complete deterministic contained frontier before and after private reads, and admits
nothing until every member passes. This changes only the offline provenance collector.

## 2. Goals / Non-goals

- Goal: Reduce strict PowerShell launches from per-path to bounded full-frontier wave
  batches while keeping fail-closed provenance admission.
- Goal: Admit bytes, digests, cache rows, parse outputs, and next-wave discovery only
  after a wave-wide initial/post identity comparison succeeds.
- Goal: Complete the focused full closure-v3 regression within 120 seconds.
- Non-goal: A long-lived PowerShell worker, global cache, runtime/browser behavior, or
  external evidence-output lifecycle change.
- Non-goal: Atomic whole-capture filesystem snapshots; failure of any wave aborts capture.

## 3. Architecture Decisions

- **Decision**: Resolve contained cache-miss paths in deterministic discovery waves; store
  the complete initial frontier identity vector, batch-probe it, read each leaf once into
  private provisional bytes, then batch-probe/recheck the identical frontier before one
  all-or-nothing admission / basis: per-path children timed out while global bracketing
  weakens read timing / trade-off: explicit provisional wave state / rejected: per-path
  spawning, global pre/post, and persistent worker protocol.
- **Decision**: Parse imports/fixture/config-derived paths only from admitted bytes and
  schedule them for a later wave / basis: unverified provisional content must never steer
  further reads / trade-off: breadth-first discovery plumbing / rejected: parse-before-post
  or same-wave dynamically discovered reads.
- **Decision**: Preserve fixed-executable batch protocol, empty-stderr/exact-stdout,
  batch caps, case-preserving canonical keys, containment, and defensive copies / basis:
  performance cannot create a less trusted ingress path / trade-off: bounded batching /
  rejected: test-only or compatibility bypasses.

## 4. Interfaces

- `snapshot.readWave(requests)` — accepts contained canonical cache-miss requests,
  validates and reads them as one provisional wave, and publishes all results only after
  wave-wide post identity equality.
- `snapshot.read(request)` — delegates a single request through the same wave contract;
  cache hits perform no filesystem operation.
- Source/config/fixture discovery — consumes only published snapshot results and enqueues
  resolved dependencies into a later deterministic wave.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a wave has one or more cache-miss contained paths THE SYSTEM SHALL
  deterministically deduplicate them, validate/batch-probe the complete existing
  ancestor/leaf frontier, read each leaf exactly once privately, and batch-probe/recheck
  the same frontier before admitting any result.
- SDS-AC-2: WHEN any wave member is missing, linked/reparse, read-invalid, probe-invalid,
  or identity-different between initial and post vectors THE SYSTEM SHALL discard the
  entire wave's provisional bytes/digests/cache/parser output, enqueue no next wave, and
  fail capture without manifest output.
- SDS-AC-3: WHEN source, config, or fixture bytes discover an additional contained input
  THE SYSTEM SHALL parse only admitted bytes and SHALL schedule that input for a later
  wave; cache hits SHALL perform zero filesystem/probe work and return defensive copies.
- SDS-AC-4: WHEN the full frozen closure-v3 focused Node regression runs THE SYSTEM SHALL
  preserve strict batch protocol/containment behavior and finish all eight test files in
  less than 120 seconds.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.wave.test.mjs | Wave pre/read/post ordering, deterministic dedup, one read/path, and batch-count bounds. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.wave.test.mjs | A changed/reparse member discards all provisional state and parser/discovery output. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.wave.test.mjs | Dynamic imports enter later waves; hits use defensive snapshots with zero I/O. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.wave.test.mjs | Full eight-file regression uses explicit 120-second timeout and passes. |

## 7. Open Questions

- If bounded waves cannot meet the stated regression limit, a persistent worker requires a
  separate security/lifecycle SDS and committee decision; it is not an implicit fallback.
