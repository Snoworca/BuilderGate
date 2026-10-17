# Wave 3 design — special keyboard panel and numpad (#137, #138)

Target: `mtk-wave-3`. Depends on: wave-2 (MobileKeyBar with `onToggleKeyboard`, LatchKey, `getLastKeyboardInset`, app viewport box). Design items D-034..D-042 are carried verbatim below from `design/00.design.1.md`; this wave adds no new normative items.

## Planned files

- New `frontend/src/components/MobileKeyboard/MobileSpecialKeyboard.tsx` — the panel: top row Esc/Tab/Ctrl/Alt/Shift, F-key block, edit/symbol block, right block switching between arrows and numpad (D-038..D-041).
- `frontend/src/components/MobileKeyboard/mobileKeyboard.css` — panel grid styles; keys at least `--ctl-touch` (D-031 panel part, deferred from wave 2).
- `frontend/src/components/Terminal/TerminalView.tsx` and `TerminalContainer.tsx` — `TerminalHandle.blurInput()` that blurs the helper textarea and clears `pendingFocusRestoreRef`, and a way to suppress `handleClick` refocus while the panel is open (D-034, D-037).
- `frontend/src/App.tsx` — panel open state, toggle handler that blurs or focuses synchronously in the tap handler, suppression of the tab wrapper `onPointerDown → focusTerminal` while open, panel height from `getLastKeyboardInset()` with a 280 px default (D-035..D-037).
- localStorage key for the right-block choice, wrapped in try/catch (D-042).

## Carried design items
- [D-034] Tapping the keyboard-switch button while the system keyboard is shown MUST blur the terminal textarea through a new `TerminalHandle.blurInput()` and open the special keyboard panel in the same place.
- [D-035] The panel height MUST equal the last measured system-keyboard inset, with a 280 px default when none was measured.
- [D-036] Tapping the switch button while the panel is open MUST close the panel and call `TerminalHandle.focus()` synchronously inside the tap handler, so iOS and Android raise the system keyboard again.
- [D-037] While the panel is open the terminal textarea MUST stay blurred: the tab wrapper `onPointerDown → focusTerminal` (App.tsx), `TerminalView` `handleClick`, and the pending focus-restore path (`pendingFocusRestoreRef`) are all suppressed, and the blur clears `pendingFocusRestoreRef`.
- [D-038] The panel MUST have a top row Esc, Tab, Ctrl, Alt, Shift and below it three 3×4 blocks: F1–F12; ⌫ / | ~ * - ` : + _ = Enter; and Home ↑ PgUp / ← (empty) → / End ↓ PgDn / Ins Del Numpad.
- [D-039] Every panel key MUST send through the encoder with the latch applied and consume `once` modifiers.
- [D-040] Tapping Numpad MUST replace only the right 3×4 block with `7 8 9 / 4 5 6 / 1 2 3 / 0 . Arrows`, leaving the other blocks in place.
- [D-041] Numpad digits and `.` MUST send as plain characters through the encoder with the latch applied.
- [D-042] The chosen right block SHALL persist per device in `localStorage`, read and written inside try/catch so storage failure changes nothing else.

## Carried from wave 2 (W2-I1..I5)

- Add orange design tokens (locked fill, border, glow and text matching the mock's #ffb02e / #ffd27a) and use them for the locked LatchKey instead of `--warn`.
- Raise the hold-fill tint to the mock's 0.28 alpha and keep it distinct from the locked background.
- Give LatchKey the same 8 px drag cancel the plain bar keys have (cancel instead of release).
- Gate `useTerminalInputFocus` listeners on `isMobile` so desktop focus changes do not re-render AppContent.
- Move the non-component exports out of `MobileKeyBar.tsx` into a `.ts` module so eslint `react-refresh/only-export-components` reports no new errors.
