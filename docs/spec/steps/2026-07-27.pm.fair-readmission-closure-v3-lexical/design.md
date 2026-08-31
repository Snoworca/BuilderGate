# SDS: 2026-07-27.pm.fair-readmission-closure-v3-lexical

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-lexical |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Frozen roots use `import.meta.url`, local exports, TypeScript literal import type queries,
and sixteen runtime `import(identifier)` forms whose identifiers are immutable literal
constants. Current seal contract rejects them all, blocking native capture; source rewrite
would alter protected behavior. A unanimous committee selected an explicit conservative
lexical contract while retaining private admission, roles, native worker/Git hardening.

## 2. Goals / Non-goals

- Goal: Complete collector-only lexical discovery without silent omission or source rewrite.
- Goal: Retain seal's private admission, filesystem role, native worker ownership, and fixed
  Git trust requirements under one successor TDD.
- Non-goal: General JS/TS evaluation, constant propagation, aliases, package resolution, or
  source normalization.

## 3. Architecture Decisions

- **Decision**: Explicitly consume `import.meta.url`, local/default/type exports without
  `from`, and TS `import('literal')` type queries as zero-edge syntax; literal static/reexport
  imports remain edges / basis: these forms do not create runtime closure edges / trade-off:
  grammar is explicit / rejected: quiet skip or source rewrite.
- **Decision**: Resolve runtime `import(IDENT)` only where IDENT has exactly one prior,
  same-scope immutable `const IDENT [: type] = 'unescaped literal'`; reject shadowing,
  redeclaration, assignment/update, use-before-declare, options, templates, concat, calls,
  conditional, parameter/destructure, and any ambiguity / basis: all sixteen roots meet this
  narrow proof / trade-off: conservative rejection / rejected: generic const propagation or
  whitelist.
- **Decision**: Preserve private native admission, role checks, actual worker barrier owned
  cleanup, and fixed verified Git/minimal environment / basis: lexical completion must not
  reopen seal trust paths / rejected: public factory/mocks/PATH Git.

## 4. Interfaces

- lexical extractor — explicit zero-edge syntax, contained literal edges, narrow const edges,
  otherwise throw.
- production capture — sole private native admission/Git/role/worker trust integration.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN protected ingress lacks private native admission or caller authority is
  supplied THE SYSTEM SHALL reject before I/O; Git rows use fixed verified Git/minimal env.
- SDS-AC-2: WHEN admitted text contains explicit zero-edge syntax it SHALL not create a
  closure edge; literal runtime/static/reexport imports and proved immutable literal-const
  dynamic imports SHALL produce normal contained/external edges.
- SDS-AC-3: WHEN dynamic/import-meta/export syntax is nonliteral, resolver-capable,
  out-of-scope, mutable, shadowed, redeclared, or otherwise ambiguous THE SYSTEM SHALL fail
  capture with no silent omission; special filesystem roles also fail pre-operation.
- SDS-AC-4: WHEN default frozen capture processes all roots the sixteen proved dynamic edges
  SHALL resolve, native worker barrier captures shall complete/clean up deterministically,
  and combined gate shall pass <120s.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.lexical.test.mjs | Private admission/Git policy. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.lexical.test.mjs | Zero-edge/literal/16 actual const dynamic edges. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.lexical.test.mjs | Negative lexical and special role failures. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs | Native barrier/default capture/full gate. |

## 7. Open Questions

- `import.meta.resolve` remains resolver-capable and unsupported; it is not zero-edge.
