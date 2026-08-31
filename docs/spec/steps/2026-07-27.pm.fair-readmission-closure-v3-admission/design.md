# SDS: 2026-07-27.pm.fair-readmission-closure-v3-admission

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-admission |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Final boundary review found that duck-typed/no-op guards and absent guards can still admit
lstat-only protected rows, a custom probe can receive an oversized singleton, admitted
parsing silently omits real literal dynamic/type imports, and the timing gate excludes the
boundary suite. This successor remains within the offline collector boundary.

## 2. Goals / Non-goals

- Goal: Require a module-minted strict admission capability for every protected public
  read/hash/closure operation; no duck-typed or lstat-only fallback may admit a row.
- Goal: Parse admitted contained literal static, type, and dynamic imports completely;
  unsupported/nonliteral forms fail closed rather than silently disappearing.
- Goal: Reject oversized singleton batches before a custom probe and run one fixed
  nonrecursive gate covering all functional closure suites.
- Non-goal: General package/alias/host filesystem resolution or exposing private capability.

## 3. Architecture Decisions

- **Decision**: Mint a module-private branded strict admission capability only when the
  fixed batch guard/snapshot factory succeeds; exported ingress requires it / basis:
  shape checks accept no-op/counterfeit guards / trade-off: explicit safe factory use /
  rejected: optional or structural guard parameters.
- **Decision**: Reject an over-count/over-byte singleton in `splitReparseBatches` before a
  probe; parse only contained literal static/type/dynamic specifiers from admitted bytes /
  basis: custom paths must not bypass caps and real roots use these forms / trade-off:
  nonliteral/unsupported syntax fails capture / rejected: silent omission and host fallback.
- **Decision**: Replace the nine-file gate with one nonrecursive fixed gate covering every
  functional suite but excluding only itself / basis: a gate must cover its contracts /
  trade-off: bounded extra child test time / rejected: diagnostic/exclusion gate.

## 4. Interfaces

- safe collector factory — returns branded admission context; caller guard/snapshot cannot
  substitute for it.
- public protected-read/hash/closure APIs — require branded context before fs work.
- admitted parser — returns contained literal static/type/dynamic specifiers or throws.
- combined gate — runs fixed functional list under 120 seconds without self recursion.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a public protected read/hash/closure operation is called without the
  module-minted strict admission context or with a counterfeit/no-op object THE SYSTEM
  SHALL reject before stat, read, hash, probe, or cache admission.
- SDS-AC-2: WHEN a batch singleton exceeds count/byte limits THE SYSTEM SHALL reject before
  any custom probe; cache cleanup remains fail-closed on errors.
- SDS-AC-3: WHEN admitted source bytes contain a contained literal static, type, or dynamic
  relative import THE SYSTEM SHALL include it in later guarded discovery; nonliteral,
  outside-root, or unsupported forms SHALL fail capture instead of being omitted.
- SDS-AC-4: WHEN the combined functional closure gate runs THE SYSTEM SHALL include boundary
  and admission suites, exclude only itself, fail on timeout/nonzero, and finish <120s.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.admission.test.mjs | Missing/no-op/counterfeit context causes zero filesystem/probe work. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.admission.test.mjs | 8KiB+ singleton invokes no injected probe and failure clears cache. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.admission.test.mjs | Inventory dynamic/type imports enter closure; nonliteral rejects. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Fixed combined gate covers functional suites with timeout/evidence. |

## 7. Open Questions

- The private capability prevents ordinary public callers from choosing unintended
  lstat-only ingress; it is not a defense against hostile same-process module mutation.
