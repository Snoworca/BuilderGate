# SDS: 2026-07-27.pm.fair-readmission-closure-v3-probe-strict

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-probe-strict |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Independent contract, safety, and TDD reviews rejected the prior hardening step: its
exported `execFileSync` compatibility branches still selected `SystemRoot` and could not
observe successful-process stderr. They also found leaf-only reparse validation, a
config guard/read race, and Windows-special fixture paths. This successor changes only
the offline provenance collector and its focused Node tests; it does not run Playwright,
write an external evidence output, or alter runtime/browser behavior.

## 2. Goals / Non-goals

- Goal: Make every exported Windows reparse probe use one strict injected-or-real
  `spawnSync` protocol with the fixed verified C: PowerShell executable.
- Goal: Validate complete existing path segment frontiers and reject unsafe Windows
  fixture components; detect config identity changes around hash reads.
- Non-goal: Support non-C: Windows roots, shell execution, native addons, or a
  hostile administrator replacing the Windows system directory.
- Non-goal: Modify runtime scheduler, browser, Playwright, or external output lifecycle.

## 3. Architecture Decisions

- **Decision**: Remove the exported `execFileSync` fallback and migrate all probe tests
  to injected `spawnSync` result objects / basis: `execFileSync` cannot observe a
  successful child stderr and its environment-selected executable violates the frozen
  trust boundary / trade-off: focused test-double migration / rejected: compatibility
  adapter or test-only convention.
- **Decision**: Batch-probe every existing ancestor and leaf path segment, and use a
  force-fresh guard before and after config byte reads / basis: leaf-only `lstat` misses
  ancestor junctions and a pre-read check alone cannot observe a change during the read /
  trade-off: bounded batch work and a second identity check / rejected: Node
  `Stats.isReparsePoint` reliance or a one-shot leaf check.
- **Decision**: Accept fixture values only as strict ordinary relative Windows path
  components under the fixed evidence root / basis: drive-relative paths, ADS, device
  aliases, and trailing-dot/space forms defeat plain prefix containment / trade-off:
  malformed legacy fixture values fail closed / rejected: colon-only leading-drive checks.

## 4. Interfaces

- `probeWindowsReparsePoints({ paths, spawnSync, fs, platform })` — validates the fixed
  executable and accepts only status `0`, empty stderr, and byte-exact batch stdout.
- `probeWindowsReparsePoint({ path, spawnSync, fs, platform })` — delegates to the same
  strict executor and accepts only the exact one-path protocol record.
- `createSegmentReparseGuard(...)` — protects the complete existing ancestor/leaf
  frontier, caches identities only after batch success, and force-fresh rechecks on demand.
- `hashConfigLockFile(...)` — guards full segments immediately before and after reading;
  returns no digest if either identity check fails.
- `resolveFixturePath(...)` — returns only a normal evidence-root descendant whose every
  component is a safe Windows filename.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN any exported Windows probe is called with a poisoned environment,
  `execFileSync`, a child error/nonzero/missing status/nonempty stderr, or malformed/extra
  stdout THE SYSTEM SHALL use no legacy branch and SHALL fail closed before a safe result
  is cached.
- SDS-AC-2: WHEN a protected source, fixture, config, executable, or manifest path has an
  existing ancestor or leaf reparse/link, or its identity changes during a force-fresh
  validation THE SYSTEM SHALL batch-probe that segment frontier and SHALL fail closed.
- SDS-AC-3: WHEN a config-lock file is hashed THE SYSTEM SHALL force-fresh validate every
  existing path segment immediately before its byte read and again before returning a
  digest; an identity/reparse change SHALL produce no hash row.
- SDS-AC-4: WHEN fixture metadata has an absolute, UNC, drive/volume-qualified,
  escaping, ADS, reserved-device, trailing-dot, or trailing-space component THE SYSTEM
  SHALL reject it before an outside-root read or hash; ordinary descendants SHALL resolve
  exactly under the fixed evidence root.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.strict.test.mjs | Legacy fallback absent; poisoned env and child result failures cannot admit a probe. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.strict.test.mjs | Full ancestor frontier is batched and cache is not admitted on failures or identity change. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.strict.test.mjs | Config hash has force-fresh pre/post segment validation around the byte read. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.strict.test.mjs | Drive, UNC, ADS, devices, trailing forms, and escape reject; safe path resolves. |

## 7. Open Questions

- The fixed-C: policy intentionally does not support nonstandard Windows roots. A future
  resolver would require a separate trusted OS API design and decision.
