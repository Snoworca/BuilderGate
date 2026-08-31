# T-PH004-02 Clipboard pure coordinator·handle GREEN 보고

## 결과

단일 clipboard coordinator를 추가하고 `TerminalView`/`TerminalContainer` handle에 generation-safe `copySelection`과 `pasteClipboard`를 노출했다. Programmatic paste admission은 기존 `term.paste()` → `onData` → input barrier/debug/multiline pipeline을 그대로 재사용한다.

## 핵심 계약

- Copy는 target과 selection을 불변 snapshot으로 캡처하고 clipboard write 성공 뒤 동일 session/sessionGeneration/viewGeneration/xterm/selection일 때만 clear와 focus를 수행한다.
- Clipboard read/write 실패와 context change는 명시적 reason으로 반환하고 raw payload를 debug observation에 넣지 않는다.
- Paste는 기존 admission을 정확히 한 번 호출하며 거부 뒤 direct input fallback이 없다.
- React StrictMode의 effect setup→cleanup→setup에는 coordinator lifecycle epoch와 `activate()`를 사용한다. Cleanup 전 시작한 async 작업은 재활성화 뒤에도 무효다.
- `useLayoutEffect`에서 visibility commit과 별도 clipboard view generation을 동기화해 hidden retained runtime이 clipboard target이 되지 못하게 한다.
- 우클릭 보존 selection은 xterm generation에 귀속하고 mount/dispose/clear에서 폐기한다.
- Native Ctrl+V owner와 no-selection Ctrl+C/SIGINT 코드는 T2에서 변경하지 않았다.

## 검증

```text
targeted unit: 17/17 PASS
full frontend unit: 336/336 PASS
npm run typecheck: PASS
npm run build: PASS
task-scoped ESLint: errors 0, pre-existing warnings 3
git diff --check: PASS
```

독립 까칠한 reviewer의 최초 High 2건·Medium 1건을 모두 수정했다. 같은 reviewer의 재실행과 최종 판정은 정확히 `No findings`였다.

## 변경 파일

- `frontend/src/utils/terminalClipboardCoordinator.ts`
- `frontend/src/components/Terminal/TerminalView.tsx`
- `frontend/src/components/Terminal/TerminalContainer.tsx`
- `frontend/tests/unit/terminalClipboardAdapterContract.test.ts`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH004-02/green-evidence.json`
- `docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath/T-PH004-02/report.ko.md`

Verification: Tier 2 automated checks and sub-agent review completed.
