# SDS: 2026-07-27.pm.fair-readmission-closure-v3-ingress-snapshot

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-ingress-snapshot |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

The ingress guarded-read implementation correctly applies pre/read/post validation but
repeats it for the same source, fixture, and config paths. The full collector regression
therefore exceeded 304 seconds. A unanimous committee selected a capture-local immutable
snapshot so every actual protected-byte read remains guarded exactly once while all later
consumers reuse the same verified bytes and digest. Scope remains the offline provenance
collector and its focused Node tests.

## 2. Goals / Non-goals

- Goal: Bound every canonical protected input to one capture-local force-fresh
  full-frontier `pre → read → post` verification and one byte read.
- Goal: Make TypeScript/CSS/fixture/config parsing and final manifest rows derive from the
  exact same private verified snapshot and digest.
- Goal: Restore bounded completion of the existing closure-v3 regression without weakening
  path/reparse or root-containment contracts.
- Non-goal: A module/global/cross-capture cache, a whole-capture filesystem snapshot, or
  global pre/post batch bracketing.
- Non-goal: Runtime, browser, Playwright, or external evidence-output changes.

## 3. Architecture Decisions

- **Decision**: Use a capture-scoped map keyed by an already-contained canonical absolute
  path (slash-normalized, case-preserving) / basis: a path's parser and manifest hash must
  share identical verified bytes while repeat probes caused the 304-second timeout /
  trade-off: explicit context plumbing / rejected: module/global cache and repeated reads.
- **Decision**: On a cache miss, complete full-frontier force-fresh `pre → one byte read →
  post` before admitting digest, row, or cache entry; on a hit, perform no filesystem
  operation / basis: preserves the per-actual-read ingress contract / trade-off: no claim
  that a file remains unchanged for the whole capture / rejected: one global pre/post batch.
- **Decision**: Keep cached bytes private and expose defensive copies or immutable derived
  text to parsers / basis: Node Buffers are mutable and a consumer must not change the
  digest/parsed sequence / trade-off: bounded copies / rejected: shared Buffer callbacks.

## 4. Interfaces

- `createProtectedInputSnapshot({ fs, reparseGuard })` — capture-local guarded snapshot
  context; no module/global state.
- `snapshot.read({ absolutePath, kind, path })` — cache miss performs full-frontier
  force-fresh pre/read/post and returns a defensive byte/text view plus same-snapshot digest;
  cache hit performs no filesystem operation.
- Protected source/fixture/config/collector/runtime consumers — parse and emit rows only
  from the snapshot result for that canonical path.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN one canonical contained protected path is requested multiple times during
  one capture THE SYSTEM SHALL execute exactly one full-frontier force-fresh `pre → read →
  post` sequence and one filesystem byte read; later consumers SHALL perform no stat,
  probe, hash, or read for that path.
- SDS-AC-2: WHEN a snapshot read's post validation fails THE SYSTEM SHALL discard bytes,
  digest, row, and cache entry; no later consumer SHALL receive the failed value.
- SDS-AC-3: WHEN source/config/fixture parsing and manifest row construction consume a
  protected path THE SYSTEM SHALL use the same verified byte sequence and digest; mutable
  shared Buffer exposure SHALL be impossible.
- SDS-AC-4: WHEN the ordinary closure-v3 capture runs against its current frozen inputs THE
  SYSTEM SHALL finish the focused regression suite within its test timeout while retaining
  full-frontier force-fresh protection on every actual protected-byte read.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs | Count one guard/read cycle per canonical path and zero filesystem operations on hits. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs | Post-read mutation leaves no digest/cache value and retry is a new guarded miss. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs | Parsing and manifest rows use matching snapshot bytes/digest and mutation cannot alter retained state. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs | Real collector capture regression completes under the focused test timeout with guarded reads. |

## 7. Open Questions

- This snapshot verifies each actual read, not an atomic whole-capture filesystem image.
  A capture-wide snapshot requires a separate OS-handle or filesystem design.
