# Step26 Completion Report

Date: 2026-04-22
Status: completed
Plan: [00.index.md](./00.index.md)

## Summary

Implemented Option A slot reorder for grid `equal` mode by patching `react-mosaic-component` with `patch-package`, then wiring the app layer so reorder remains equal-only and persistence keeps the reordered canonical leaf order.

## Delivered

- `frontend/package.json`
  - Added `patch-package` and `postinstall` wiring.
- `frontend/patches/react-mosaic-component+6.1.1.patch`
  - Stores the vendor runtime patch for `react-mosaic-component@6.1.1`.
- `frontend/node_modules/react-mosaic-component/lib/*`
  - Added `reorderEnabled` plumbing.
  - Added full-cell reorder target and slot-index reorder payloads.
  - Added explicit restore path for invalid drops.
  - Disabled root drop targets in reorder mode.
  - Suppressed toolbar-wrapper drag in reorder mode and enforced desktop primary-mouse gating.
- `frontend/src/components/Grid/MosaicContainer.tsx`
  - Enabled vendor reorder only in `equal` mode.
  - Preserved reordered leaf order when equal canonicalization re-applies after drop.
  - Disabled wrapper drag in `equal` mode at the app boundary with `draggable={false}`.
- `frontend/src/hooks/useMosaicLayout.ts`
  - Rehydrates canonical equal trees from reordered leaf order.
  - Persists fresh recovered layouts even without prior storage.
- `frontend/src/utils/mosaic.ts`
  - Added `buildRecoveredEqualMosaicTree()` to rebuild equal layouts from recovered leaf order.
- `frontend/src/components/Grid/MosaicToolbar.tsx`
  - Rewrote the file in clean UTF-8.
  - Added stable `data-*` selectors for the drag handle, toolbar, and mode buttons.
- `frontend/tests/e2e/grid-equal-mode.spec.ts`
  - Replaced the old split-target regression with full-cell reorder regressions.

## Validation

- `frontend`: `npm run build`
  - passed
- `frontend`: `npx playwright test tests/e2e/grid-equal-mode.spec.ts --project="Desktop Chrome"`
  - passed
  - `7 passed`

Covered regression scenarios:

- equal full-cell guide
- move semantics
- self-drop no-op
- outside-target restore
- right-click and non-primary no-op
- toolbar surface outside grip no-op
- none/focus/auto non-entry
- equal persistence across reload and add/remove

## Review

- Phase 1 strict reviewer: `No findings`
- Phase 2 strict reviewer: `No findings`
- Phase 3 strict reviewer: `No findings`
- Phase 4 strict reviewer: `No findings`

## Notes

- During validation, the Vite dev server on port `2003` had to be restarted once so the patched `react-mosaic-component` dependency would be re-optimized and served correctly.
