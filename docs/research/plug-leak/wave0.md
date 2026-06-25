# Wave 0 — Baseline And Config Contract Recovery

## 목표

현재 source, untracked stability tests, SRS/documentation 사이의 drift를 먼저 정리한다. 이 wave는 behavior를 바꾸지 않는다. 이후 wave들이 공통으로 사용할 `resourceLimits`, `realtime/wsTransportMode`, `/api/runtime-config`, Settings contract의 타입과 기본값을 세운다.

## 현재 관찰

- `/api/runtime-config`는 `inputReliabilityMode`만 반환한다. 대상: `server/src/index.ts:259`.
- `Config`에는 `resourceLimits`가 없다. 대상: `server/src/types/config.types.ts`.
- `configSchema`에는 `resourceLimits`가 없다. 대상: `server/src/schemas/config.schema.ts`.
- bootstrap template/example에는 `resourceLimits`가 없다. 대상: `server/src/utils/configTemplate.ts`, `server/config.json5.example`.
- 일부 untracked tests는 이미 `resourceLimits`와 `wsTransportMode`를 기대한다.
- frontend runtime config tests는 resource limit getter/versioning을 기대하지만 `frontend/src/utils/inputReliabilityMode.ts`는 mode만 load한다.

## 구현 범위

### 서버 config contract

수정 대상:

- `server/src/types/config.types.ts`
- `server/src/schemas/config.schema.ts`
- `server/src/utils/configTemplate.ts`
- `server/config.json5.example`
- `server/src/services/RuntimeConfigStore.ts`
- `server/src/services/SettingsService.ts`
- `server/src/services/ConfigFileRepository.ts`
- `server/src/types/settings.types.ts`
- `server/src/index.ts`

추가할 최상위 설정:

```ts
interface ResourceLimitsConfig {
  headless: {
    pendingOutputMaxBytes: number;
    pendingOutputMaxChunks: number;
    writeLagWarnMs: number;
    writeBatchMaxBytes: number;
    overflowPolicy: 'degrade-headless';
  };
  ws: {
    serverBufferedHighWaterBytes: number;
    serverBufferedHardLimitBytes: number;
    perClientOutputQueueMaxBytes: number;
    perClientControlQueueMaxBytes: number;
    outputCoalesceWindowMs: number;
  };
  clientWs: {
    inputBackpressureBytes: number;
    hardReconnectBytes: number;
  };
  terminal: {
    visibleOutputQueueMaxBytes: number;
    visibleOutputMaxChunks: number;
    visibleFlushBudgetBytes: number;
    hiddenOutputPolicy: 'write-hidden' | 'snapshot-restore' | 'debug-tail';
    hiddenOutputTailBytes: number;
    inputQueueMaxBytes: number;
    inputQueueTtlMs: number;
    transportOutboxMaxBytes: number;
    transportOutboxTtlMs: number;
    scrollbackLines: number;
  };
  snapshots: {
    perSnapshotMaxChars: number;
    totalStorageBudgetChars: number;
    maxEntries: number;
    tombstoneTtlMs: number;
  };
  workspaceRuntime: {
    maxLiveWorkspaces: number;
    maxLiveTerminals: number;
    hiddenRuntimeTtlMs: number;
  };
  telemetry: {
    sampleIntervalMs: number;
    recentEventLimit: number;
  };
}
```

추가할 운영 모드/롤백 설정:

```ts
interface StabilityModesConfig {
  headlessQueueMode: 'observe' | 'bounded';
  wsSendMode: 'direct' | 'safe-send-observe' | 'safe-send-enforce';
  frontendRuntimeResidency: 'legacy' | 'bounded' | 'off';
}
```

이 설정은 limit 값과 다르게 behavior switch다. Wave 0에서는 현재 동작을 바꾸지 않기 위해 `headlessQueueMode: 'observe'`, `wsSendMode: 'direct'`, `frontendRuntimeResidency: 'legacy'`를 기본값으로 둔다. Wave 4와 Wave 7은 검증 후 기본값 전환을 별도 diff로 수행하며, 실패 시 이 값들로 즉시 되돌린다.

초기 기본값:

- Headless: `8 MiB`, `1024 chunks`, `500ms`, `64 KiB batch`, `degrade-headless`.
- Server WS: high `8 MiB`, hard `32 MiB`, output queue `2 MiB`, control queue `256 KiB`, coalesce `16ms`.
- Client WS: input backpressure `1 MiB`, hard reconnect `4 MiB`.
- Terminal: visible queue `4 MiB`, chunks `512`, flush budget `256 KiB`, hidden output policy `write-hidden` for legacy baseline, hidden tail `256 KiB`, input/transport queues `64 KiB`, TTL `1500ms`, scrollback `10000`.
- Snapshots: per snapshot `2,000,000`, total `3,000,000`, entries `16`, tombstone TTL `24h`.
- Workspace runtime: live workspaces `3`, live terminals `12`, hidden TTL `60000ms`.
- Telemetry: sample `60000ms`, recent events `256`.

Validation rules:

- strict nested objects; unknown keys are rejected.
- explicit `null` sections are rejected.
- `serverBufferedHardLimitBytes > serverBufferedHighWaterBytes`.
- `hardReconnectBytes > inputBackpressureBytes`.
- `totalStorageBudgetChars >= perSnapshotMaxChars`.
- queue byte values, chunk counts, TTLs, warn values, coalesce windows are bounded positive integers.
- `hiddenOutputPolicy: 'write-hidden'` is accepted only as explicit legacy fallback; Wave 7 should move the default to `snapshot-restore`.
- `stabilityModes` values are enum validated and included in Settings apply summaries.
- Settings UI range for `maxLiveWorkspaces` is `1..10`; unlimited mode is not introduced in this wave.

### Runtime config public projection

`/api/runtime-config` should expose non-secret browser values only:

```json
{
  "inputReliabilityMode": "observe",
  "wsTransportMode": "unified",
  "stabilityModes": {
    "frontendRuntimeResidency": "legacy"
  },
  "resourceLimits": {
    "clientWs": {},
    "terminal": {},
    "snapshots": {},
    "workspaceRuntime": {}
  }
}
```

Do not expose server-only process cleanup or WS hard-limit internals to browsers unless a frontend consumer needs them.

### Settings metadata

Extend `FieldCapability` with optional constraints:

```ts
constraints?: {
  min?: number;
  max?: number;
  step?: number;
  unit?: 'bytes' | 'ms' | 'count' | 'chars';
}
```

This lets Settings UI render numeric fields without duplicating validation ranges.

## 테스트 계획

Server:

- `server/src/schemas/config.schema.test.ts`
  - defaults applied to legacy config.
  - unknown keys rejected.
  - null sections rejected.
  - relationship failures rejected.
- `server/src/utils/configTemplate.test.ts`
  - bootstrap template includes `resourceLimits`.
  - example documents `resourceLimits`.
- `server/src/services/RuntimeConfigStore.test.ts`
  - editable snapshot includes selected resource keys.
  - field constraints exist.
  - merge patch keeps unrelated settings.
- `server/src/services/SettingsService` tests in `server/src/test-runner.ts`
  - invalid resource settings rejected.
  - apply failure rolls back runtime store.
- `/api/runtime-config` focused route test if route harness exists; otherwise add to server test runner.

Frontend:

- `frontend/tests/unit/runtimeConfig.test.ts` should pass against actual exports.
- `npm --prefix frontend run typecheck` must pass or documented unrelated failures must be isolated before Wave 1.

## 검증 명령

```powershell
npm --prefix server run build
npm --prefix frontend run typecheck
node --test server/dist/services/RuntimeConfigStore.test.js server/dist/ws/wsTransportMode.test.js
node --experimental-strip-types --test frontend/tests/unit/runtimeConfig.test.ts
```

## 롤백

- `resourceLimits` fields are additive.
- If rollback is required, stop consuming new fields while leaving them in config as ignored optional data.
- Keep legacy `inputReliabilityMode` response compatible.

## 완료 조건

- `resourceLimits` has typed defaults and strict validation.
- Settings snapshot can include selected resource limit fields.
- `/api/runtime-config` exposes browser-needed resource limits.
- No cleanup, queue, WebSocket send, or frontend runtime behavior changes in this wave.
