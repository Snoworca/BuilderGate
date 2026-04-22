# Grid Equal Mode DnD And Manual Resize Release Completion Report

작성일: 2026-04-21  
계획 문서: [00.index.md](./00.index.md)

## Summary

grid mode layout mode/state 불일치를 줄이기 위해 다음을 구현했다.

- `LayoutMode`에 `none` 상태 추가
- `equal/focus/auto` 버튼 재클릭 시 `none`으로 토글
- `equal` 모드에서 tile drop 완료 시 grid 재구성 기반 equal 재적용
- split 수동 리사이즈 완료 시 `equal -> none` 전환
- persistence와 toolbar state를 새 mode 모델에 맞게 동기화
- `equal`은 기본 2행 고정, equal 버튼을 누른 시점에 세로가 더 길면 2열 고정
- 이 arrangement는 resize 이벤트마다 다시 계산하지 않고 equal 버튼을 누를 때만 결정
- drag-start hide release와 actual drop commit을 분리해, drop 완료 후에만 equal 재격자화가 일어나도록 정리했다
- `restoreLayoutWithSessionRecovery`가 stale focus target remap과 none-mode new tab recovery를 처리하도록 보강했다

## Files Changed

- `frontend/src/hooks/useLayoutMode.ts`
- `frontend/src/hooks/useMosaicLayout.ts`
- `frontend/src/components/Grid/MosaicToolbar.tsx`
- `frontend/src/components/Grid/MosaicContainer.tsx`
- `frontend/src/utils/mosaic.ts`
- `frontend/tests/e2e/grid-equal-mode.spec.ts`

## Verification

- `frontend`: `npm run build`
  - result: success
- `frontend`: `npx playwright test tests/e2e/grid-equal-mode.spec.ts --project="Desktop Chrome"`
  - result: 3 passed

## Code Review

- Phase 1 reviewer result: `No findings`
- Phase 2 reviewer result: `No findings`
- Phase 3 reviewer result: `No findings`

## Residual Risk

- focus/auto retarget/toggle 쪽은 아직 수동 interaction 검증을 추가하면 더 안전하다.
