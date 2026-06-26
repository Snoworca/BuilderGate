# BuilderGate Wave 0 Baseline Config Contract Completion Report

Date: 2026-06-25
Target: `0.5.5-buildergate-stability`
Requirement: `FR-BGSTAB-008`
Plan: `docs/plans/2026-06-25.projectmaster.buildergate-wave0.plan.md`

## Result

Wave 0 baseline configuration contract recovery was implemented and marked `implemented` in SpecKiwi.

The implementation is intentionally additive. Later-wave behavior changes remain disabled by default:

- `stabilityModes.headlessQueueMode`: `observe`
- `stabilityModes.wsSendMode`: `direct`
- `stabilityModes.frontendRuntimeResidency`: `legacy`
- `realtime.wsTransportMode`: `unified`

## Implemented Scope

- Added typed `resourceLimits`, `stabilityModes`, and `realtime.wsTransportMode` config contracts.
- Added strict schema defaults and validation for headless, server WebSocket, browser WebSocket, terminal, snapshots, workspace runtime, and telemetry limits.
- Added the same defaults to bootstrap config rendering and `server/config.json5.example`.
- Extended Settings snapshot/patch types, capability metadata, constraints, patch validation, runtime merging, and JSON5 persistence.
- Extended `/api/runtime-config` to return only browser-safe public values.
- Extended frontend runtime config parsing with getters, section-level safe fallback, config versioning, and change subscriptions.
- Added focused regression tests for schema, template, settings snapshot, public runtime config, JSON5 insertion, and frontend runtime consumers.
- Code review fixes keep future-wave server-side switches unavailable in Settings until runtime consumers exist, preserve the validated public `realtime.wsTransportMode`, and make frontend runtime residency limits apply only in `bounded` mode.

## Verification

Passed:

- `npm --prefix server test`
- `node --test server/dist/schemas/config.schema.test.js server/dist/utils/configTemplate.test.js server/dist/services/RuntimeConfigStore.test.js server/dist/services/ConfigFileRepository.resourceLimits.test.js server/dist/services/SettingsService.resourceLimits.test.js` (19 tests)
- `node --experimental-strip-types --test frontend/tests/unit/runtimeConfig.test.ts frontend/tests/unit/webSocketBackpressure.test.ts frontend/tests/unit/useTerminalRuntimeResidency.test.ts frontend/tests/unit/terminalHiddenOutput.test.ts frontend/tests/unit/terminalOutputScheduler.test.ts` (43 tests)
- `npm --prefix frontend run typecheck`
- `mcp__speckiwi.validate_spec(strict=true)`
- Sub-agent code review loop: first pass findings were fixed; final re-review returned `No findings`.

Follow-up correction:

- A later review found that `/api/runtime-config` always projected `wsTransportMode` as `unified`. `RuntimeConfigStore` now preserves `config.realtime.wsTransportMode` and the regression test expects `split-shadow` to survive projection.
- The earlier frontend typecheck gap from unrelated `RecoveryOptionManager` files is no longer current in this working tree; `npm --prefix frontend run typecheck` passes in the 2026-06-26 follow-up verification.

## Main Files

- `server/src/types/config.types.ts`
- `server/src/schemas/config.schema.ts`
- `server/src/utils/configTemplate.ts`
- `server/config.json5.example`
- `server/src/types/settings.types.ts`
- `frontend/src/types/settings.ts`
- `server/src/services/RuntimeConfigStore.ts`
- `server/src/services/SettingsService.ts`
- `server/src/services/ConfigFileRepository.ts`
- `server/src/index.ts`
- `frontend/src/utils/inputReliabilityMode.ts`
- `frontend/src/types/ws-protocol.ts`
- `server/src/services/RuntimeConfigStore.test.ts`
- `server/src/services/ConfigFileRepository.resourceLimits.test.ts`
