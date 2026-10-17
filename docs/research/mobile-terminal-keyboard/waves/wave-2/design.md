# Wave 2 design — accessory key bar and lockable-key UI (#135 UI, #136)

Target: `mtk-wave-2`. Depends on: wave-1 (encoder `encodeMobileKey`, latch store `mobileModifierLatch`, `TerminalHandle.getApplicationCursorKeysMode`). Design items D-023..D-033 are carried verbatim below; this wave adds no new normative items.

## Planned files

- New `frontend/src/components/MobileKeyboard/MobileKeyBar.tsx` + `MobileKeyBar.css` — the bar (D-026, D-030..D-033).
- New `frontend/src/components/MobileKeyboard/LatchKey.tsx` — lockable key button: tap, 1500 ms hold fill, corner dot, contextmenu suppression (D-023..D-025), driven by the wave-1 store.
- New `frontend/src/hooks/useVisualViewportInset.ts` — keyboard inset and app height from `window.visualViewport` (D-028, D-029).
- New `frontend/src/hooks/useTerminalInputFocus.ts` — document focusin/focusout on the active tab's `.xterm-helper-textarea` (D-027).
- `frontend/src/App.tsx` — mount the bar inside `.workspace-screen` on mobile, send keys through `sendTerminalInput`, set the `.app` height variable.
- `frontend/public/locales/messages.{en,ko}.json` — aria/title keys (I-001).

## Carried design items
- [D-023] Only Ctrl, Alt and Shift MUST be lockable, each showing a corner dot that is grey when `off`, blue when `once` and glowing orange when `locked`.
- [D-024] The `once` state MUST render as blue text with underline and no filled background, and `locked` as an orange tinted box with an orange border.
- [D-025] While a lockable key is pressed, a fill MUST rise from the bottom over 1500 ms, with the browser context menu, text selection and `contextmenu` propagation to the tab wrapper suppressed.
- [D-026] The bar MUST show, left to right: Esc, Tab, Ctrl, Alt, separator, ←, ↑, ↓, →, separator, Home, End, PgUp, PgDn, and a keyboard-switch button.
- [D-027] The bar MUST render only when `useResponsive().isMobile` is true and either a document-level `focusin` has landed on the active tab's `.xterm-helper-textarea` without a later `focusout`, or the special keyboard is open.
- [D-028] The bar MUST sit directly above the system keyboard, using `window.visualViewport` (height and offsetTop) to compute the keyboard inset.
- [D-029] While the bar is shown, the app root height MUST follow `visualViewport.height` (through a CSS variable on `.app`), so the whole layout including the terminal shrinks above the keyboard and the existing ResizeObserver re-fits xterm.
- [D-030] The bar MUST scroll horizontally when wider than the screen, with its scrollbar hidden.
- [D-031] Every key MUST be at least `--ctl-touch` (44 px) in its smaller tappable dimension in the special keyboard and 36 px high in the bar.
- [D-032] Pressing any bar or panel key MUST NOT move focus away from the terminal while the system keyboard is shown (`preventDefault` on `pointerdown`/`mousedown`).
- [D-033] Win, AltGr, mouse and screenshot keys MUST NOT appear anywhere in the bar or panel.

## Carried from wave 1 (W1-I4)

- The bar component resets the wave-1 latch store (`mobileModifierLatch.resetForTests` is test-only, so add a production `reset()` or tap modifiers back to off) whenever `isMobile` becomes false or the bar unmounts, so a latch set on mobile never applies to a desktop hardware keyboard.
