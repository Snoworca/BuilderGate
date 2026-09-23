# kiwi-review-fix-loop self-fx3 — 파일 탐색기 프런트엔드(fx-step3)

- 범위: `a9aed374..b53e5329` 의 frontend/src·tests/unit·file-explorer.spec.ts
- 라운드: 리뷰 2회(까칠 리뷰어 Opus) · 수정 2회(시니어 fixer Opus, 테스트 선행)

| 라운드 | 발견 | 심각도 | 결과 |
|---|---|---|---|
| 1 | FX3-001..011 | HIGH 3 · MEDIUM 3 · LOW 5 | 전부 수정 |
| 2 | FX3R-001..006 | MEDIUM 1 · LOW 5 | 전부 수정 |

## 핵심 결함
- FX3-001: submit 응답보다 먼저 온 실패 done 이 오류 없이 사라지고 잘라내기도 사라짐
- FX3-002: 결정 대기 중 탭·창을 닫으면 서버 작업이 10분 멈춤 → 닫을 때 결정 대기 작업 취소
- FX3-003: 10000 항목 잘라내기가 렌더마다 O(행×잘라낸 수) — 약 2.2초 정지
- FX3-004: 터미널 상태 변화마다 모든 탐색기 탭 재렌더·재정렬
- FX3-005: 삭제·이동한 경로가 선택에 남아 다시 조작됨
- FX3-006: 작업 소유권 경로에 동작 테스트 없음 → 순수 모듈 fileJobOwnership 추출
- FX3R-001: 200ms 디바운스 사이 탭 전환 시 마지막 행을 앵커로 저장(1라운드 수정의 회귀)

## 회귀
- 프런트 단위 1446/1445(선재 REL-BGSTAB-012 만), tsc -b 0, tsconfig.test 0

## 잔여(보고만)
- 결정 대기가 아닌 실행 중 작업은 창을 닫아도 계속 돌고, 그 뒤 결정은 서버 10분 제한으로 끝남 → fx-step4 PH-003 앱 전역 fileJobStore 에서 해결
- 브라우저 E2E 미실행(BUILDERGATE_PASSWORD 부재)
