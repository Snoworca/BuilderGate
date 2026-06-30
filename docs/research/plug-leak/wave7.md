# Wave 7 — Frontend Runtime Residency And Browser Backpressure

## 목표

서버 안정화와 Settings 조정 기능이 검증된 뒤 프론트엔드 누적 비용을 줄인다. hidden terminal runtime을 무제한 유지하지 않고, hidden output은 xterm에 계속 쓰지 않으며, browser WebSocket send도 backpressure를 본다.

## 구현 범위

수정 대상:

- `frontend/src/utils/inputReliabilityMode.ts`
- `frontend/src/hooks/useTerminalRuntimeResidency.ts`
- `frontend/src/App.tsx`
- `frontend/src/components/Terminal/TerminalRuntimeLayer.tsx`
- `frontend/src/components/Terminal/TerminalContainer.tsx`
- `frontend/src/components/Terminal/TerminalView.tsx`
- `frontend/src/utils/terminalHiddenOutput.ts`
- `frontend/src/utils/terminalOutputScheduler.ts`
- `frontend/src/utils/webSocketBackpressure.ts`
- `frontend/src/utils/terminalSnapshot.ts`
- `frontend/src/hooks/useMosaicLayout.ts`

Work items:

1. Runtime config getters
   - expose `getClientWsResourceLimits()`
   - expose `getTerminalResourceLimits()`
   - expose `getSnapshotResourceLimits()`
   - expose `getWorkspaceRuntimeResourceLimits()`
   - publish runtime config version changes.
2. Runtime residency
   - replace `MAX_ALIVE_WORKSPACES = 0` path with `useTerminalRuntimeResidency`.
   - active/visible tabs are always pinned.
   - evicted tabs are not passed to `TerminalRuntimeLayer`.
   - prune `terminalRefsMap`, `aliveWorkspaceIds`, `workspaceVisitOrder`.
3. Hidden output
   - hidden output does not call xterm write.
   - hidden sessions mark stale/dirty and recover via snapshot/screen repair on visible transition.
4. Visible output scheduler
   - direct `term.write()` path uses bounded scheduler.
   - overflow requests authoritative recovery.
5. Browser WebSocket backpressure
   - input send checks `bufferedAmount`.
   - too much buffered data returns explicit failure/queue result; it must not claim input was sent.
6. Snapshot and layout cleanup
   - snapshot budgets use runtime config.
   - tombstone TTL cleanup is deterministic.
   - workspace delete removes mosaic layout without re-save on delete unmount.

## Browser worker note

브라우저 Worker는 이번 wave의 필수 조건이 아니다. 먼저 main-thread 경로에서 hidden runtime eviction, output scheduler, backpressure를 적용한다. 그래도 active terminal output flood가 main thread를 막으면 후속 wave로 Terminal Transport Worker를 검토한다.

Worker가 들어간다면 역할은 다음으로 제한한다.

- WebSocket ownership.
- JSON parse.
- session별 output batching.
- main thread render ack 기반 throttle.

xterm write와 DOM 작업은 main thread에 남는다.

## Tests

Frontend:

- residency hook: visible pinning, hidden TTL, workspace cap, terminal cap.
- App integration: evicted tabs are not mounted, visible tabs remain mounted.
- TerminalRuntimeLayer: stale refs are pruned.
- Hidden output: xterm write not called while hidden.
- Visible output scheduler: byte/chunk cap and overflow recovery.
- WebSocket backpressure: input send failure is explicit.
- Snapshot/layout cleanup: workspace delete clears expected keys.

E2E/manual:

- hidden high-output session does not increase active terminal key latency beyond threshold.
- switching back to parked workspace restores via snapshot/repair.
- Settings changes alter runtime behavior after reload.

## 검증 명령

```powershell
npm --prefix frontend run typecheck
npm --prefix frontend run build
node --experimental-strip-types --test frontend/tests/unit/useTerminalRuntimeResidency.test.ts frontend/tests/unit/terminalOutputScheduler.test.ts frontend/tests/unit/webSocketBackpressure.test.ts frontend/tests/unit/visibleOutputRecovery.test.ts frontend/tests/unit/runtimeConfig.test.ts
```

Manual/Playwright validation must target the project-approved HTTPS endpoint.

## 롤백

- `stabilityModes.frontendRuntimeResidency='off'` disables bounded hidden runtime residency if it causes regressions.
- `resourceLimits.terminal.hiddenOutputPolicy='write-hidden'` is allowed only as explicit legacy fallback.
- `wsTransportMode=unified`.
- direct xterm write fallback remains behind feature flag until soak passes.

## 완료 조건

- Mounted terminal runtime count is bounded by Settings.
- Hidden terminal output does not continuously write to xterm.
- Browser input send observes backpressure.
- Frontend build/typecheck and focused unit/E2E checks pass.
