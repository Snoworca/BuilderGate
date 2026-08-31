# SDS: 2026-07-27.pm.fair-readmission-closure-v3-manifest-race

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-manifest-race |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Two safe captures writing distinct `wx` leaves change their shared analysis directory's
mtime/ctime, causing the full identity guard to reject both. A unanimous committee chose
role-aware identity comparison: directories retain structural identity and reparse checks;
regular leaves retain full identity. Scope is collector-only parallel manifest admission.

## 2. Goals / Non-goals

- Goal: Allow different manifest leaves to be captured concurrently without weakening
  directory replacement/reparse or file-leaf mutation detection.
- Non-goal: Locks, serial capture, or a claim of hostile kernel-time parent-swap immunity.

## 3. Architecture Decisions

- **Decision**: Compare directory segments by `dev`, `ino`, `mode`, and directory type,
  while retaining lstat/reparse checks each time; compare regular file leaves by full
  identity including ctime/mtime/size / basis: sibling `wx` creates benign directory time
  churn but not path authority change / trade-off: role-aware comparator / rejected: lock
  serialization and false-fail.

## 4. Interfaces

- role-aware guard identity — directory stable comparator; file full comparator.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN concurrent captures create distinct manifest leaves in one analysis
  directory THE SYSTEM SHALL admit both if all segment structural/reparse and leaf checks
  succeed.
- SDS-AC-2: WHEN a directory dev/ino/mode/type or reparse state changes, or a file leaf
  full identity changes, THE SYSTEM SHALL fail closed and emit no accepted manifest.
- SDS-AC-3: WHEN both normal and concurrent functional closure gates run THE SYSTEM SHALL
  pass within the existing 120-second budget without test serialization.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs | Different leaves tolerate only directory mtime/ctime churn. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs | Directory structural/reparse and leaf identity changes reject. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs | Parallel outer functional suite regression remains under 120 seconds. |

## 7. Open Questions

- Strong no-follow kernel-time write guarantees require a separate native/Win32-handle design.
