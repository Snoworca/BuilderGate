# SDS: closure-v3 probe hardening

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-probe-hardening |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Independent batch review found unobserved successful-process stderr, fixture drive-path
escape, environment-selected PowerShell execution, and stale config hashing. This step
hardens the provenance collector on the current C: Windows environment; it does not
expand runtime, browser, or external-output responsibilities.

## 2. Goals / Non-goals

- Goal: Capture process status, stdout, and stderr so any stderr fails the batch protocol.
- Goal: Run only a verified fixed `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
  with no environment-variable executable selection.
- Goal: Reject volume-qualified/escaped fixture paths and revalidate config-lock paths
  immediately before hashing.
- Non-goal: Support nonstandard Windows system roots, invoke a shell, or add a native addon.
- Non-goal: Make hostile administrator/system-directory replacement a supported threat model.

## 3. Architecture Decisions

- **Decision**: Use `spawnSync` for production batch launches and require status 0, empty
  stderr, and byte-exact stdout / basis: `execFileSync` hides successful stderr /
  trade-off: explicit result handling / rejected: stdout-only acceptance.
- **Decision**: Resolve only the literal C: Windows PowerShell candidate and verify regular
  file, non-link ancestors, and normalized `realpath.native` equality / basis: 3-person
  committee prevents environment binary hijack / trade-off: nonstandard Windows fails /
  rejected: SystemRoot/WINDIR/PATH/ComSpec selection or validation.
- **Decision**: Fixture values must be relative non-volume path segments and their resolved
  absolute path must remain under the evidence root / basis: string prefix checks are not a
  Windows containment proof / trade-off: stricter malformed-fixture rejection /
  rejected: concatenating drive-qualified values.

## 4. Interfaces

- `resolveTrustedWindowsPowerShell({ fs, platform })` — returns only the fixed verified
  literal executable or throws before child launch.
- `probeWindowsReparsePoints({ paths, spawnSync })` — verifies status/stdout/stderr under
  the fixed batch protocol.
- `resolveFixturePath(...)` — accepts only a normalized evidence-root descendant.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a batch child exits 0 with any stderr, malformed/extra stdout, or missing
  status THE SYSTEM SHALL fail closed and cache no safe result.
- SDS-AC-2: WHEN launching a Windows probe THE SYSTEM SHALL use only the fixed verified C:
  executable regardless of SystemRoot, WINDIR, PATH, or ComSpec values; untrusted/missing/
  reparse/realpath-divergent candidates SHALL fail before launch.
- SDS-AC-3: WHEN fixture metadata contains a drive-qualified, volume-qualified, absolute,
  or escaping value THE SYSTEM SHALL fail before any outside-root read or hash.
- SDS-AC-4: WHEN a config-lock row is hashed THE SYSTEM SHALL force-fresh revalidate its
  path identity/link state immediately before the read and fail closed on a change.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.hardening.test.mjs | Success+stderr and exact process protocol |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.hardening.test.mjs | Poisoned env and executable trust failures |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.hardening.test.mjs | Drive/volume/escape fixture rejection |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.hardening.test.mjs | Config identity change before hash |

## 7. Open Questions

- The fixed C: executable policy was unanimously approved by a three-person committee on
  2026-07-27. A nonstandard-system-root resolver requires a separate Windows API design.
