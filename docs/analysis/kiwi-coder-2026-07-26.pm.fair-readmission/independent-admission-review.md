# Independent fair-delivery admission review

## Verdict

**Reject lifecycle admission.** This review records only a repeatable observation on a frozen, dirty worktree. It does not verify `PERF-BGSTAB-010` for SpecKiwi, does not check any parent AC, and does not change Status, Stability, trace links, verification evidence, completed work, or `REL-BGSTAB-012`.

The observation matrix is intentionally fail-closed: AC-6 and AC-9 are deferred, so the nine original acceptance criteria are not all independently observed. Wave 3 and the parent requirement therefore remain incomplete.

## Reviewed inputs

- Original requirement: `PERF-BGSTAB-010`, Status `in_progress`, Stability `evolving`; all AC-1 through AC-9 remain unchecked.
- Procedure: `docs/plans/2026-07-26.pm.fair-readmission.plan.md` (closure-v2, docs-only).
- New PH-002 to PH-004 outputs only:
  - `baseline-provenance-manifest.json`
  - `decision-validator-pre.json`
  - `five-file-replay-result.json`
  - `decision-validator-post.json`
  - `post-replay-provenance-manifest.json`
  - `browser-ack-idle-hidden-boundary.json`
  - `final-protected-input-manifest.json`

## Provenance conclusion

The PH-002 and PH-005 protected-input canonical JSON strings are byte-for-byte equal and both have SHA-256 `7badde0669f6e8477d432ad544b51137bbbb84c4319b2bc00191ed8745cf5a12` (69,487 UTF-8 bytes). Recomputed hashes match the stored values. The closure records 98 source rows, 19 fixture rows, 12 config/lock rows, zero unresolved specifiers, 71 protected-path status rows, and 83 index rows.

This equality only proves the selected protected inputs did not drift during this evidence collection. The frozen input is explicitly dirty (`dirty_baseline_frozen=true`), including the literal ignored `server/config.json5` row (`!!`); it is not a clean-HEAD or canonical-SRS verification.

## Fresh command observations

- The decision validator passed before and after replay. Its validator regenerates the fixed 1/2/8-client WAN benchmark expectation before comparing the published decision and raw evidence.
- The exact five-file server argv passed: 98 tests, 98 passed, 0 failed.
- The fixed frontend unit argv passed: 70 tests, 70 passed, 0 failed.
- The single permitted isolated browser test passed once on `https://localhost:2222` with WSS, `--retries=0`, `--workers=1`, and its verified external output directory.

These command results support the observed rows in `ac-matrix.json`; they do not repair or supersede the original implementation evidence.

## Fail-closed exceptions

1. **AC-6 is deferred.** The plan intentionally excluded the unsafe browser E2E that selects an active/first workspace and offers mutation helpers. Server and unit invalid-ACK checks are not a replacement for the missing browser observation.
2. **AC-9 is deferred by the five-member decision result, 3:2.** The scheduler's non-mutation assertion and the isolated browser's idle observation passed, but the browser test injects a synthetic delivery through a relay into a reusable session. It does not independently prove the full interactive AI TUI semantic-session scope required by AC-9. Generic scheduler/browser evidence is therefore recorded but not elevated.

## Recommended bounded strict-TDD follow-up

Create a separate SDS-backed, strict-TDD scope before changing behavior or lifecycle:

1. First author a safe isolated browser red test for duplicate, stale, unknown, out-of-order, and over-ACK handling. It must observe no credit increase, a protocol-visible rejection, no delivery/status mutation, and must avoid topology/workspace mutation.
2. First author a second safe isolated browser red test using a genuine interactive AI TUI semantic session. It must cover echo, prompt redraw, cursor movement, ticker, and waiting-for-input repaint across a valid delivery ACK while the session remains `idle`.
3. Only if either red test exposes a behavior gap, make the minimum implementation change, then re-run the focused regressions and an independent review. If no gap exists, retain the resulting direct evidence for a later guarded admission decision.

Until that scope has completed with independent evidence, keep `PERF-BGSTAB-010` in progress, leave every parent AC unchecked, and keep `REL-BGSTAB-012` blocked.
