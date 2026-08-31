# SDS: AC-6 server ACK fault browser evidence

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.ac6-server-ack-fault-e2e |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

AC-6은 invalid ACK가 credit을 늘리지 않고 observable protocol error가 되는 것을 요구한다.
기존 browser test는 server rejection frame을 주입해 실제 client-to-server ingress를 증명하지 못한다.
이 step은 parent requirement를 수정하지 않는 새 test-evidence capability만 구현한다.
Browser probe는 test-owned socket 하나이며 user workspace, terminal, process를 사용하지 않는다.

## 2. Goals / Non-goals

- Goal: browser가 실제 `wss://localhost:2222/ws`로 invalid ACK를 보내고 server rejection을 받는 경계를 증명한다.
- Goal: active fair ledger에서 invalid ACK가 credit을 바꾸지 않는 router contract를 test-first로 증명한다.
- Non-goal: workspace/session REST 생성·삭제, terminal command/PTY 실행, app socket interception, server-frame injection.
- Non-goal: `PERF-BGSTAB-010` 본문 AC·Status·Verification Evidence 또는 production protocol 변경.

## 3. Architecture Decisions

- **Decision**: authenticated native browser WebSocket probe를 사용한다 / basis: `WsRouter`의 실제 ACK ingress와 rejection을 보존한다 / trade-off: UI automatic-ACK path는 검증하지 않는다 / rejected: active-or-first workspace 재사용과 injected server frame.
- **Decision**: browser probe와 router credit contract를 분리한다 / basis: credit은 browser wire에서 관측 불가하다 / trade-off: 두 test 축이 필요하다 / rejected: browser assertion만으로 ledger 값을 추론.
- **Decision**: production endpoint/seam을 추가하지 않는다 / basis: existing capability admission과 `WsRouter` ACK handler가 충분하다 / trade-off: probe가 handshake를 명시적으로 수행한다 / rejected: test-only server API.

## 4. Interfaces

- `openAc6BrowserAckProbe(page): Promise<Ac6Probe>` — test-owned WSS socket을 열고 capability admission, invalid ACK, withdraw/close를 수행한다.
- `Ac6Probe.sendUnknownLaneAck(): Promise<AckRejectedFrame>` — fresh probe identity의 invalid ACK에 대한 actual server rejection만 반환한다.
- `WsRouterSendPriority` ACK contract — active fair lane의 duplicate/stale/unknown/out-of-order/over-ACK가 `creditedBytes: 0`와 unchanged credit을 보장한다.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the isolated browser probe opens its sole authenticated WSS socket THE SYSTEM SHALL use only `wss://localhost:2222/ws`, capability and ACK frames, and no workspace mutation, active/first selector, terminal command, frame injection, or app-socket interception.
- SDS-AC-2: WHEN the probe sends an unknown-lane ACK after actual capability acceptance THE SYSTEM SHALL return an actual `terminal-delivery:ack-rejected` frame with the same session, epoch, sequence, and `ACK_UNKNOWN_LANE` reason.
- SDS-AC-3: WHEN an invalid ACK is applied to an active fair-delivery lane THE SYSTEM SHALL return `accepted:false`, `creditedBytes:0`, emit its rejection frame, and preserve the lane credit value.
- SDS-AC-4: WHEN the browser assertion completes or fails THE SYSTEM SHALL withdraw capability and close only the probe socket without creating, selecting, mutating, or deleting a workspace/session.
- SDS-AC-5: WHEN the new browser evidence source is evaluated THE SYSTEM SHALL fail if it contains historical authority-writer helpers, workspace mutation requests, server-message injection, route interception, retries, or multiple workers.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | frontend/tests/unit/perfBgstab010Ac6ServerAckFaultContract.test.ts | Static source guard for isolated probe boundaries. |
| SDS-AC-2 | frontend/tests/e2e/perf-bgstab-010-ac6-server-ack-fault.spec.ts | Actual browser WSS capability, invalid ACK, and exact rejection frame. |
| SDS-AC-3 | server/src/ws/WsRouterSendPriority.test.ts | Active ledger invalid ACK preserves credit and emits rejection. |
| SDS-AC-4 | frontend/tests/e2e/perf-bgstab-010-ac6-server-ack-fault.spec.ts | `finally` withdraw/close only the probe socket. |
| SDS-AC-5 | frontend/tests/unit/perfBgstab010Ac6ServerAckFaultContract.test.ts | Guard exact test command and disallowed helper/mutation patterns. |

## 7. Open Questions

- (none — harness architecture was approved by the three-person decision committee.)
