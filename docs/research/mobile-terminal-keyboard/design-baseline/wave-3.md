# wave-3 excerpt
## Special keyboard

### Switching

- [D-034] Tapping the keyboard-switch button while the system keyboard is shown MUST blur the terminal textarea through a new `TerminalHandle.blurInput()` and open the special keyboard panel in the same place.
- [D-035] The panel height MUST equal the last measured system-keyboard inset, with a 280 px default when none was measured.
- [D-036] Tapping the switch button while the panel is open MUST close the panel and call `TerminalHandle.focus()` synchronously inside the tap handler, so iOS and Android raise the system keyboard again.
- [D-037] While the panel is open the terminal textarea MUST stay blurred: the tab wrapper `onPointerDown → focusTerminal` (App.tsx), `TerminalView` `handleClick`, and the pending focus-restore path (`pendingFocusRestoreRef`) are all suppressed, and the blur clears `pendingFocusRestoreRef`.

### Layout

- [D-038] The panel MUST have a top row Esc, Tab, Ctrl, Alt, Shift and below it three 3×4 blocks: F1–F12; ⌫ / | ~ * - ` : + _ = Enter; and Home ↑ PgUp / ← (empty) → / End ↓ PgDn / Ins Del Numpad.
- [D-039] Every panel key MUST send through the encoder with the latch applied and consume `once` modifiers.

## Numpad

- [D-040] Tapping Numpad MUST replace only the right 3×4 block with `7 8 9 / 4 5 6 / 1 2 3 / 0 . Arrows`, leaving the other blocks in place.
- [D-041] Numpad digits and `.` MUST send as plain characters through the encoder with the latch applied.
- [D-042] The chosen right block SHALL persist per device in `localStorage`, read and written inside try/catch so storage failure changes nothing else.
