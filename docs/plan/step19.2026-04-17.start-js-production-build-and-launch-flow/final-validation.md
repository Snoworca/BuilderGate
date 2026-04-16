# Final Validation

## 완료 게이트

- [ ] Phase 1 완료 및 검증 통과
- [ ] Phase 2 완료 및 검증 통과
- [ ] Phase 3 완료 및 검증 통과
- [ ] Phase 4 완료 및 검증 통과

## 기능 게이트

- [ ] `node build.js` 성공
- [ ] `node start.js` 실행 시, CLI/config 없으면 `2222`로 기동
- [ ] `node start.js --port 2002` 성공
- [ ] `https://localhost:2002/health` 성공
- [ ] `https://localhost:2002/`가 앱 진입점을 반환
- [ ] `/api`, `/health`, `/ws` 회귀 없음

## 품질 게이트

- [ ] dev.js 개발 경로 유지
- [ ] root `dist` 또는 중복 server entrypoint 미도입
- [ ] staging delete/copy 안전성 확보
- [ ] 문서와 실제 실행 흐름 일치

## 후속 후보

- [ ] runtime path normalization helper 도입 여부 재평가
- [ ] opt-in production Playwright config 추가 여부 재평가
- [ ] root package.json script 도입 여부 재평가
