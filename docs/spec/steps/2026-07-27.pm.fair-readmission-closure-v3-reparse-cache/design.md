# SDS: closure-v3 Windows reparse probe cache

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-reparse-cache |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The agreed Windows attribute probe is correct but a fresh PowerShell process for every
repeated ancestor makes a full provenance capture time out. This step preserves
fail-closed semantics with a bounded per-capture identity-validated cache. It supersedes
the prior reparse SDS before any reparse production implementation is committed.

## 2. Goals / Non-goals

- Goal: Probe each unique existing segment identity at most once in a capture's ordinary
  reads, while every cache hit receives a fresh `lstat` identity comparison.
- Goal: Force a fresh Windows attribute probe at manifest and output validation boundaries
  before side effects and again after manifest write.
- Goal: Keep PowerShell errors, absent paths, links, reparse results, and identity changes
  out of the cache and fail closed where a segment is required to exist.
- Non-goal: Persist results across captures, case-fold keys, or provide full hostile TOCTOU
  resistance.
- Non-goal: Run Playwright, create/delete external output, or add a native dependency.

## 3. Architecture Decisions

- **Decision**: Use a new Map per `captureFrozenProvenance()` with a case-preserving,
  absolute slash-normalized path key / basis: 5-person majority avoids false merges in
  per-directory case-sensitive Windows folders / trade-off: benign duplicate probes /
  rejected: lowercase and persistent caches.
- **Decision**: Cache only a fresh-lstat identity plus successful PowerShell `0`; every hit
  lstat-compares `{dev, ino, mode, ctimeMs, mtimeMs, size}` when available / basis:
  reparse or identity changes must re-probe / trade-off: bounded lstat cost / rejected:
  trusting a string-key cache.
- **Decision**: Bypass the cache at manifest/output side-effect boundaries before and after
  write / basis: minimize the acknowledged TOCTOU window / trade-off: several extra probes
  / rejected: treating a read-time probe as a write-time guard.

## 4. Interfaces

- `probeWindowsReparsePoint({ path, execFileSync, env })` — fixed shell-free PowerShell
  `FileAttributes.ReparsePoint` probe; only exact `0` is safe.
- `createSegmentReparseGuard({ fs, probe })` — creates one capture-local guard with
  ordinary and `forceFresh` validation modes; no cache state is global.
- `captureFrozenProvenance(...)` — constructs a new guard per call and forces validation
  around manifest/output boundaries.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN an ordinary capture revisits an unchanged existing segment THE SYSTEM
  SHALL fresh-lstat it and reuse only its same-capture successful `0` probe result.
- SDS-AC-2: WHEN a segment identity changes, becomes a link/reparse, is absent where
  required, or its probe is not exact `0` THE SYSTEM SHALL discard any cached result and
  fail closed or re-probe as the boundary requires.
- SDS-AC-3: WHEN a manifest/output side-effect boundary is reached THE SYSTEM SHALL bypass
  the cache and fresh-probe all existing relevant segments before and after manifest write.
- SDS-AC-4: WHEN a new capture starts THE SYSTEM SHALL not reuse any previous capture's
  cache; keys SHALL preserve path casing after absolute slash normalization.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Same identity lstat cache hit probes once |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Identity change/reparse/error reject and no unsafe cache |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | forceFresh probes again at a boundary |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Separate guard maps and case-preserving keys |

## 7. Open Questions

- The 2026-07-27 committee unanimously approved a per-capture cache; 5-person majority
  selected case-preserving keys. Full hostile TOCTOU resistance needs a separate native
  handle design and remains out of scope.
