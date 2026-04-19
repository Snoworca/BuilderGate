---
name: Step23 Completion Report
description: 초기 관리자 비밀번호 bootstrap 및 reset-password 실행 옵션 구현 완료 보고서.
---

# Completion Report

## 구현 요약

- `config.json5` 최초 생성 경로를 `config.json5.example` 복제에서 코드 기반 bootstrap 템플릿 렌더링으로 교체했다.
- `auth.password: ""` canonical state와 `bootstrap.allowedIps` 설정을 타입/스키마/예제 파일에 반영했다.
- 서버에 `GET /api/auth/bootstrap-status`, `POST /api/auth/bootstrap-password`를 추가하고 localhost 기본 허용 + allowlist IP 정책을 연결했다.
- bootstrap 성공 시 암호화 저장, runtime auth 갱신, JWT 즉시 발급을 구현했다.
- 프런트 인증 가드는 bootstrap 상태에 따라 로그인 폼, bootstrap 폼, denied 안내를 분기하도록 변경했다.
- stale local token이 남아 있어도 서버가 다시 `setupRequired`를 반환하면 토큰을 비우고 bootstrap 화면으로 복귀하도록 보강했다.
- `tools/start-runtime.js`에 `--reset-password`, `--bootstrap-allow-ip`를 추가했고 README 운영 문서를 현재 런타임 계약에 맞게 정리했다.

## 자동 검증

- `server`: `npm run test` 통과, `116 test(s) passed`
- `frontend`: `npm run build` 통과
- `frontend`: `npx playwright test tests/e2e/auth-bootstrap.spec.ts --project "Desktop Chrome"` 통과, `4 passed`
- launcher helper:
  - `node tools/start-runtime.js --help`
  - inline Node 검증으로 `--bootstrap-allow-ip` 파싱과 `auth.password` reset helper 확인

## 코드리뷰 게이트

- Phase 1 reviewer: no findings after re-review
- Phase 2 reviewer: no findings after re-review
- Phase 3 reviewer: 최초 stale-token / whitespace validation 이슈 수정 후 재검토 진행
- Phase 4 reviewer: 최초 reset helper / README mismatch 이슈 수정 후 재검토 진행

## 수동 검증 상태

- 아직 미실시:
  - `config.json5`가 없는 실제 런타임에서 첫 부팅 후 브라우저 bootstrap 확인
  - `./start.sh --reset-password` / `start.bat --reset-password` 실제 운영 흐름 확인
  - `--bootstrap-allow-ip`를 사용한 실제 원격 장치 bootstrap smoke

## 결론

- Step23 요구사항의 코드 구현과 자동 검증은 완료되었다.
- 남은 것은 운영 환경 기준의 수동 smoke validation뿐이다.
