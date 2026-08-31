# SDS: 2026-07-27.pm.fair-readmission-closure-v3

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3 |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The v2 fair-readmission provenance capture used an unfrozen Playwright output path and
an opaque `node -e` collector, so its results cannot be admitted. This step supplies a
versioned, fail-closed collector only for a fresh v3 evidence run. It does not modify
the scheduler, browser runtime, historic v2 evidence, or the existing admission plan.

## 2. Goals / Non-goals

- Goal: Freeze and capture a reproducible v3 provenance contract in one executable
  Node module before evidence commands run.
- Goal: Refuse ambiguous source closure, config-lock, Git, or browser-output inputs.
- Non-goal: Run Playwright, change application behaviour, or admit/replace v2 evidence.
- Non-goal: Delete any pre-existing external output or any path other than a verified
  leaf created by this collector.

## 3. Architecture Decisions

- **Decision**: Export one `FROZEN_CONTRACT` and a capture CLI from
  `tools/wave3/fair-readmission-closure-v3.mjs` / basis: its canonical JSON and SHA-256
  make the executable contract inspectable / trade-off: a small dedicated tool /
  rejected: duplicated prose or opaque `node -e` capture.
- **Decision**: Use the external literal
  `C:/Work/kiwi-run-output/2026-07-27.pm.fair-readmission-closure-v3/ac9-playwright` /
  basis: it is absent, workspace-external, and disjoint from v2 / trade-off: one
  run-owned output location / rejected: v2, `%TEMP%`, placeholders, and workspace paths.

## 4. Interfaces

- `FROZEN_CONTRACT` — immutable v3 procedure version, browser environment, exact
  command families, external output literal, and protected-input serialization policy.
- `validateFrozenContract({ workspaceRoot, contract, fs })` — returns a normalized
  contract only when every literal and external-output safety precondition is exact;
  otherwise throws a deterministic fail-closed error before launch or cleanup.
- `captureFrozenProvenance({ workspaceRoot, manifestPath, phase, execFile, fs })` —
  captures the contract, executable and runtime hashes, protected rows, and canonical
  digest to the allowed v3 analysis path; unresolved inputs or Git/config ambiguity fail.
- `node tools/wave3/fair-readmission-closure-v3.mjs capture --phase <phase> --manifest <path>`
  — invokes the capture interface without running test commands or Playwright.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the collector loads the frozen contract THE SYSTEM SHALL expose the
  exact v3 output literal, HTTPS base URL, retries, workers, and browser argv in every
  canonical contract representation.
- SDS-AC-2: WHEN a capture or cleanup is requested THE SYSTEM SHALL refuse v2,
  placeholder, Temp, workspace-internal, pre-existing, or reparse-point output paths
  before launching a browser command or deleting anything.
- SDS-AC-3: WHEN the collector captures provenance THE SYSTEM SHALL write canonical
  UTF-8/LF/no-BOM protected input, its SHA-256, the collector SHA-256, selected Node
  runtime SHA-256, full argv/environment, and no browser-output contents.
- SDS-AC-4: WHEN source closure, fixture, config-lock, or scoped Git enumeration is
  unresolved or ambiguous THE SYSTEM SHALL fail closed; `server/config.json5` is valid
  only with exactly one literal `!!` status row and no index row.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.test.mjs | Contract literal and argv/runtime equality |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.test.mjs | Reject unsafe output and exact-leaf-only cleanup |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.test.mjs | Canonical manifest and executable/runtime digests |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.test.mjs | Fail-closed closure, config, fixture, and Git diagnostics |

## 7. Open Questions

- The fresh v3 admission plan and exact analysis artifact names are deferred until this
  collector is green; they must reference the contract SHA rather than duplicate it.
