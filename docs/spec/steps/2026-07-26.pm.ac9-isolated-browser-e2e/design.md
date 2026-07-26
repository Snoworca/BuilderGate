# SDS: PERF-BGSTAB-010 AC-9 isolated browser evidence

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.ac9-isolated-browser-e2e |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

The existing fair-delivery browser case in
`wave3-terminal-authority-fairness.spec.ts` writes historical phase evidence
from `afterAll`. Re-running it to obtain current AC-9 evidence would overwrite
that historical record. This step creates one self-contained browser test that
uses the actual HTTPS app and its WebSocket while keeping all evidence in the
transient Playwright result directory. It implements no production behavior and
does not promote or complete the parent requirement.

## 2. Goals / Non-goals

- Goal: independently prove that a visible synthetic fair-delivery output is
  rendered, acknowledges exactly once, and leaves the interactive session idle.
- Goal: prove the test source neither imports the historical evidence suite nor
  references its analysis-output directory.
- Goal: preserve an initial missing-spec RED before the isolated test exists.
- Non-goal: rerun, import, extract from, or change
  `wave3-terminal-authority-fairness.spec.ts` or any historical evidence file.
- Non-goal: send semantic terminal input, change production code, alter UI,
  modify `PERF-BGSTAB-010` lifecycle metadata, or treat this one case as
  complete fair-delivery/admission evidence.

## 3. Architecture Decisions

- **Decision**: add a standalone Playwright spec with a small local routed
  WebSocket relay / basis: importing the existing suite executes its `afterAll`
  historical-evidence writer / trade-off: limited test-only relay duplication /
  rejected: reusing or extracting the historical suite's in-file helpers.
- **Decision**: use only `https://localhost:2222` and the browser's real `/ws`
  connection / basis: project validation policy requires the HTTPS reverse-proxy
  path / trade-off: browser startup is slower than a unit-only simulation /
  rejected: a mocked page, a direct server-only test, or HTTP port 2221.
- **Decision**: use an absent-spec invocation as the RED / basis: AC-9 runtime
  behavior already exists and this task only adds an isolated evidence artifact /
  trade-off: RED proves the required test artifact is absent rather than a
  production defect / rejected: retroactively claiming the historical test's
  original RED or changing production behavior solely to manufacture a failure.

## 4. Interfaces

- `routeWebSocket(/\/ws/)` — local Playwright relay that forwards the browser's
  real WebSocket traffic and can inject a typed server-to-page frame for one
  captured connection generation.
- `PERF-BGSTAB-010 AC-9 isolated browser case` — transient test-result-only
  evidence; it must not write `docs/analysis/**` or import the historical suite.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the planned isolated Playwright spec does not exist, THE
  Playwright invocation SHALL exit non-zero with a missing-spec error.
- SDS-AC-2: WHEN the isolated case logs in, THE browser URL origin SHALL be
  `https://localhost:2222` and the case SHALL route the browser's real `/ws`
  connection without creating a listener on another port.
- SDS-AC-3: WHEN the visible active terminal has settled, THE case SHALL observe
  its semantic session status as `idle` before delivery injection.
- SDS-AC-4: WHEN the relay injects one accepted fair-delivery capability and one
  sequenced visible output frame for that session, THE terminal SHALL render the
  unique marker and emit exactly one matching `terminal-delivery:ack` frame.
- SDS-AC-5: WHEN that ACK is emitted without any semantic terminal input, THE
  semantic session status SHALL remain `idle`.
- SDS-AC-6: WHEN the isolated spec is inspected, THE source SHALL neither import
  `wave3-terminal-authority-fairness.spec.ts` nor reference historical
  `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness`
  output paths or filesystem writers.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | recorded command/evidence | Run the absent isolated-spec invocation and record its non-zero missing-spec RED. |
| SDS-AC-2 | `frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts` | Assert the browser origin and relay the actual WebSocket connection. |
| SDS-AC-3 | `frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts` | Assert the active session is idle before injection. |
| SDS-AC-4 | `frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts` | Inject one typed capability/output delivery and assert the marker plus exactly one ACK. |
| SDS-AC-5 | `frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts` | Assert idle after the ACK without sending semantic input. |
| SDS-AC-6 | `frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts` | Static source guard rejects the historical import/path and filesystem writer tokens. |

## 7. Open Questions

- The five-member decision committee selected this isolated strict-TDD evidence
  path (4:1) after the historical AC-9 suite was found to rewrite prior evidence.
