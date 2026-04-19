---
name: Step23 Integration Test Guide
description: 초기 비밀번호 bootstrap과 reset-password 실행 옵션 구현 검증을 위한 통합 테스트 가이드.
---

# Integration Test Guide

## 서버 테스트

1. `config.json5`가 없는 temp dir에서 config bootstrap 생성 테스트
2. empty password 상태에서 bootstrap-status 응답 테스트
3. localhost / deny / allowlist IP 분기 테스트
4. bootstrap-password 성공 시 encrypted persistence + JWT issuance 테스트
5. bootstrap 완료 후 bootstrap API 재호출 차단 테스트
6. 기존 login / settings password rotation / 2FA regression 테스트

## 프런트엔드 E2E

1. `setupRequired=true, requesterAllowed=true`일 때 bootstrap form 노출
2. password-confirm mismatch 경고
3. bootstrap 성공 후 authenticated 화면 진입
4. `setupRequired=true, requesterAllowed=false`일 때 denied 안내
5. `setupRequired=false`일 때 기존 LoginForm 유지

## 운영 스모크

1. `./start.sh --reset-password`
2. `start.bat --reset-password`
3. `./start.sh --reset-password --bootstrap-allow-ip 192.168.0.50`
4. 비밀번호 초기화 후 브라우저 최초 접속 시 bootstrap 화면 노출
5. bootstrap 완료 후 재시작 없이 로그인/세션 생성 가능

## 수동 검증 체크리스트

- bootstrap 화면에서 password와 confirm이 모두 필요함
- 허용되지 않은 원격 IP는 setup 화면이 아니라 denied 안내를 봄
- bootstrap 성공 직후 바로 앱 본문으로 진입함
- `--reset-password`가 포트, PTY, 2FA, workspace 설정을 건드리지 않음
- bootstrap 완료 후 일반 로그인 화면으로 복귀함
