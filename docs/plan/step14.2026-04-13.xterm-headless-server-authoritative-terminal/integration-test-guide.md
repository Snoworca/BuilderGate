# Integration Test Guide

## 목적

`@xterm/headless` 기반 서버 권위 터미널 상태가 실제 사용자 흐름에서 기존 replay/local snapshot 방식보다 더 정확하고 운영 가능하다는 것을 검증한다.

## 입력 문서

- `docs/report/2026-04-13.workspace-switch-scrollback-root-cause.md`
- `docs/report/2026-04-13.server-side-terminal-emulation-research.md`
- `docs/plan/step13.2026-04-13.backend-canonical-replay-buffer/*`

## 테스트 계층

### 1. 단위 테스트

- `HeadlessTerminalRuntime`
- `GeometryLeaseManager`
- snapshot serializer / cache invalidation
- protocol revision / ACK timeout

### 2. 서버 통합 테스트

- `SessionManager + WsRouter + fake ws + fake pty`
- duplicate subscribe, stale ACK, reconnect during output burst
- resize ownership transfer

### 3. 프런트 통합 테스트

- `WebSocketContext` 의 `screen-snapshot` 라우팅
- `TerminalContainer` 의 snapshot apply / fallback disable
- `TerminalView` 의 replace/clear/flush ordering

### 4. E2E / 운영 테스트

- refresh restore
- workspace switch
- grid/tab 모드 전환
- long output + reconnect
- TUI smoke
- shadow/primary rollback drill

## 핵심 E2E 시나리오

### 시나리오 A: refresh restore

Given 긴 PowerShell scrollback 이 쌓여 있고 primary 모드일 때  
When 브라우저를 새로고침하면  
Then 서버 `screen-snapshot` 기준으로 동일 화면이 복원되어야 한다

### 시나리오 B: reconnect during output burst

Given 대량 출력 중 연결이 끊겼을 때  
When WS 가 재연결되면  
Then `screen-snapshot -> screen-ready -> queued output` 순서가 지켜져야 한다

### 시나리오 C: alt-screen TUI

Given full-screen TUI 가 실행 중일 때  
When reconnect 또는 새 subscribe 가 발생하면  
Then prompt tail 이 아니라 현재 alt-screen 상태가 복원되어야 한다

### 시나리오 D: geometry owner transfer

Given 두 클라이언트가 같은 세션을 보고 있을 때  
When owner 가 바뀌고 새 owner 가 resize 를 보내면  
Then PTY/headless geometry 는 새 owner 기준으로만 바뀌어야 한다

### 시나리오 E: rollback drill

Given primary canary 에서 오류율이 상승했을 때  
When 운영자가 flag 를 shadow 로 내리면  
Then 이후 복구 경로는 구형 경로로 즉시 돌아가야 한다

## 통합 매트릭스

| 컴포넌트 | 검증 포인트 |
| --- | --- |
| `SessionManager` | raw output -> headless write -> snapshot dirty |
| `WsRouter` | `screen-snapshot` barrier, queued output, ACK timeout |
| `WebSocketContext` | 새 메시지 라우팅, stale revision 무시 |
| `TerminalContainer` | local snapshot 우선순위 제거 |
| `TerminalView` | clear/replace/flush 순서 |
| `TerminalMetricsService` | latency, bytes, degraded counters |

## 성능/운영 검증

- benchmark 1: 단일 세션 `10k` scrollback serialize p95
- benchmark 2: 10/25 concurrent sessions RSS + lag
- benchmark 3: burst output 중 reconnect
- drill 1: ACK timeout 강제
- drill 2: serializer failure 강제
- drill 3: primary -> shadow rollback

## 자동화 우선순위

1. 서버 통합 테스트
2. primary refresh/reconnect E2E
3. alt-screen smoke
4. benchmark harness
5. 운영 rollback drill

## 요구사항 추적

| 요구사항 | 테스트 |
| --- | --- |
| `FR-1401` | server runtime unit/integration |
| `FR-1402` | refresh/reconnect E2E |
| `FR-1403` | alt-screen smoke |
| `FR-1404` | geometry transfer integration |
| `FR-1405` | duplicate subscribe + stale ACK |
| `NFR-1401~1404` | benchmark harness |
| `OBS-1401~1402` | diagnostics endpoint tests |
| `OPS-1401` | shadow mismatch / rollback drill |
