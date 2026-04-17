# Final Validation

## 범위

- `@xterm/headless` 기반 서버 권위 터미널 상태 전환
- refresh/reconnect/workspace switch 복구
- alt-screen/TUI
- geometry ownership
- performance/observability/rollback

## 입력 기준

- [00.index.md](./00.index.md)
- [00-1.architecture.md](./00-1.architecture.md)
- [00-2.tech-decisions.md](./00-2.tech-decisions.md)
- [integration-test-guide.md](./integration-test-guide.md)

## 최종 승인 체크리스트

- [ ] Phase 1 PoC 결과가 `go` 상태다
- [ ] serializer feasibility 가 문서와 코드에서 일치한다
- [ ] geometry lease 정책이 구현/테스트에 반영된다
- [ ] `screen-snapshot` 프로토콜이 `history` 권위 경로를 대체한다
- [ ] local snapshot 은 권위 경로에서 제거된다
- [ ] alt-screen/TUI smoke 가 통과한다
- [ ] perf budget 수치와 실제 측정 결과가 기록된다
- [ ] diagnostics endpoint 와 경고 기준이 구현된다
- [ ] rollback drill 이 문서대로 통과한다

## 품질 요약

| 기준 | 목표 |
| --- | --- |
| Plan-Code 정합성 | 100% 매핑 |
| 테스트 커버리지 | server runtime 중심 80% 이상 |
| 운영 가능성 | metrics + rollback + drill |
| 구조 일관성 | server authoritative model 유지 |

## 남겨둘 수 있는 잔여 리스크

- experimental API 버전 변화
- shell별 미세한 control sequence 차이
- 고부하 session-count 상한의 실제 하드웨어 의존성

## 종료 조건

모든 phase 검증 문서가 채워지고, `review-summary.md` 의 최종 등급이 모두 `A+` 이면 계획 단계는 완료다.
