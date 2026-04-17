# Review 1: 런타임 / 아키텍처 평가

## 1차 평가

등급: `A-`

초기 지적:

- geometry ownership 이 아키텍처에는 있었지만 phase task 와 test 에 충분히 퍼지지 않았다.
- serializer feasibility 실패 시 전체 migration 을 어떻게 중단할지 exit criterion 이 약했다.
- degraded mode 의 live output 우선 원칙이 테스트 문서에 충분히 반복되지 않았다.

## 반영한 개선

- Phase 2, 4 에 geometry lease 와 stale owner test 를 명시적으로 추가했다.
- Phase 1 에 `go / hold / redesign` 게이트를 추가했다.
- ADR-1406 과 Phase 2 테스트에 degraded mode 원칙을 고정했다.

## 2차 평가

등급: `A+`

판정 근거:

- 서버 런타임 책임과 WS transport 책임 분리가 명확하다.
- geometry owner, ACK barrier, degraded mode 가 모호하지 않다.
- 현재 코드 수정 지점이 `SessionManager`, `WsRouter`, `TerminalContainer`, `TerminalView` 로 구체적으로 매핑된다.
