# SDS: 2026-07-27.pm.fair-readmission-closure-v3-trust

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-trust |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Final independent review found protected ingress can omit the admission key, a caller can
mint context with a no-op probe, an ignored TypeScript runtime executes before provenance
admission, special filesystem leaves are accepted, and the manifest-race test is not truly
concurrent. This successor closes those collector-only trust gaps without runtime/browser,
Playwright, native code, or external-output lifecycle changes.

## 2. Goals / Non-goals

- Goal: Make all production protected ingress private/native strict admission only, with no
  caller-supplied guard/snapshot/probe or legacy lstat fallback.
- Goal: Remove ignored TypeScript runtime execution; use a collector-owned fail-closed
  lexical extractor for permitted static/type/literal dynamic imports.
- Goal: Reject non-directory/non-regular filesystem leaves and prove distinct manifest
  leaves overlap in real worker/process concurrency.
- Non-goal: General TypeScript package/alias resolution or hostile kernel-time no-follow
  guarantees beyond documented Node pathname limits.

## 3. Architecture Decisions

- **Decision**: Production capture creates a private native strict admission context with
  fixed batch probe; protected public row-producing helpers reject before any I/O unless
  invoked through that private context / basis: optional/structural context can be forged /
  trade-off: test seams move to low-level primitives / rejected: exported mint factory and
  lstat-only fallback.
- **Decision**: Replace direct ignored `typescript.js` import with an in-module lexical
  extractor that supports contained literal static/export-from/import-type/dynamic import
  forms and rejects unsupported/nonliteral syntax / basis: executed parser bytes must not
  escape provenance / trade-off: constrained grammar / rejected: `ts.sys` or node_modules
  parser dependency.
- **Decision**: Require every checked segment to be directory or regular file according to
  path role; run real worker/process barrier captures to exercise actual sibling `wx` churn
  / basis: fake microtasks neither prove leaf type nor overlap / trade-off: bounded worker
  harness / rejected: Promise-only concurrency simulation.

## 4. Interfaces

- production capture context — non-exported native strict guard/snapshot/fixed probe.
- protected public ingress — rejects absent/counterfeit admission before I/O.
- lexical extractor — admitted bytes only; literal contained imports or fail closed.
- worker barrier harness — two distinct owned manifest leaves overlap and both validate.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a protected row-producing API lacks authentic production admission THE
  SYSTEM SHALL reject before stat/read/hash/probe/cache; no caller-supplied no-op probe or
  duck-typed context SHALL mint authority.
- SDS-AC-2: WHEN admitted source contains permitted literal static/type/dynamic relative
  imports THE SYSTEM SHALL discover them from collector-owned parser bytes; nonliteral or
  unsupported forms SHALL fail capture, and no ignored external parser shall execute.
- SDS-AC-3: WHEN a checked segment is special/non-directory/non-regular for its role THE
  SYSTEM SHALL fail before probe/read/write; directory and regular leaf role changes also
  fail closed.
- SDS-AC-4: WHEN two actual workers/processes synchronize at a barrier then create distinct
  `wx` manifest leaves THE SYSTEM SHALL admit both under real directory churn, while same
  leaf/reparse/identity changes fail; combined gate remains <120 seconds.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.trust.test.mjs | Omitted/counterfeit/no-op admission yields zero I/O. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.trust.test.mjs | Real Inventory type/dynamic closure included; nonliteral rejects without external parser. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.trust.test.mjs | Special leaf and role change reject before probe/read/write. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.trust-race.test.mjs | Worker/process barrier proves concurrent distinct leaves and cleanup. |

## 7. Open Questions

- Strong no-follow kernel-time write isolation still requires a separate native/Win32-handle
  design; this step retains fail-closed observation only.
