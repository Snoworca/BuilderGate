# Phase 2 Verification

## 목적

IME race fix가 자동 테스트와 수동 검증에서 동시에 유효한지 검증한다.

## 확인 항목

- [ ] `terminal-korean-ime.spec.ts`가 추가된다
- [ ] IME race에서 `ime_guard_delegated`가 관찰된다
- [ ] IME race에서 `manual_input_forwarded(key=Space)`가 관찰되지 않는다
- [ ] IME 중 `Backspace`도 동일하게 수동 경로를 타지 않는다
- [ ] 기존 `terminal-keyboard-regression.spec.ts`가 계속 통과한다
- [ ] PowerShell 수동 입력 검증 체크리스트가 정리된다
- [ ] WSL bash 수동 입력 검증 체크리스트가 정리된다
- [ ] resize / workspace switch / reconnect 직후 확인 항목이 정리된다

## 증거

- Playwright 실행 로그
- 수동 검증 기록
- 디버그 이벤트 캡처

