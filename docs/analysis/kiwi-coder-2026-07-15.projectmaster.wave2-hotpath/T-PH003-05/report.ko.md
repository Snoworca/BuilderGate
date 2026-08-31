# T-PH003-05 Restore fault E2E·Phase 리뷰 완료 보고

- Requirement: `REL-BGSTAB-009`
- Task: `T-PH003-05`
- 판정: 완료
- 독립 최종 재리뷰: `No findings`

## 결과

Phase 3의 bounded remount restore를 SRS AC-1~AC-10과 다시 대조하고, 리뷰에서 발견된 복구 교착·ACK 실패·parser authority·FIFO proof race를 모두 회귀 테스트로 고정한 뒤 수정했다.

특히 유실된 xterm callback의 empty FIFO proof는 probe 시작 시점의 scheduler owner, generation, write token에만 적용된다. 이미 제출된 active slice만 settle하며 아직 제출하지 않은 suffix는 보존·재개한다. Probe 도중 다음 write로 advance되면 그 write의 실제 callback과 idle barrier를 기다리므로 snapshot writer와 live writer가 겹치거나 tail이 유실되지 않는다.

일반 snapshot과 legacy repair의 ACK 송신 실패는 success completion으로 진행하지 않고 terminal을 stale로 유지한 채 bounded reconnect로 수렴한다. Headless degrade는 pending output까지 partial-escape authority에 반영하며 parser tail overflow는 이후 평문 출력으로 해제되지 않는다.

## 검증

- server dedicated actual WebSocket/PTY/metadata/partial-tail: 13/13 PASS
- server full regression: 517/517 PASS
- frontend targeted recovery: 110/110 PASS
- frontend full unit: 325/325 PASS
- frontend typecheck/build: PASS
- HTTPS restore adapter: 2/2 PASS
- scoped diff check: PASS
- 같은 까칠한 reviewer의 반복 리뷰 최종 판정: `No findings`

전체 lint의 42 errors/18 warnings는 기존 저장소 기준선이다. `grid-equal`의 current-server 검증은 실행 중 backend가 `C:\Work\agent-tools\builder-gate\server\dist` 구버전이고 AGENTS 규칙상 재시작할 수 없어 환경 예외로 남겼다. 현재 server source의 실제 경로는 named-pipe 통합 13/13으로 대체 검증했다.

Verification: Tier 2 automated checks and sub-agent review completed.
