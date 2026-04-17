# Final Validation

## 완료 게이트

- [ ] Phase 1 완료 및 검증 통과
- [ ] Phase 2 완료 및 검증 통과

## 기능 게이트

- [ ] 한글 `안녕하세요 `가 정상 출력된다
- [ ] 한글 `코딩을 합시다`가 정상 출력된다
- [ ] IME 상태 `Space`/`Backspace`는 xterm 네이티브 경로로 위임된다
- [ ] non-IME 영문 `Space`/`Backspace` 회귀가 없다

## 테스트 게이트

- [ ] 신규 IME regression E2E 통과
- [ ] 기존 keyboard regression 통과
- [ ] PowerShell 수동 검증 통과
- [ ] WSL bash 수동 검증 통과

## 후속 후보

- [ ] resize/replay/reconnect 경계에서만 남는 증상이 있는지 평가
- [ ] 필요 시 ConPTY/replay boundary hardening 별도 step 분리

