# SDS: closure-v3 Windows reparse batch probe

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-reparse-batch |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

An identity-validated per-segment cache removes repeated ancestors but full provenance has
278 unique segments, and each PowerShell launch costs about 327 ms. The resulting capture
times out. This step batches known source/config/fixture frontiers through the same fixed
Windows attribute mechanism without relaxing failure handling.

## 2. Goals / Non-goals

- Goal: Check ordered batches of existing Windows segments in one fixed PowerShell process
  and accept only an exact success record bound to the canonical input JSON.
- Goal: Retain pre/post lstat identity checks, cache isolation, and force-fresh manifest/
  output boundaries while reducing subprocess launch count.
- Goal: Batch only paths known at each source BFS/config/fixture discovery frontier.
- Non-goal: Read/hash candidate files in PowerShell, persist state, run Playwright, or add
  a native addon.
- Non-goal: Claim hostile TOCTOU resistance beyond observable pre/post identity rejection.

## 3. Architecture Decisions

- **Decision**: Pass case-preserving absolute normalized existing paths as UTF-8 canonical
  JSON Base64 in one child environment value to a fixed UTF-16LE encoded PowerShell program
  / basis: no dynamic path reaches argv or executable script / trade-off: strict protocol
  code / rejected: per-path PowerShell, path interpolation, and shell invocation.
- **Decision**: A batch succeeds only with one LF-terminated
  `FRRPB1:<count>:<sha256-of-input-json>` record and no stderr; all listed attributes must
  lack ReparsePoint / basis: binds response to the exact request without partial success /
  trade-off: no per-path diagnostic result / rejected: locale text or a partial bitmap.
- **Decision**: Deterministically split batches at 64 unique segments or 8 KiB input JSON,
  preserve order/casing, and lstat-compare identities before and after each batch / basis:
  environment safety and observable concurrent-change rejection / trade-off: more than one
  child for very large frontiers / rejected: unbounded environment payload.

## 4. Interfaces

- `probeWindowsReparsePoints({ paths, execFileSync, env })` — runs one fixed batch protocol
  and either verifies every path safe or throws.
- `probeWindowsReparsePoint(...)` — the compatible one-path wrapper over the batch probe.
- `createSegmentReparseGuard({ fs, probe, probeBatch })` — keeps the per-capture identity
  cache and batches cache misses/frontiers without global state.
- `captureFrozenProvenance(...)` — sends source BFS waves, config, and fixture discoveries
  through the guard; manifest/output boundaries remain force-fresh.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a batch contains existing paths THE SYSTEM SHALL invoke only fixed
  shell-free encoded PowerShell argv with Base64 JSON environment input and accept only the
  exact bound `FRRPB1` success record with empty stderr.
- SDS-AC-2: WHEN a batch has a reparse point, process error, timeout, malformed/extra
  output, stderr, count/digest mismatch, invalid path, or identity change THE SYSTEM SHALL
  fail closed without caching a safe result.
- SDS-AC-3: WHEN source, config, or fixture paths are known at a BFS discovery frontier THE
  SYSTEM SHALL deduplicate and batch-probe them before reading the frontier; force-fresh
  manifest/output boundaries SHALL bypass ordinary cache reuse.
- SDS-AC-4: WHEN a batch exceeds 64 paths or 8 KiB canonical JSON THE SYSTEM SHALL split it
  deterministically without case folding or changing the aggregate provenance ordering.
- SDS-AC-5: WHEN a capture ends or a second capture starts THE SYSTEM SHALL not reuse the
  previous guard/cache or any prior batch success.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.batch.test.mjs | Fixed argv/env/exact bound success |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.batch.test.mjs | All malformed/error/reparse/identity failures |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.batch.test.mjs | Frontier dedupe and force-fresh behavior |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.batch.test.mjs | Stable path and byte-limit splitting |
| SDS-AC-5 | tools/wave3/fair-readmission-closure-v3.reparse.test.mjs | Guard/capture cache isolation |

## 7. Open Questions

- The three-person committee approved batch probing on 2026-07-27 after measuring 327 ms
  per launch and 278 unique segments. Native handle-walk is a separate future scope.
