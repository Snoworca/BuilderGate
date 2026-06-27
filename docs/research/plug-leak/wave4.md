# Wave 4 — Bounded Output Queues And Server WebSocket Backpressure

## 목표

서버 output 경로를 bounded로 만든다. `SessionManager`의 headless pending queue를 원형 큐/deque 기반 drain pump로 바꾸고, `WsRouter`의 direct `ws.send()` 경로를 `safeSend`와 per-client send pump로 통합한다.

## 핵심 원칙

- 원형 큐는 pending headless write queue의 O(1) dequeue와 cap 관리에 사용한다.
- pending write queue에서 overflow 시 overwrite/drop하지 않는다.
- overflow 기본 정책은 `degrade-headless`다.
- healthy path에서는 `routeSessionOutput()`을 headless write commit 뒤에 호출해 `screenSeq` 의미를 유지한다.
- 느린 WebSocket client는 session을 죽이지 않는다. 느린 client만 close/reconnect/replay 대상으로 만든다.

## 구현 범위

생성 후보:

- `server/src/utils/boundedByteDeque.ts`
- `server/src/utils/headlessOutputQueue.ts`
- `server/src/ws/wsSendPolicy.ts`

수정 대상:

- `server/src/services/SessionManager.ts`
- `server/src/ws/WsRouter.ts`
- `server/src/types/ws-protocol.ts`
- `server/src/index.ts` telemetry

Headless queue target:

```ts
interface HeadlessOutputEntry {
  data: string;
  byteLength: number;
  queuedAt: number;
}

interface HeadlessOutputPump {
  queue: BoundedByteDeque<HeadlessOutputEntry>;
  draining: boolean;
  closed: boolean;
  activeBytes: number;
  counters: {
    enqueued: number;
    coalesced: number;
    overflow: number;
    degraded: number;
    maxPendingBytes: number;
    maxPendingChunks: number;
  };
}
```

Ws safe send target:

```ts
type SafeSendResult =
  | 'sent'
  | 'queued'
  | 'coalesced'
  | 'not-open'
  | 'high-water'
  | 'critical-water'
  | 'queue-overflow'
  | 'send-error';
```

Per-client send state:

- separate control/output queue state.
- output can coalesce adjacent messages by session id up to configured byte limit.
- control messages are lossless-or-close.
- replay/screen-repair protocol queues remain separate from transport queues.

Telemetry:

- headless pending bytes/chunks/current/max.
- oldest pending age.
- overflow/degrade count.
- WS max observed `bufferedAmount`.
- transport queued client count and output/control queued bytes.
- max transport queued bytes.
- backpressure observe count.
- slow-client close count.
- send callback error count.
- output coalesce count.

## 테스트 계획

Server tests:

- delayed headless write cannot grow beyond byte cap.
- chunk cap is enforced.
- multibyte output uses UTF-8 byte length.
- overflow degrades headless, clears queue, records telemetry.
- observe mode also degrades on bounded queue overflow instead of retaining unbounded pending output.
- healthy output remains ordered after headless commit.
- direct `ws.send()` paths are removed or covered by `safeSend`.
- high-water queues output.
- hard-limit closes slow client.
- send callback error records telemetry; enforce mode closes only that client, while direct/observe do not enforce close.
- rollback from `safe-send-enforce` to `direct` or `safe-send-observe` flushes existing transport queues and clears retry timers.
- replay/screen-repair pending queues still work with transport queue.

## 검증 명령

```powershell
npm --prefix server test
```

## 롤백

- Set `stabilityModes.headlessQueueMode = 'observe'`.
- `observe` preserves the default rollout mode but does not permit unbounded pending output; overflow still follows the configured `degrade-headless` policy.
- Set `stabilityModes.wsSendMode = 'direct'` for full legacy fallback, or `safe-send-observe` when only telemetry should remain.
- Keep unified `/ws` transport.

## 완료 조건

- `pendingOutputChunks: string[]` and `Array.shift()` are gone from hot path.
- Degrade path does not `join()` an unbounded pending array.
- All server WS sends pass through one send policy.
- Slow clients cannot grow unbounded server memory.

## 구현 결과

- `server/src/utils/boundedByteDeque.ts`와 `server/src/utils/headlessOutputQueue.ts`를 추가했다.
- `SessionManager`의 headless pending output은 bounded queue와 pending map/counter 기반으로 전환했다.
- bounded 모드 overflow는 headless를 degrade하고 bounded state를 비운다.
- observe 모드도 overflow telemetry를 기록한 뒤 headless를 degrade해 pending output이 unbounded로 커지지 않게 한다.
- healthy path에서는 headless write commit 이후 `routeSessionOutput()`을 호출해 `screenSeq` 의미를 유지한다.
- `WsRouter`의 server-side send는 `sendTo()` -> transport policy -> raw sink 한 곳으로 통합했다.
- high-water에서는 per-client transport queue에 적재하고 retry timer로 drain한다.
- hard limit이나 enforce-mode send error는 session이 아니라 해당 WebSocket client만 1013 close한다.
- direct/observe 모드 send callback error는 telemetry와 warning만 남기고 강제 close하지 않는다.
- enforce 모드에서 direct/observe로 rollback할 때 기존 transport queue를 flush하고 retry timer를 제거한다.

## 검증 결과

- `npm --prefix server test`: 287 tests passed.
- `git diff --check`: target Wave4 files passed.
- 직접 송신 검색: server WebSocket raw `ws.send()`는 `WsRouter` transport raw sink 한 곳만 남음.
- 서브에이전트 PH-003 최종 리뷰: `No findings`.
