# SDS: 2026-07-27.pm.fair-readmission-closure-v3-minimal-native-fixture

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-minimal-native-fixture |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The retained-fd native race suite preserves required security evidence but its broad copied
workspace includes more than 5 GiB of unrelated material and cannot meet the fixed 120-second
gate after fresh reparse probes are restored. A five-member committee selected a minimal
physical fixture: actual collector execution, actual native probes and Git, and every native
race remain, while unrelated worktree bytes are excluded by an explicit parity contract.

## 2. Goals / Non-goals

- Goal: Keep physical missing-parent, junction, sibling, same-byte replacement, fd lifecycle,
  fresh-probe, and cleanup evidence while making the fixed gate reliably pass.
- Goal: Make fixture input/Git parity explicit and fail closed when a needed protected input is
  omitted.
- Non-goal: Add a production test mode/export/authority, mock a guard or Git, replace physical
  replacement with a core-only test, use reparse/hardlink shortcuts, or change capture roots.

## 3. Architecture Decisions

- **Decision**: Build a test-owned minimal workspace using ordinary byte-copied regular files:
  byte-identical collector/internal modules, every frozen source/config/fixture/evidence input
  actually required by manifest race capture, and no unrelated worktree/Git/build/log payload
  / basis: broad copy is the measured bottleneck while physical capture evidence remains required
  / trade-off: explicit fixture parity maintenance / rejected: persistent child protocol and
  broad-worktree copying.
- **Decision**: Initialize an independent fixture Git repository through the fixed native Git
  flow, retaining HEAD/status/index behavior and the ignored-untracked config-lock invariant
  / basis: protected Git provenance is part of normal capture / trade-off: fixture setup work
  / rejected: mocked Git or copying ambient `.git` metadata.
- **Decision**: Native `wx`/retained-fd same-byte replacement remains an isolated-child physical
  test against the fixture collector; internal-core tests supplement but never replace it
  / basis: SDS physical ordering evidence / rejected: core-only replacement proof.

## 4. Interfaces

- minimal fixture builder — test-only, creates only owned ordinary files/directories plus an
  independent Git repo and receives no production authority.
- copied collector — runs ordinary `captureFrozenProvenance({ workspaceRoot, manifestPath,
  phase })`; its collector/internal module bytes are verified against source.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a native-race fixture is built THE SYSTEM SHALL contain only verified regular
  fixture files, byte-identical collector/internal modules, every protected race input, and an
  independent Git HEAD/status/index; any missing or reparse input SHALL fail fixture parity or
  normal capture rather than silently fallback.
- SDS-AC-2: WHEN fixture capture executes THE SYSTEM SHALL use unchanged closed public capture,
  fixed Git, actual PowerShell fresh probes, and actual filesystem roles; it SHALL not use a
  mock guard/Git, public injection, test mode, reparse shortcut, or source rewrite.
- SDS-AC-3: WHEN physical retained-fd native races run THE SYSTEM SHALL preserve separate
  missing-parent success, docs-junction rejection without external mutation, sibling-only A/B
  acceptance, same-byte replacement safe-block/rejection, exact fd lifecycle, and owned cleanup
  evidence.
- SDS-AC-4: WHEN the fixed admission gate runs all closure suites THE SYSTEM SHALL retain exact
  discovery and all existing assertions and complete in each of three clean runs below 118
  seconds.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | Minimal fixture parity, regular files, independent Git. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | Real collector/Git/PowerShell and closed boundary. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | All physical native race transcripts and cleanup. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Three clean fixed-gate runs below 118 seconds. |

## 7. Open Questions

- The fixture is deliberately scoped to manifest-race evidence and cannot replace full default
  frozen lexical/default-capture evidence, which remains in the fixed gate.
