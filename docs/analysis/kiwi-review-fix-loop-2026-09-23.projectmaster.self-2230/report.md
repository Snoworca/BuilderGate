# kiwi-review-fix-loop self-2230 — 파일 조작 서버(fx-step2)

- 범위: `a9aed374..HEAD` 의 fileJobs·fileJobRoutes·pathValidator·FileService·index·ws-protocol 두 사본
- 라운드: 리뷰 3회(까칠 리뷰어 Opus) · 수정 3회(시니어 fixer Opus, 테스트 선행)

| 라운드 | 발견 | 심각도 | 결과 |
|---|---|---|---|
| 1 | FND-001..007 | CRITICAL 1 · HIGH 1 · MEDIUM 2 · LOW 3 | 전부 수정 |
| 2 | RCK-001..008 | MEDIUM 2 · LOW 6 | 전부 수정 |
| 3 | RC2-001..003 | MEDIUM 1 · LOW 2 | 전부 수정 |

## 핵심 결함
- FND-001: 상대 경로가 세션 cwd 로 검증되고 서버 cwd 로 실행 — `server/config.json5` 삭제 재현
- FND-002: 작업 중 터미널 `cd` 로 작업 실패
- FND-003: blocked 자손(`.ssh`) 이 rename 으로 목적지에 유출
- RCK-001: 링크인 세션 cwd 삭제가 대상 트리를 지움
- RCK-002: 거부 질문의 '모두 건너뛰기' 가 디스크 오류(ENOSPC)를 조용히 삼킴
- RC2-002: REST `DELETE path=.` 이 프로젝트 전체 삭제(선재)

## 회귀
- Windows `npx tsx --test` 20 파일, 213+ 케이스, 0 fail. server tsc 0, frontend tsc -b 0

## 잔여(보고만)
- 복사 하강은 재-lstat 없음(삭제·이동만)
- 트래버스 전용 부모에서 세션 루트 자체 복사는 403
- 링크를 따라간 복사의 progress.currentPath 는 접두사 매핑 밖
- 링크 cwd 복사 시 사본 폴더명은 대상 이름

## SRS
- AC 추가: FR-FOP-001(6~8) · FR-FOP-002(6) · FR-FOP-004(8) · FR-FOP-005(9·10) · IR-FOP-001(8·9) · SEC-FOP-001(7·8), IR-FOP-002 AC-3·4 보강
- implemented → verified: FR-FOP-001..005, IR-FOP-001, IR-FOP-002. SEC-FOP-001 은 AC-3~5(프런트) 대기로 in_progress
- validate --fail-on-warning: 0 errors / 0 warnings
