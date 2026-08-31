# SDS: fair-readmission closure-v3 remediation

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-remediation |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Independent review found that closure-v3 rejects the one permitted TerminalView CSS
dependency and leaves link/reparse and real-capture paths insufficiently tested. This
remediation repairs the collector only; it does not execute Playwright, mutate v2
evidence, or alter BuilderGate runtime behaviour.

## 2. Goals / Non-goals

- Goal: Admit exactly `TerminalView.tsx -> ./TerminalView.css` as a hash-only closure row
  while retaining fail-closed handling for every other local non-code dependency.
- Goal: Make protected inputs, external-output validation, and manifest writes reject
  links/reparse points, including dangling leaves.
- Goal: Bind a separate immutable contract canonical JSON/SHA-256 into each manifest and
  exercise the real read-only capture path with a disposable manifest leaf.
- Non-goal: Create, run, or delete external Playwright output; a future runner needs a
  separate SDS/TDD scope for that lifecycle.
- Non-goal: Modify application, tests outside this tool, historic v2 evidence, or SRS body.

## 3. Architecture Decisions

- **Decision**: Keep capture read-only for external Playwright output and remove cleanup
  responsibility / basis: a 3-person committee unanimously separated destructive output
  lifecycle from provenance / trade-off: future runner work / rejected: collector cleanup API.
- **Decision**: Require `lstat` link/reparse rejection for every existing protected input,
  manifest-destination segment, and output ancestor or leaf / basis: string containment
  and `stat` follow links / trade-off: stricter failures / rejected: resolve-after-write.
- **Decision**: Expose a contract-only canonical JSON/SHA-256 separate from mutable
  protected input / basis: later evidence must cite one frozen contract / trade-off: one
  small manifest field / rejected: reusing the capture-specific protected-input digest.

## 4. Interfaces

- `contractFingerprint(contract)` — returns the frozen contract's canonical UTF-8 JSON and
  SHA-256 without capture-specific rows.
- `collectSourceClosure({ workspaceRoot, sourceRoots, fs })` — resolves code imports and
  permits only the TerminalView CSS hash-only edge; unresolved or other assets throw.
- `captureFrozenProvenance({ workspaceRoot, manifestPath, phase, fs })` — validates all
  path segments, collects the default frozen inputs, and writes one new manifest leaf.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN `TerminalView.tsx` imports `./TerminalView.css` THE SYSTEM SHALL record
  that exact CSS file as a hash-only source row, and SHALL reject every other local CSS
  or non-code dependency before manifest write.
- SDS-AC-2: WHEN validating external output, protected input, or manifest destination
  paths THE SYSTEM SHALL reject a symbolic link, reparse point, dangling link, or
  pre-existing leaf before capture writes a manifest.
- SDS-AC-3: WHEN building a provenance manifest THE SYSTEM SHALL include a separate,
  contract-only canonical JSON and SHA-256 plus the existing protected-input digest.
- SDS-AC-4: WHEN the default collector captures a disposable analysis manifest THE SYSTEM
  SHALL complete the real source, fixture, config-lock, scoped-Git, runtime, and canonical
  write path without executing Playwright or creating external browser output.
- SDS-AC-5: WHEN any actual source, fixture, config-lock, or scoped-Git input is unresolved
  or ambiguous THE SYSTEM SHALL fail closed before a manifest is written.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.remediation.test.mjs | Real TerminalView CSS closure and other asset rejection |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.remediation.test.mjs | Dangling output and linked protected/manifest path rejection |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.remediation.test.mjs | Contract-only canonical fingerprint in manifest |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.remediation.test.mjs | Disposable real capture byte and side-effect assertions |
| SDS-AC-5 | tools/wave3/fair-readmission-closure-v3.remediation.test.mjs | Injected source/fixture/Git failure before write |

## 7. Open Questions

- The execution/cleanup runner remains a separate future TDD scope and must bind the
  `contractFingerprint` SHA before it may invoke Playwright.
