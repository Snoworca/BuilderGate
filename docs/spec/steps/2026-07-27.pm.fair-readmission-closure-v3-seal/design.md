# SDS: 2026-07-27.pm.fair-readmission-closure-v3-seal

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-seal |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Final trust review reproduced public capability minting, silent lexer omission, special leaf
admission, non-native/flaky worker race, and ambient Git execution. They are one provenance
seal boundary. This successor changes only the offline collector and focused tests; no fresh
external evidence, runtime/browser, or Playwright lifecycle action is permitted.

## 2. Goals / Non-goals

- Goal: Seal native-only admission, complete fail-closed lexical discovery, filesystem roles,
  real concurrent manifest validation, and Git identity/environment provenance.
- Non-goal: General module resolution, native no-follow API, persistent worker, or app code.

## 3. Architecture Decisions

- **Decision**: Keep native admission mint private to production capture and reject all
  caller guard/snapshot/fs/probe authority / basis: exported mint is forgeable / trade-off:
  tests use low-level or native integration only / rejected: injected public factory.
- **Decision**: Lex every potential import/export form to either contained literal discovery
  or explicit failure; no test-source exceptions / basis: silent omission invalidates closure
  / trade-off: narrow supported grammar / rejected: ignored unsupported syntax.
- **Decision**: Use native worker barrier with observed message protocol and creator-owned
  cleanup; Git uses fixed verified absolute executable + minimal env with `GIT_*` scrubbed /
  basis: mocks/ambient env cannot prove trust / trade-off: OS-specific fixed policy /
  rejected: PATH/inherited environment and Promise-only race.

## 4. Interfaces

- production capture — sole private native-admission mint site.
- lexical extractor — discovered contained literal specifiers or fail closed.
- native race harness — actual workers, barrier acknowledgements, owned cleanup.
- Git runner — fixed verified executable and minimal environment.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN public protected ingress lacks private native admission or supplies caller
  authority THE SYSTEM SHALL reject before any I/O; no exported factory shall mint it.
- SDS-AC-2: WHEN admitted source contains any import/export construct THE SYSTEM SHALL
  discover permitted contained literals or fail capture; no nonliteral/test exception shall
  be silently ignored and no external parser runtime shall execute.
- SDS-AC-3: WHEN an ancestor/leaf role is not the expected directory/regular-file form THE
  SYSTEM SHALL reject before probe/read/write; manifest leaf permits only absent-or-regular.
- SDS-AC-4: WHEN actual native workers synchronize and create distinct owned leaves THE
  SYSTEM SHALL prove both completion/cleanup deterministically; Git rows SHALL derive only
  from fixed verified Git with minimal non-ambient environment; combined gate <120s.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.seal.test.mjs | No public authority mint/I-O. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.seal.test.mjs | Literal discovery and all unsupported forms fail. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.seal.test.mjs | Special/role changes reject pre-operation. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs | Native worker protocol/ownership and Git env/executable integration. |

## 7. Open Questions

- Kernel-time no-follow guarantees remain outside Node pathname API scope.
