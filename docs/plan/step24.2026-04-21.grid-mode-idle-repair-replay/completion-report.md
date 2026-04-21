# Grid Mode Idle Repair Replay Completion Report

작성일: 2026-04-21  
계획 문서: [00.index.md](./00.index.md)

## Summary

grid mode TUI 깨짐을 idle 진입 후 1회 repair replay로 복구하는 1차 구현을 추가했다.

핵심 변경:

- WS protocol에 `repair-replay` client message 추가
- `WsRouter`에 resize 없이 authoritative snapshot replay를 시작하는 진입점 추가
- `TerminalContainer`에 `grid mode + running -> idle + quiet window` 조건의 one-shot repair trigger 추가
- `TerminalRuntimeLayer`에서 grid surface 여부를 `TerminalContainer`로 전달
- server replay lifecycle regression 추가

## Files Changed

- `server/src/types/ws-protocol.ts`
- `frontend/src/types/ws-protocol.ts`
- `server/src/ws/WsRouter.ts`
- `server/src/test-runner.ts`
- `frontend/src/components/Terminal/TerminalContainer.tsx`
- `frontend/src/components/Terminal/TerminalRuntimeLayer.tsx`

## Verification

- `server`: `npm run test`
  - result: `131 test(s) passed`
- `frontend`: `npm run build`
  - result: success

## Code Review

- dedicated reviewer subagent executed
- final result: `No findings`

## Residual Risk

- 실제 `codex`/`hermes` grid corruption이 자동 repair replay로 완전히 복구되는지는 아직 수동 검증이 남아 있다.
- 현재 trigger는 `running -> idle` transition 기반이라, status 모델이 실제 TUI thinking/output을 충분히 반영하지 못하는 경우 체감 복구 빈도가 낮을 수 있다.
- frontend 타이머/input gating과 grid/tab surface 분기에는 아직 별도 자동화 테스트가 없다.
- server `repair-replay` negative path(미구독, snapshot 없음, 이미 pending)는 별도 회귀로 아직 고정하지 않았다.
