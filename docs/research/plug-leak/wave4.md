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
- active pump count.
- overflow/degrade count.
- WS current/max `bufferedAmount`.
- queued/coalesced bytes/messages.
- slow-client close count.
- send callback error count.

## 테스트 계획

Server tests:

- delayed headless write cannot grow beyond byte cap.
- chunk cap is enforced.
- multibyte output uses UTF-8 byte length.
- overflow degrades headless, clears queue, records telemetry.
- healthy output remains ordered after headless commit.
- direct `ws.send()` paths are removed or covered by `safeSend`.
- high-water queues output.
- hard-limit closes slow client.
- send callback error records telemetry and closes client.
- replay/screen-repair pending queues still work with transport queue.

## 검증 명령

```powershell
npm --prefix server test
```

## 롤백

- Set `stabilityModes.headlessQueueMode = 'observe'`.
- Set `stabilityModes.wsSendMode = 'direct'` for full legacy fallback, or `safe-send-observe` when only telemetry should remain.
- Keep unified `/ws` transport.

## 완료 조건

- `pendingOutputChunks: string[]` and `Array.shift()` are gone from hot path.
- Degrade path does not `join()` an unbounded pending array.
- All server WS sends pass through one send policy.
- Slow clients cannot grow unbounded server memory.
