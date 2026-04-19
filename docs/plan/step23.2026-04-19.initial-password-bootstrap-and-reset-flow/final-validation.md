---
name: Step23 Final Validation
description: Step23 최종 완료 게이트.
---

# Final Validation

## 자동 검증

- [x] server test-runner 전체 통과
- [x] bootstrap 관련 신규 서버 테스트 통과
- [x] frontend build 통과
- [x] bootstrap UX Playwright 통과

## 수동 검증

- [ ] `config.json5` 없음 -> empty password bootstrap 파일 생성 확인
- [ ] localhost 최초 접속 -> bootstrap form 노출
- [ ] 비밀번호 설정 성공 -> 즉시 인증 상태 진입
- [ ] 일반 로그인 재검증
- [ ] `--reset-password` 후 bootstrap 화면 재노출
- [ ] `--bootstrap-allow-ip`로 지정한 주소만 remote bootstrap 허용

## 회귀 검증

- [x] 기존 login route 유지
- [x] settings 비밀번호 변경 유지
- [x] 2FA/TOTP 흐름 유지
- [x] start-runtime 기존 포트/pm2 동작 유지

## 완료 판정

다음 조건을 모두 만족하면 PASS:

1. 기본 비밀번호 하드코딩 없이 최초 설정이 가능하다.
2. bootstrap API는 허용된 requester에게만 열린다.
3. reset-password 실행 옵션이 정확히 `auth.password`만 비운다.
4. 기존 인증/설정/런처 흐름에 회귀가 없다.
