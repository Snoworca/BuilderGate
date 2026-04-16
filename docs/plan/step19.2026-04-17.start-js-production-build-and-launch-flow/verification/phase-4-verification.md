# Phase 4 Verification

## 목적

문서와 smoke validation 절차가 실제 실행 흐름과 일치하는지 검증한다.

## 확인 항목

- [ ] README에 `node build.js` / `node start.js` 경로가 문서화된다
- [ ] default fallback 포트 `2222`가 문서화된다
- [ ] validation target이 `https://localhost:2002`로 일치한다
- [ ] manual smoke checklist가 health/root/login/session을 포함한다
- [ ] production smoke와 dev flow의 역할 구분이 명확하다
- [ ] Playwright 방향이 문서상 모순이 없다

## 증거

- README diff
- smoke guide
- Playwright decision note
