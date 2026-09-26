# kiwi-srs-feasibility — code-editor

- run-id: 2026-09-26.projectmaster.code-editor.v01
- target: code-editor (10 REQ, 전부 planned / evolving)
- 모드: --auto, 정책 `.kiwi/feasibility-policy.yaml` (medium → evolving)
- 종합 판정: **conditionally-ready** — 블로커 0, 의존 순환 0

## Feasibility

| REQ | 점수 | 판정 | stability |
|---|---|---|---|
| IR-MDE-002 | 98 | high | evolving 유지 |
| FR-MDE-016 | 89 | high | evolving 유지 |
| IR-MDE-003 | 89 | high | evolving 유지 |
| FR-MDE-014 | 88 | high | evolving 유지 |
| FR-MDE-015 | 87 | high | evolving 유지 |
| FR-MDE-013 | 85 | high | evolving 유지 |
| SEC-MDE-001 | 84 | high | evolving 유지 |
| FR-MDE-017 | 81 | high | evolving 유지 |
| FR-MDE-018 | 77 | medium | evolving 유지 |
| FR-MDE-019 | 76 | medium | evolving 유지 |

축 점수 합과 라벨 임계는 산술 검사로 일치를 확인했다(`per-req-judgement.json`).

## Stability 변경

적용 0 / no-op 10. 모든 제안값이 현재값(evolving)과 같다. 검증 증거가 없어 stable 승급 대상은 없다.

## 판정 조건으로 고친 SRS 결함 (별도 CLI mutation)

- FR-MDE-013 AC-3·AC-4: 닫힌 목록이 아니었고(연구 문서가 '등'·'표준 확장자'), 파일명 표를 언어 없는 모드로 만드는 AC-4 가 3.4절과 모순 → 단위 테스트로 검증 가능한 형태로 수정
- FR-MDE-015 AC-3: 섞인 줄바꿈의 소수 종류를 정규화하지 않음으로 명확화
- FR-MDE-017 AC-2: JSONL 은 jsonParseLinter 를 쓰지 않음
- FR-MDE-014 AC-3: 줄 바꿈 선호 저장 위치(localStorage 전역)
- 누락 trace 추가: 의존 8건, 복원 경로(useEditorWindows.ts:866-882) 2건, 코드 trace 2건

## 구현 시 주의 (판정 조건)

- FR-MDE-018 이 가장 크다: 문서 모델이 텍스트 전용(`bodyAtOpen`)이라 이미지 문서 종류가 상태·영속화·저장 컨트롤러를 모두 통과해야 한다.
- IR-MDE-003: `readFile` 의 경로 검증·차단 확장자·stat 단계를 분리해야 하고(바이너리 거절이 그 뒤에 있음), `MIME_TYPES` 에 svg 외 이미지 형식이 없다.
- FR-MDE-015 는 벤더링된 편집기 두 곳(:363, :472)을 고친다 — 벤더 차이로 기록할 것.
- FR-MDE-013 은 verified 인 FR-FEX-011 의 판정 출처를 바꾸므로 그 요구사항을 재검증해야 한다.
- SEC-MDE-001 AC-5 의 sandbox CSP 는 helmet 이후 라우트에서 전역 헤더를 덮어써야 한다.

## 평가 단계

Phase 5 독립 평가자는 돌리지 않았다. 변경 0건이고 최저 점수(76)가 low 임계(60)와 16점 떨어져 라벨이 바뀌어도 결과가 같다. 저장소 방침(리뷰는 실제 기능 결함이 있을 때만 추가)에 따른 생략이다.

## 다음 단계

- 구현 권장 순서: FR-MDE-015 → IR-MDE-002 → FR-MDE-016 (지금 마크다운 편집에서도 파일이 변형되는 문제) → FR-MDE-013 → FR-MDE-014 → FR-MDE-017 → IR-MDE-003 → SEC-MDE-001 → FR-MDE-018 → FR-MDE-019
- `/kiwi-planner` 로 계획 수립
