# T-PH003-04 Terminal restore GREEN 통합 완료 보고

- Requirement: `REL-BGSTAB-009`
- Task: `T-PH003-04`
- 판정: 완료
- 독립 최종 재리뷰: `No findings`

## 결과

기존 visible recovery coordinator를 유지하면서 TerminalView, TerminalContainer, WebSocket grace와 서버 atomic restore authority를 generation-safe 단일 흐름으로 통합했다. 서버는 moving headless-write tail이 quiet window까지 안정된 뒤 atomic snapshot을 만들며, fresh replay는 replay token과 repair token의 이중 소유권으로만 supersede된다.

클라이언트는 live-lane idle, authoritative snapshot, parser tail, sequence-proven held tail, ACK와 matching ready가 모두 끝난 뒤에만 입력을 연다. deterministic apply/write/probe 실패와 stuck authority는 세션 범위의 bounded fresh/reconnect budget으로 수렴하며, budget은 같은 connection/replay/sequence의 ACK+ready 이후에만 초기화된다.

새 연결에서는 구 socket의 grace buffer를 폐기한다. 출력이 변하지 않아 snapshot 내용과 sequence가 같더라도 recovery barrier 아래의 새 connection/replay authority는 duplicate 최적화를 우회하고, 기존 speculative terminal write 뒤에 authoritative mutation으로 직렬화된다. Restore terminal outcome은 기존 screen-repair in-flight 억제도 종료하므로 같은 geometry의 다음 복구가 다시 전송된다.

## 검증

- server restore/metadata/partial-tail actual integration: 11/11 PASS
- server full regression: 517/517 PASS
- node-pty patcher: 1/1 PASS
- frontend targeted recovery unit: 102/102 PASS
- frontend typecheck/build: PASS
- HTTPS restore adapter: 2/2 PASS
- 독립 까칠 리뷰: 여러 재현 finding을 수정한 뒤 최종 `No findings`
- diff check: PASS

`https://localhost:2222`의 grid current-server 검증은 실행 중 backend가 `C:\Work\agent-tools\builder-gate\server\dist` 구버전인 환경 차이 때문에 current protocol을 실행하지 못한다. AGENTS 규칙에 따라 실행 중 서버와 node 프로세스를 종료·재시작하지 않았다. current server source의 실제 WebSocket/PTY 경로는 named-pipe 통합 11/11로 대체 검증했으며, 이 예외를 숨기지 않고 evidence에 남겼다.

프런트 task-scoped lint의 4 errors/2 warnings는 기존 `WebSocketContext` 기준선과 동일하며 신규 finding은 없다.

Verification: Tier 2 automated checks and sub-agent review completed.
