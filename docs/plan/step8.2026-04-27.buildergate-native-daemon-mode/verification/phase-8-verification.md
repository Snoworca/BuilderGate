# Phase 8 검증: 문서와 최종 회귀

## 검증 대상

- `FR-8-016`
- `AC-8-015`
- `TEST-8-018`
- `TEST-8-001`부터 `TEST-8-023` 전체 최종 회귀

## 필수 검증

- [ ] root README와 `dist/bin/README.md`에 `--foreground`, `--forground`, `BuilderGateStop`, `config.json5`, `QR`, `dist/bin`, `native daemon` 또는 `네이티브 데몬` 포함
- [ ] production 실행 문서에 `pm2`, `PM2`, `pm2 start`, `pm2 stop`, `pm2 delete`, `npm install -g pm2` 금지 패턴 없음
- [ ] source production 기본 daemon과 foreground 사용법 문서화
- [ ] packaged 기본 daemon과 stop utility 사용법 문서화
- [ ] TOTP daemon QR preflight 문서화
- [ ] 최종 smoke와 회귀 테스트 결과 기록

## 완료 판정

사용자가 README만 보고 build/run/foreground/stop/config/QR 정책을 이해할 수 있고, SRS traceability가 100%여야 한다.
