# 최신 핸드오프

`C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-09-07-remaining-work-execution-plan.md` — 2026-09-07 작성 · 2026-09-08 검증·개정 · 목표: 남은 작업 세 갈래(A: S5-c0 ACK 도메인 전환, B: 회귀 스위트 복구, C: 설정 정리)의 전체 실행 계획. 각 작업에 When/Then 과 테스트 실행 방법이 붙어 있다.

**§0 부터 순서대로 읽을 것.** 상태 확인 → 선행 세션 잔여물 확인 → SRS 확인 → A-0 착수다. `HEAD` 가 `8d3991d` 가 아니면 §9.0 의 grep 8개로 앵커를 먼저 재측정한다.

**§2.3 이 중요하다** — 백로그 계획서(`docs/plan/2026-09-01.remaining-work-backlog.plan.md`)의 A1~A4·C1·C3·B1 은 이미 해소되었는데 문서가 갱신되지 않았다. 그 문서를 출발점으로 삼으면 끝난 일을 다시 한다.

관련 문서:

- 근거 조사: `C:\Work\git\_Snoworca\ProjectMaster\docs\research\2026-09-05.remaining-work-and-dead-settings-survey.md`
- 직전 핸드오프(S5-c0 상세): `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-09-05-s5-c0-ack-domain.md` — 작업 #1 은 커밋 `808d3fb` 로 완료. §5 "확정된 결정" 을 함께 읽을 것
- 설정 결함 이슈: `Snoworca/BuilderGate` #32~#36
