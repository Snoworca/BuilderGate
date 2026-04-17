# 최종 검증

## 필수 게이트

- [ ] architecture와 tech decisions가 구현 diff와 일치한다
- [ ] tab/grid 모드 전환이 terminal runtime 재생성을 기본 경로로 삼지 않는다
- [ ] canonical mosaic tree가 tab mode 사용 중에도 보존된다
- [ ] `Workspace-2` stale layout recovery가 유지된다
- [ ] `frontend/npm run build` 통과
- [ ] `server/npm test` 통과
- [ ] Playwright reuse/regression 시나리오 통과
- [ ] Codex `1부터 500까지 종 방향으로 출력` 수동 시나리오 통과
- [ ] restart/delete/orphan cleanup 회귀 없음
- [ ] sessionId당 live consumer 수가 1을 넘지 않는다
- [ ] runtime recreate count가 모드 전환만으로 증가하지 않는다
- [ ] old path 제거 여부와 rollback 조건 문서화 완료
- [ ] `terminal_runtime_registry_enabled` enable/disable/rollback 절차가 명시됐다
- [ ] feature flag 제거 시점이 명시됐다

## 실패 시 중단 조건

- 같은 세션이 tab/grid 전환에서 다시 subscribe/snapshot full handoff를 반복한다
- focus, input, selection, paste 중 하나라도 안정적으로 유지되지 않는다
- grid recovery가 다시 깨진다
- Codex TUI에서 duplicate redraw 또는 blank gap이 재발한다
- observability만으로 recreate/subscription churn을 설명할 수 없다
