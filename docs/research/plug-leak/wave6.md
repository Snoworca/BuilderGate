# Wave 6 — Browser Settings For Resource Limits

상세 연구/구현 계획: [2026-06-28.buildergate-wave6-settings-resource-limits-plan.md](../2026-06-28.buildergate-wave6-settings-resource-limits-plan.md)

구현/검증 보고서: [2026-06-29.buildergate-wave6-settings-resource-limits-implementation-report.md](../2026-06-29.buildergate-wave6-settings-resource-limits-implementation-report.md)

## 목표

사용자가 요구한 원형 큐 크기, queue byte limit, WebSocket backpressure threshold, runtime residency limit 등을 브라우저 Settings 메뉴에서 변경할 수 있게 한다. Persistence source of truth는 서버 `config.json5`다.

## 구현 범위

수정 대상:

- `server/src/types/settings.types.ts`
- `frontend/src/types/settings.ts`
- `server/src/services/RuntimeConfigStore.ts`
- `server/src/services/SettingsService.ts`
- `server/src/services/ConfigFileRepository.ts`
- `frontend/src/components/Settings/SettingsPage.tsx`
- `frontend/src/services/api.ts`
- `frontend/tests/unit/runtimeConfig.test.ts`
- Settings 관련 unit/E2E tests

Settings cards:

Detailed plan note:

- `resourceLimits.headless.writeLagWarnMs` and `resourceLimits.headless.writeBatchMaxBytes` are decision-gated. Expose them only if Phase 0 proves or implements an actual runtime consumer; otherwise keep them reserved/unavailable in Wave6 UI.
- `resourceLimits.telemetry.*`, `stabilityModes.*`, `resourceLimits.terminal.visible*`, `resourceLimits.terminal.scrollbackLines`, `resourceLimits.ws.perClientControlQueueMaxBytes`, and `resourceLimits.ws.outputCoalesceWindowMs` are not Wave6 UI v1 fields unless the SRS update explicitly expands the scope.
- Final implementation decision: Wave6 keeps the decision-gated headless write-lag/write-batch/overflow-policy fields, `stabilityModes.*`, telemetry, visible-output scheduler fields, scrollback, WebSocket control queue, and WebSocket output coalescing unavailable in Settings capabilities and rejected by direct Settings PATCH.

- `Server Backpressure`
  - `resourceLimits.headless.pendingOutputMaxBytes`
  - `resourceLimits.headless.pendingOutputMaxChunks`
  - `resourceLimits.headless.writeLagWarnMs` (decision-gated)
  - `resourceLimits.headless.writeBatchMaxBytes` (decision-gated)
  - `resourceLimits.ws.serverBufferedHighWaterBytes`
  - `resourceLimits.ws.serverBufferedHardLimitBytes`
  - `resourceLimits.ws.perClientOutputQueueMaxBytes`
- `Browser Queues`
  - `resourceLimits.clientWs.inputBackpressureBytes`
  - `resourceLimits.clientWs.hardReconnectBytes`
  - `resourceLimits.terminal.inputQueueMaxBytes`
  - `resourceLimits.terminal.inputQueueTtlMs`
  - `resourceLimits.terminal.transportOutboxMaxBytes`
  - `resourceLimits.terminal.transportOutboxTtlMs`
- `Runtime Residency`
  - `resourceLimits.workspaceRuntime.maxLiveWorkspaces`
  - `resourceLimits.workspaceRuntime.maxLiveTerminals`
  - `resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs`
- `Snapshots`
  - `resourceLimits.snapshots.perSnapshotMaxChars`
  - `resourceLimits.snapshots.totalStorageBudgetChars`
  - `resourceLimits.snapshots.maxEntries`
  - `resourceLimits.snapshots.tombstoneTtlMs`
- `Hidden Output`
  - `resourceLimits.terminal.hiddenOutputPolicy`
  - `resourceLimits.terminal.hiddenOutputTailBytes`

UI rules:

- Use existing `Card`, `Field`, scope badge, validation banner, Save button flow.
- Mark dangerous/server runtime fields with `new_sessions` or `immediate` accurately.
- No marketing/explanatory page.
- Do not silently clamp invalid values in UI. Let server validation produce observable errors.

## Tests

Server:

- Settings PATCH valid resource values persists to config.
- invalid relationships rejected.
- apply failure rolls back runtime store.
- `ConfigFileRepository` can insert missing `resourceLimits` into legacy config text.

Frontend:

- SettingsPage renders resource cards.
- editing headless queue size builds correct PATCH.
- invalid local form state disables save or server error is rendered.
- save response apply summary is shown.

## 검증 명령

```powershell
npm --prefix server test
npm --prefix frontend run typecheck
node --experimental-strip-types --test frontend/tests/unit/runtimeConfig.test.ts
```

## 롤백

- Keep server defaults and hide Settings cards behind a feature flag if needed.
- Existing settings remain backward compatible.

## 완료 조건

- Browser Settings can change selected resource limits.
- Changes persist to `config.json5`.
- Browser runtime config reflects public resource limit values after save/reload.
