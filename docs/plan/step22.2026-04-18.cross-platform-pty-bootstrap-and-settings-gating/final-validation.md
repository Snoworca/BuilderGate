# Final Validation

## 기능 완료 체크

- [x] `config.json5`가 없을 때 현재 OS에 맞는 PTY 기본값으로 자동 생성된다
- [x] non-Windows stale Windows PTY config도 startup hard-fail을 만들지 않는다
- [x] non-Windows에서 Windows 전용 PTY 옵션이 Settings에 표시되지 않는다
- [x] 숨겨진/stale PTY 값 때문에 unrelated settings save가 실패하지 않는다

## 백엔드 검증

- [x] bootstrap contract가 `config.ts`에 반영되었다
- [x] load normalization이 non-Windows stale config를 안전하게 처리한다
- [x] `SessionManager` runtime validation과 spawn policy가 helper 기반으로 일치한다

## 프런트 검증

- [x] capability snapshot 기준으로 Windows 전용 필드가 숨겨진다
- [x] save validation/self-block 문제가 제거되었다
- [x] frontend build가 통과한다

## 테스트 검증

- [x] `server npm run test` 통과
- [x] `frontend npm run build` 통과
- [ ] clean install / stale config / settings save 수동 검증 통과

## 문서 검증

- [x] README PTY 설명이 최신 정책과 일치한다
- [x] `server/config.json5.example`가 저장소 공용 예제 역할과 모순되지 않는다
- [x] plan/verification 문구와 실제 구현 범위가 일치한다

## 잔여 리스크

- 실제 macOS/Linux 호스트에서의 수동 smoke validation은 이 Windows 워크스페이스에서 수행하지 못했다.
- 대신 loader/session/settings 경계를 platform-injected integration test로 보강했다.
