# 통합 테스트 가이드

**프로젝트**: ProjectMaster  
**작성일**: 2026-04-13  
**버전**: 1.0.0  
**총 Phase 수**: 6

## 1. 통합 테스트 목적

- refresh/reconnect/grid remount/workspace switch 를 모두 서버 권위 snapshot 기반으로 검증한다.
- `output` 와 `screen:snapshot` 의 ordering race 를 자동화한다.
- Codex 같은 alternate-screen/TUI 환경에서 실제 복구 품질을 확인한다.

## 2. 핵심 E2E 시나리오

### 시나리오 1: refresh 후 권위 snapshot 복구

**우선순위**: CRITICAL  
**관련 Phase**: 2-3-4-5

- Given: 긴 출력과 현재 프롬프트가 있는 세션
- When: 브라우저를 새로고침한다
- Then: local snapshot 없이 서버 snapshot 으로 동일 세션이 복구된다

### 시나리오 2: reconnect 중 live output race

**우선순위**: CRITICAL  
**관련 Phase**: 3-4-6

- Given: snapshot 전송 직후 PTY live output 이 계속 발생한다
- When: 소켓이 재연결된다
- Then: snapshot 적용 전 live output 이 섞이지 않는다

### 시나리오 3: grid remount

**우선순위**: HIGH  
**관련 Phase**: 4-5

- Given: grid mode 에서 둘 이상의 pane 이 있고 하나가 긴 scrollback 을 갖는다
- When: pane 이 remount 되는 UI 전환을 수행한다
- Then: 서버 snapshot 기준으로 같은 화면 상태가 복구된다

### 시나리오 4: Codex/TUI alt-screen

**우선순위**: HIGH  
**관련 Phase**: 1-2-6

- Given: alternate-screen 기반 TUI 가 실행 중이다
- When: refresh 또는 reconnect 가 일어난다
- Then: alt-screen 여부와 화면 내용이 기대 범위로 복구된다

### 시나리오 5: rollback flag

**우선순위**: MEDIUM  
**관련 Phase**: 5-6

- Given: authoritative flag 를 끈다
- When: 앱을 실행한다
- Then: legacy 경로로 정상 동작하고 headless metrics 는 비활성화된다

## 3. 컴포넌트 통합 매트릭스

| 컴포넌트 A | 컴포넌트 B | 검증 항목 |
|-----------|-----------|----------|
| `SessionManager` | `HeadlessTerminalState` | output/resize/restart 동기화 |
| `SessionManager` | `WsRouter` | snapshot 조회, fallback mode |
| `WsRouter` | `WebSocketContext` | protocol routing, reconnect |
| `WebSocketContext` | `TerminalContainer` | ack/state machine |
| `TerminalContainer` | `TerminalView` | clear/apply/live write ordering |
| `App/MosaicContainer` | `TerminalContainer` | tab/grid/workspace remount semantics |

## 4. 실행 순서

1. server unit / test-runner
2. protocol race tests
3. frontend build
4. Playwright refresh/reconnect/grid/TUI suite
5. feature flag rollback suite

## 5. 통과 기준

- server tests: 100% pass
- protocol race tests: 100% pass
- Playwright P0 시나리오: 100% pass
- fallback count: 정상 경로에서 0
- ack latency: 정의한 임계치 이내

## 6. 회귀 차단 기준

- `screen:snapshot` 없이 복구가 성공한 것처럼 보이는 테스트는 금지
- poisoned local snapshot 이 다시 렌더되면 실패
- stale `snapshotId` ack 로 queued output 이 flush 되면 실패
- duplicate subscribe 로 snapshot 이 2회 이상 오면 실패
