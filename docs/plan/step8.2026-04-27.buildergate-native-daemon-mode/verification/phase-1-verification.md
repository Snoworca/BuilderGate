# Phase 1 검증: CLI, Runtime Path, Strict Config, State

## 검증 대상

- `FR-8-003`, `FR-8-007`, `FR-8-014`, `FR-8-015`, `FR-8-017`
- `TEST-8-001`, `TEST-8-002`, `TEST-8-003`, `TEST-8-022`

## 필수 검증

- [ ] `--foreground`, `--forground`, `-p`, `--port`, invalid port, reset password, bootstrap allowlist, help parser 테스트 통과
- [ ] `buildergate`, `start.bat`, `start.sh` start interface smoke가 `IR-8-001` 계약과 일치
- [ ] `--reset-password`는 resolved `CONFIG_PATH`의 `auth.password`만 변경
- [ ] `--bootstrap-allow-ip`는 app env로만 전달되고 config에 저장되지 않음
- [ ] `--help`는 daemon/foreground/stop/`dist/bin`/config path 정책을 안내
- [ ] packaged/source runtime path contract 테스트 통과
- [ ] state schema union, atomic write/read, corrupt state, token masking 테스트 통과
- [ ] state file owner read/write 권한 또는 OS별 skip-with-reason 검증
- [ ] production strict config에서 existing invalid JSON5/schema가 fallback 없이 실패
- [ ] missing config bootstrap template 생성은 유지

## 회귀 명령 후보

```powershell
npm run test:daemon
Push-Location server
npm test
Pop-Location
```

## 완료 판정

Phase 1은 config/path/state 기반이 stop/daemon/sentinel에 재사용 가능한 상태이고, 구현 Phase 리뷰어가 `No findings`를 반환해야 완료된다.
