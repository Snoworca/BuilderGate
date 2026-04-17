# Review 2: 테스트 / 롤아웃 / 운영 평가

## 1차 평가

등급: `B+`

초기 지적:

- 성능 예산은 있었지만 운영 알림 기준과 rollback drill 이 충분히 분리되지 않았다.
- shadow 모드의 mismatch 수집 목적이 phase 문서에 명확히 드러나지 않았다.
- 메트릭 공개 범위와 public `/health` 분리 원칙이 index 수준에서만 설명됐다.

## 반영한 개선

- Phase 5 에 metrics, alerts, authenticated diagnostics 를 별도 checklist 로 분리했다.
- Phase 6 에 shadow mismatch, canary, shell-specific override, rollback drill 을 추가했다.
- ADR-1410 으로 `/health` 와 diagnostics endpoint 분리 결정을 고정했다.

## 2차 평가

등급: `A+`

판정 근거:

- perf, memory, rollback, observability 가 모두 수치 또는 명시적 단계로 문서화됐다.
- shadow -> primary -> rollback 경로가 구현 가능 수준으로 분해됐다.
- 운영자가 실제로 무엇을 보고 승인/차단하는지 문서가 선명하다.
