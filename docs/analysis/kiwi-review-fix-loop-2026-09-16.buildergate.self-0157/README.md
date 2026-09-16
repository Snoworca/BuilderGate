# Round record — independent review of the issue #34 ratification (self, 2026-09-16 01:57)

## What the two files are

| File | What it is |
| --- | --- |
| `review_inventory.json` | The independent reviewer's full output for one round: 13 findings (CRITICAL 0, HIGH 2, MEDIUM 5, LOW 6) plus 12 `verified_correct` entries — claims the reviewer checked and found sound. |
| `code.diff` | The code the reviewer read for that round: `frontend/playwright.issue34-capacity.config.ts`, `frontend/tests/e2e/issue34-capacity-ratify.spec.ts`, `frontend/tsconfig.e2e-ownership.json`. |

## Which tree they describe

They describe **`9c37cf4`**, over the range **`e50931b^..9c37cf4`** — the two
values the JSON itself carries in `review.head` and `review.range`.

## They are a historical record, not current fact

**Nothing in these two files was updated after the round, and nothing in them
should be.** A round record's whole value is that it is what that round actually
saw; rewriting it to match a later tree would destroy the only evidence that the
findings were ever true. They are therefore left exactly as captured, and this
file — not an edit to them — records the drift.

The findings were subsequently fixed in commit **`c442948`**
("test(issue34): 독립 리뷰의 증거 결함을 고치고 계측을 붙여 재포집한다"), which is
also the commit that made these two files stale.

## How they are now stale

1. **`review.head` and `review.range` point at a superseded tree.** `9c37cf4` is
   two commits back; `c442948` is where the findings were answered. Any count,
   line number or file path in the JSON is a statement about `9c37cf4` only.

2. **Every `docs/evidence/2026-09-16-issue34/` anchor points into a deleted
   directory.** `c442948` moved that bundle to
   `docs/analysis/2026-09-16.issue34-capacity-ratify/` (the raw artifacts under
   its `raw/` subdirectory) in response to finding F10, which is itself one of
   the findings recorded here. Six occurrences of that prefix remain in the
   JSON, including the `file` anchors of F3, F7, F10 and F12. None of them
   resolve any more.

3. **Every `issue34-capacity-ratify.spec.ts:NN` anchor refers to the superseded
   file.** The JSON anchors F1/F8 at `:23`, F2 at `:16`, F5 at `:60`, F9 at
   `:71` and F13 at `:76`. That spec was substantially rewritten in `c442948`
   (anti-constant guard, hard env validation, `AggregateError` cleanup, AC-4
   title) and again afterwards when the guards were moved out of module scope,
   so those line numbers no longer name the code the findings describe.

4. **Two `verified_correct` entries are no longer true of the tree.** Both were
   true at `9c37cf4`; neither is true now.

   - *"All four screenshot SHA256 in `docs/evidence/2026-09-16-issue34/README.md:70-73`
     match the on-disk `.playwright-mcp/*.png` byte-for-byte."* — That README no
     longer exists. Worse, the r2 re-capture in `c442948` wrote screenshots to
     the same value-named paths and **overwrote three of the four images**
     (`issue34-max-workspaces-4.png`, `issue34-max-tabs-3.png`,
     `issue34-max-tabs-2.png`), so three of the four hashes the reviewer matched
     now match no file on disk. `.playwright-mcp/` is gitignored, so the r1
     images are unrecoverable. Current hashes are tabulated in
     `docs/analysis/2026-09-16.issue34-capacity-ratify/README.md`.
   - *"SRS discipline is correct: VE-5 appended, VE-1..VE-4 untouched,
     Status/Stability/AC unchanged (diff is exactly two added lines)."* — The
     "exactly two added lines" measurement was of `e50931b` alone. Over
     `e50931b^..c442948` the same file's diff is **three added lines**: `c442948`
     appended VE-6 and repointed VE-5's Reference cell to the moved directory.
     The rest of the entry still holds — VE-1..VE-4 are untouched and Status,
     Stability and the acceptance-criteria checkboxes are unchanged — but the
     parenthetical line count is not.

   The other ten `verified_correct` entries were not re-verified against
   `c442948` by this note and are not asserted to hold; they are simply not
   known to have been invalidated.

## Where current state lives

- `docs/analysis/2026-09-16.issue34-capacity-ratify/README.md` — the evidence
  bundle as it stands, including the r2 instrumented runs, the guard controls
  and the current screenshot hashes.
- `docs/report/2026-09-16.issue34-workspace-tab-capacity-ratification.md` — the
  work report.
- `docs/spec/30.buildergate-stability.srs.md`, requirement `FR-BGSTAB-026`,
  rows VE-5 and VE-6 — the requirement-side record.
