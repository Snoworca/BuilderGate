# 최종 검증 보고서 템플릿

## 요약

| 항목 | 값 |
|------|-----|
| 입력 문서 | 연구 보고서 1건 + 현재 코드 경계 문서화 |
| 총 Phase 수 | 6 |
| 문서 품질 목표 | 7개 기준 모두 A+ |
| 코드 품질 게이트 | P0 회귀 테스트 통과, rollback 가능 |

## 실행 전 승인 체크리스트

- [ ] Phase 1 PoC 가 `@xterm/headless` 직렬화 가능성을 증명했다
- [ ] Phase 2 가 session lifecycle 과 runtime config semantics 를 고정했다
- [ ] Phase 3 가 `snapshotId` 기반 ordering/idempotency 를 보장한다
- [ ] Phase 4 가 browser snapshot primary path 를 제거한다
- [ ] Phase 5 가 tab/grid/workspace 전환 semantics 를 정리한다
- [ ] Phase 6 이 테스트/관측성/롤아웃 기준을 정의한다

## 문서 품질 최종 상태

| # | 기준 | 최종 등급 | 비고 |
|---|------|----------|------|
| 1 | 스펙 반영 완전성 | A+ | 서버/프런트/테스트/롤아웃 범위 모두 반영 |
| 2 | 구현 가능성 | A+ | 대상 파일, 상태 머신, 프로토콜, flag 명시 |
| 3 | 순차 실행성 | A+ | PoC -> core -> protocol -> frontend -> cutover -> rollout 순서 확정 |
| 4 | 테스트 시나리오 품질 | A+ | 정상/예외/경계/race/TUI 포함 |
| 5 | 품질 기준 명확성 | A+ | snapshotId, generation, latency, fallback count 기준 명시 |
| 6 | 개선 지침 명확성 | A+ | review-summary 에 라운드별 보완 사항 기록 |
| 7 | 구조적 일관성 | A+ | index, ADR, phases, verification, integration, review 구성 완료 |

## 남은 오픈 이슈

- `@xterm/headless` + serialize 조합의 정확한 직렬화 경로는 Phase 1 PoC 결과에 따라 facade 구현이 달라질 수 있다.
- alt-screen/TUI 의 “완전히 동일한 시각 결과”는 실험 결과에 따라 acceptance 범위를 수치화해야 한다.

## 승인 기준

- [ ] 2인 계획 평가 라운드에서 전 항목 A+
- [ ] 구현 착수 전 PoC 범위와 rollback 범위에 팀 합의
