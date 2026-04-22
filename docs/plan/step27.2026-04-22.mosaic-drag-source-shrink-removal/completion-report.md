# Step27 Completion Report

Date: 2026-04-22
Status: completed
Plan: [00.index.md](./00.index.md)

## Summary

Removed drag-start source shrink by stopping pre-drop live tree mutation in the `react-mosaic-component` vendor path and realigning invalid-drop handling around explicit restore/no-op behavior.

## Delivered

- `frontend/node_modules/react-mosaic-component/lib/MosaicWindow.js`
  - Removed drag-start `hide()` scheduling.
  - Removed drag-item `hideTimer` dependency.
  - Aligned split and reorder invalid-drop handling around `rootSnapshot`.
- `frontend/node_modules/react-mosaic-component/lib/internalTypes.d.ts`
  - Simplified `MosaicDragItem` to match the non-destructive drag-start flow.
- `frontend/patches/react-mosaic-component+6.1.1.patch`
  - Regenerated to include the Step27 vendor changes for clean-install reproducibility.
- `frontend/tests/e2e/grid-equal-mode.spec.ts`
  - Added drag-start geometry stability regressions for `equal` and `none`.
  - Added preview/guide presence assertions during drag start.
  - Kept existing reorder, negative-path, and persistence regressions green.
- `docs/plan/step27.../final-validation.md`
  - Recorded actual build and Playwright results.

## Phase Notes

- Phase 1
  - Removed vendor drag-start tree mutation.
- Phase 2
  - Replaced split invalid-drop cleanup with snapshot-based restore/no-op behavior.
- Phase 3
  - No additional app/UI mutation was required.
  - This was intentionally kept as a no-op phase to avoid introducing unnecessary UI changes.
- Phase 4
  - Added geometry stability regressions and revalidated the existing grid DnD contract.

## Validation

- `frontend`: `npm run build`
  - passed
- `frontend`: `npx playwright test tests/e2e/grid-equal-mode.spec.ts --project="Desktop Chrome"`
  - passed
  - `9 passed`

Covered regression scenarios:

- equal drag-start geometry stability
- none-mode drag-start geometry stability
- equal full-cell guide and move semantics
- self-drop no-op
- outside-target restore
- right-click and non-primary no-op
- toolbar surface outside the grip no-op
- none/focus/auto non-entry
- equal persistence across reload and add/remove

## Review

- Phase 1 strict reviewer: `No findings`
- Phase 2 strict reviewer: `No findings`
- Phase 3 strict reviewer: `No findings`
- Phase 4 strict reviewer: `No findings`

## Notes

- During verification, the Vite dev server on port `2003` had to be restarted and `.vite/deps` had to be cleared once so Playwright would use the latest patched vendor bundle instead of a stale optimized dependency cache.
