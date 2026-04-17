# Integration Test Guide

## 대상

- Settings 페이지 2FA 저장 직후 QR 즉시 갱신
- Backend `totpService` hot apply
- `/api/auth/totp-qr`와 login 흐름의 최신 runtime 반영

## 공통 환경

- 검증 URL: `https://localhost:2002`
- 테스트 계정 비밀번호: `1234`
- 브라우저는 인증된 상태로 Settings 페이지에 진입한다

## 서버 회귀 테스트

### 1. server test-runner

```powershell
cd server
npm run test
```

확인 포인트:

- Settings save 시 TOTP runtime callback 호출
- enable/disable/reconfigure lifecycle
- warning + unregistered state handling

## 프런트 회귀 테스트

### 2. Playwright

```powershell
cd frontend
npx playwright test
```

최소 포함 시나리오:

- Settings에서 2FA enable 저장 후 QR image가 즉시 보인다
- issuer 또는 accountName 저장 후 URI가 즉시 바뀐다
- disable 저장 후 QR이 즉시 사라진다

## 수동 검증 매트릭스

### Case A: 비활성 -> 활성

1. Settings 페이지 진입
2. `Enabled` 체크
3. `Save Settings`
4. 기대 결과:
   - 페이지 이동 없음
   - QR image 표시
   - URI 텍스트 표시

### Case B: issuer 변경

1. 2FA가 활성화된 상태에서 `Issuer` 값 변경
2. 저장
3. 기대 결과:
   - QR image가 새 값 기준으로 갱신
   - URI 문자열에 새 issuer 반영

### Case C: accountName 변경

1. `Account name` 변경
2. 저장
3. 기대 결과:
   - QR URI label이 즉시 갱신

### Case D: 활성 -> 비활성

1. `Enabled` 체크 해제
2. 저장
3. 기대 결과:
   - QR image 제거
   - 비활성 상태 안내 문구 표시

### Case E: 손상된 secret

1. `server/data/totp.secret`를 손상된 값으로 준비
2. Settings에서 2FA enable 또는 metadata save
3. 기대 결과:
   - save 응답 warning 노출
   - QR image 없음
   - unregistered 안내 문구 표시

## 실패 시 점검 순서

1. `/api/auth/totp-qr` 응답 상태 확인
2. `index.ts`의 `totpService` 재구성 helper 호출 여부 확인
3. `SettingsService.applyRuntimeConfig()` warning/rollback 경로 확인
4. `SettingsPage` save success 후 QR helper 재호출 여부 확인

