# Phase 3 Verification

- [x] split resize exits equal mode
- [x] selected mode button toggles to none on re-click
- [x] user ratio is preserved
- [x] tile move and split resize are distinguished

## Evidence

- `frontend`: `npm run build`
- `frontend`: `npx playwright test tests/e2e/grid-equal-mode.spec.ts --project="Desktop Chrome"`
  - `TC-6502` passed
  - `TC-6503` passed
- code review: `No findings`
