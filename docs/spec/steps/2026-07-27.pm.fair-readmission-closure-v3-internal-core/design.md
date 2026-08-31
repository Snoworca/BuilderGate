# SDS: 2026-07-27.pm.fair-readmission-closure-v3-internal-core

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-internal-core |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The lexical successor made protected admission and I/O private, but the attempted test
migration removed snapshot/wave temporal guarantees. A five-member decision committee
selected a no-I/O internal deterministic core with a sole private native adapter. This
step restores those guarantees without reopening caller-supplied filesystem, guard,
snapshot, writer, or admission authority.

## 2. Goals / Non-goals

- Goal: Preserve atomic snapshot-wave, bounded-frontier, retry/cache, role, and manifest
  transaction behavior as deterministic contracts.
- Goal: Retain a closed three-field public capture API and native black-box Worker/Git tests.
- Non-goal: Export protected I/O, add a test mode, mock native authority, alter frozen roots,
  or change the lexical successor contract.

## 3. Architecture Decisions

- **Decision**: Extract only authority-free state transitions into an implementation-only
  internal module; the collector's private native adapter remains the sole owner of node
  filesystem, reparse guard, protected snapshot, Git, workspace path resolution, and manifest
  write authority / basis: it restores lost deterministic temporal tests without reopening a
  protected-I/O seam / trade-off: a small module boundary and adapter wiring / rejected:
  public test hooks, injected filesystem/guard/writer, environment test mode, and an OS-only
  race harness.
- **Decision**: The internal core receives ordered descriptors, immutable identities, and
  narrow callback results only; it imports neither filesystem nor child-process APIs and never
  mints an admission capability / basis: direct tests remain non-authoritative / trade-off:
  native effects remain black-box tested / rejected: a second capture API.
- **Decision**: Preserve exact bounded wave planning (64 entries or 8 KiB), pre/read/post
  transaction checks, atomic provisional commit, full retry after failed wave, defensive byte
  copies, role classification, and manifest state ordering / basis: they are existing temporal
  integrity contracts, not obsolete public seams / trade-off: broader RED matrix / rejected:
  final-manifest-only assertions.

## 4. Interfaces

- internal wave core — accepts no path, filesystem, capability, or public capture option;
  decides canonical bounded waves, provisional commit/retry/cache transitions only.
- internal manifest core — classifies supplied metadata and validates ordered write-state
  transitions only; it performs no native inspection or write.
- private native adapter — supplies native observations/effects to the cores and is reached
  only by `captureFrozenProvenance({ workspaceRoot, manifestPath, phase })`.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN any caller supplies filesystem, reparse guard, snapshot, writer, admission,
  test-mode, or unsupported capture input THE SYSTEM SHALL reject before protected I/O, while
  the public collector continues to expose no protected-I/O or authority-minting seam.
- SDS-AC-2: WHEN a deterministic wave has duplicate or unordered requests THE SYSTEM SHALL
  plan canonical deduplicated batches bounded by 64 requests and 8 KiB; WHEN any pre/read/post
  observation fails THE SYSTEM SHALL commit no provisional row/cache and retry the entire wave
  fresh; WHEN successful bytes enter cache THE SYSTEM SHALL retain defensive copies.
- SDS-AC-3: WHEN native role metadata denotes absent, regular, directory, special, link, or
  reparse entries THE SYSTEM SHALL permit only the documented role at each manifest state;
  special/link/reparse and structural identity changes SHALL fail before probe/write, whereas
  permitted sibling timestamp-only churn SHALL not invalidate an otherwise safe transaction.
- SDS-AC-4: WHEN two native Workers reach a ready-message barrier THE SYSTEM SHALL wait for
  both ready messages before release, create distinct owned leaves, surface worker errors, and
  permit creator-owned cleanup; the exhaustive fixed admission gate including lexical, seal,
  internal-core, and native suites SHALL pass within 120 seconds.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Closed public boundary and no-authority core imports. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Wave plan, transaction, retry, cache, defensive copy. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Role classifier and ordered manifest transition. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | Native Worker ready/release/errors/cleanup and full gate. |

## 7. Open Questions

- The internal module is implementation-only by path and dependency shape; its direct tests
  must prove it cannot import or construct native authority.
