# Phase 1 Verification

## 목적

frontend IME guard가 실제로 수동 `Space`/`Backspace` 경로를 차단하는지 검증한다.

## 확인 항목

- [ ] `isComposingRef`가 존재한다
- [ ] helper textarea에 `compositionstart` / `compositionend` 리스너가 등록된다
- [ ] `compositionend` 해제가 한 tick 지연된다
- [ ] IME 상태 OR guard가 `ev.isComposing`, `keyCode === 229`, `isComposingRef.current`를 모두 포함한다
- [ ] IME 상태일 때 `Space`/`Backspace`는 `manual_input_forwarded` 경로로 가지 않는다
- [ ] non-IME 상태 영문 `Space`는 기존 수동 경로를 유지한다

## 증거

- `TerminalView.tsx` diff
- 디버그 이벤트 캡처
- 코드 리뷰 메모

