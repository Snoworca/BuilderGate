# Phase 4 검증: TOTP Daemon Preflight

## 검증 대상

- `FR-8-004`, `FR-8-005`
- `AC-8-004`, `AC-8-005`
- `TEST-8-009`, `TEST-8-010`, `TEST-8-011`, `TEST-8-023`

## 필수 검증

- [x] `twoFactor.enabled === true`일 때 daemon parent가 detach 전 QR/manual key 출력
- [x] secret이 없을 때와 이미 있을 때 모두 QR/manual key/issuer/accountName 출력
- [x] app child와 preflight가 같은 `TOTP_SECRET_PATH` 사용
- [x] daemon app child에서 QR 중복 출력 없음
- [x] foreground mode에서는 QR suppress 없음
- [x] corrupted secret은 startup failure이며 app/sentinel orphan 없음
- [x] initial startup fatal과 settings hot-swap warning 정책이 분리됨

## 로그/보안 검증

- [x] daemon log에 shutdown token, JWT, password, OTP code가 없음
- [x] TOTP secret 평문은 요구된 parent console manual key 외 log file에 남지 않음

## 완료 판정

QR preflight가 사용자 콘솔에서 관측 가능하고, child duplicate QR이 없어야 한다.

## 자동 검증 결과

- `npm run test:daemon`: 60 tests passed
- `Push-Location server; npm test; Pop-Location`: 155 tests passed
- 코드 리뷰어 서브에이전트 재검토: `No findings`
