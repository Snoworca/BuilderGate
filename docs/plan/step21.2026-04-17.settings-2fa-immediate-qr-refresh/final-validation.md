# Final Validation

## 기능 완료 체크

- [ ] 2FA enable 저장 직후 QR image가 같은 화면에 나타난다
- [ ] issuer 저장 직후 QR URI와 image가 즉시 갱신된다
- [ ] accountName 저장 직후 QR URI와 image가 즉시 갱신된다
- [ ] 2FA disable 저장 직후 QR image가 즉시 제거된다
- [ ] warning + `registered=false` 상태가 즉시 드러난다

## 백엔드 검증

- [ ] `totpService` hot apply helper가 구현되었다
- [ ] save 성공/rollback 경로에서 TOTP runtime 반영이 일관된다
- [ ] login 및 `/api/auth/totp-qr`가 최신 runtime을 본다

## 프런트 검증

- [ ] mount/save QR fetch 경로가 공용 helper로 정리되었다
- [ ] save success 후 QR refresh가 중복 없이 수행된다
- [ ] warning/error/unregistered 문구가 충돌 없이 표시된다

## 테스트 검증

- [ ] `server npm run test` 통과
- [ ] `frontend npm run build` 통과
- [ ] Playwright 또는 동등한 UI 회귀 검증 통과
- [ ] `https://localhost:2002` 수동 검증 통과

## 문서 검증

- [ ] README 2FA 설명이 최신 동작과 일치한다
- [ ] Settings UI 문구와 plan/verification 문구가 일치한다

