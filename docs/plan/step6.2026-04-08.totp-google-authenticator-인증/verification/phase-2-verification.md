# Phase 2 검증: TOTPService

## 검증 체크리스트

- [ ] `TOTPService.ts` 파일 생성 확인
- [ ] `data/totp.secret` 없을 때 서버 기동 → 파일 자동 생성
- [ ] 생성된 파일 내용이 `enc(...)` 포맷인지 확인
- [ ] 서버 재시작 후 `data/totp.secret` 내용이 동일한지 확인 (secret 재사용)
- [ ] QR 코드 아스키아트 콘솔 출력 확인
- [ ] "Manual entry key: ..." 출력 확인
- [ ] `isRegistered()` 반환값 = `true` (파일 있을 때)
- [ ] Linux에서 파일 권한 `0o600` 확인 (`ls -la data/totp.secret`)
- [ ] 손상된 secret 파일로 시작 시 서버 중단 + 오류 메시지 확인
- [ ] `destroy()` 호출 후 `secret` null 확인
