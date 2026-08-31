# SDS: closure-v3 Windows reparse hardening

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-reparse |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Node v24 exposes `Stats.isSymbolicLink()` but not `Stats.isReparsePoint()`, leaving
junction and non-symlink reparse safety unproven. The collector runs on this Windows
workspace, so it needs an actual Windows attribute probe before reading or writing a
protected path. This step also prevents its test helper from deleting pre-existing data.

## 2. Goals / Non-goals

- Goal: Reject all existing protected/output/manifest path segments carrying the Windows
  `FileAttributes.ReparsePoint` bit, and fail closed on probe errors.
- Goal: Use a fixed shell-free PowerShell protocol without interpolating a candidate path.
- Goal: Ensure failed test assertions remove only a manifest leaf created by that test.
- Non-goal: Add Playwright execution, external-output creation/cleanup, or a native addon.
- Non-goal: Claim full hostile-TOCTOU resistance beyond pre-write and post-write checks.

## 3. Architecture Decisions

- **Decision**: Invoke the absolute Windows PowerShell 5.1 executable with a fixed
  UTF-16LE Base64 `-EncodedCommand`; pass the candidate path only as Base64 child-env /
  basis: .NET `File.GetAttributes()` reports numeric ReparsePoint bit 0x400 without
  locale parsing / trade-off: a bounded child probe per existing segment / rejected:
  Node `isSymbolicLink` alone, `fsutil` output parsing, and a native addon.
- **Decision**: Accept only ASCII `0` from the probe; `1`, process failure, timeout,
  missing SystemRoot, malformed output, unsupported path, or inaccessible segment fails
  closed / basis: provenance must never silently downgrade its path guard / trade-off:
  more conservative capture failures / rejected: best-effort probe fallback.

## 4. Interfaces

- `probeWindowsReparsePoint({ path, execFileSync, env })` — checks one existing absolute
  Windows segment through the fixed PowerShell protocol and returns only a boolean or
  throws a fail-closed error.
- `assertPathHasNoLinkOrReparsePoint(fs, absolutePath, label)` — retains link checks and
  calls the Windows probe for every existing segment before a collector read/write.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a protected, output, or manifest path has an existing Windows segment
  THE SYSTEM SHALL reject `FileAttributes.ReparsePoint` even when `isSymbolicLink()` is
  false, before reading or writing a manifest.
- SDS-AC-2: WHEN the reparse probe is invoked THE SYSTEM SHALL use shell-free fixed
  encoded PowerShell arguments and a Base64 environment path, and SHALL accept only a
  single `0` success result.
- SDS-AC-3: WHEN the probe cannot establish absence of a reparse point THE SYSTEM SHALL
  fail closed; the collector must not fall back to `isSymbolicLink()` alone.
- SDS-AC-4: WHEN the test capture helper finds a pre-existing manifest leaf THE SYSTEM
  SHALL preserve it and shall only delete a leaf after its own absence precondition has
  succeeded.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Reparse-only and normal segment outcomes |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Fixed encoded-command and Base64-env invocation |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Probe error, malformed result, and missing executable fail closed |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.remediation.test.mjs | Existing helper leaf preservation |

## 7. Open Questions

- The committee accepted this Windows-specific PowerShell probe on 2026-07-27. A native
  handle implementation is only needed if hostile TOCTOU resistance becomes in scope.
