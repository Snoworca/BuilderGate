# Wave 1 design — encoder, latch store, system-keyboard latch (#134, #135 logic)

Target: `mtk-wave-1`. Depends on: none. Design items D-001..D-022 are carried verbatim below; this wave adds no new normative items.

## Planned files

- New `frontend/src/utils/mobileKeyEncoder.ts` — pure encoder (D-001..D-010).
- New `frontend/src/utils/mobileModifierLatch.ts` — module-level latch store with subscribe/getSnapshot, tap/hold/consume transitions and the vibrate call (D-013..D-018, D-021).
- `frontend/src/components/Terminal/TerminalView.tsx` — `getApplicationCursorKeysMode()` on `TerminalHandle` (D-012), latch application inside `term.onData` after the provenance and guard steps (D-019, D-020, D-022).
- `frontend/src/components/Terminal/TerminalContainer.tsx` — forward the new handle method.
- Tests: `frontend/tests/unit/mobileKeyEncoder.test.ts`, `frontend/tests/unit/mobileModifierLatch.test.ts` (pure, registered in `tsconfig.test.json`), and an `onData` latch case in the `test:unit:terminal-view-behavior` set.

## Carried design items
- [D-001] The encoder MUST be a pure module that maps a key name plus a modifier state `{ctrl, alt, shift}` plus an `applicationCursor` flag to the exact byte string sent to the PTY.
- [D-002] Arrow keys without modifiers MUST encode as `ESC [ A..D` when `applicationCursor` is false and as `ESC O A..D` when it is true.
- [D-003] Arrows, Home and End with any modifier MUST encode as `ESC [ 1 ; m X` where `m = 1 + shift(1) + alt(2) + ctrl(4)`.
- [D-004] Home and End without modifiers MUST encode as `ESC [ H` / `ESC [ F`, and as `ESC O H` / `ESC O F` when `applicationCursor` is true, matching xterm.js hardware keys.
- [D-005] Insert, Delete, PageUp and PageDown MUST encode as `ESC [ n ~` with n = 2, 3, 5, 6, and as `ESC [ n ; m ~` when a modifier is active.
- [D-006] F1–F4 MUST encode as `ESC O P..S` and F5–F12 as `ESC [ 15~ 17~ 18~ 19~ 20~ 21~ 23~ 24~`.
- [D-007] Esc, Tab, Enter and Backspace MUST encode as `ESC`, `\t`, `\r` and `0x7f`, and Shift+Tab as `ESC [ Z`.
- [D-008] A single character with Ctrl MUST encode per the xterm table: `a`..`z` → `0x01`..`0x1a`; `@`, `2` and Space → `0x00`; `[` and `3` → `0x1b`; `\` and `4` → `0x1c`; `]` and `5` → `0x1d`; `^` and `6` → `0x1e`; `_`, `-` and `7` → `0x1f`; `?` and `8` → `0x7f`; any other character is sent unchanged.
- [D-009] Alt MUST prefix the encoded result with a single `ESC`.
- [D-010] Shift on a single letter MUST upper-case it before Ctrl/Alt are applied.
- [D-011] Encoded bytes MUST reach the server through the existing `TerminalHandle.sendInput` path, which ends in `submitCapturedInput`, so operation IDs, the input queue and the checkpoint barrier apply unchanged.
- [D-012] `TerminalHandle` SHALL expose `getApplicationCursorKeysMode()` that reads the live `term.modes.applicationCursorKeysMode`, forwarded by `TerminalContainer` like `getMouseTrackingActive`.
- [D-013] Each of Ctrl, Alt and Shift MUST hold one of three states: `off`, `once` or `locked`.
- [D-014] A tap MUST move `off` → `once`, `once` → `off` and `locked` → `off`.
- [D-015] A press held for 1500 ms MUST move the key to `locked` at the 1500 ms mark, without waiting for release.
- [D-016] Releasing before 1500 ms MUST count as a tap; a `pointercancel` leaves every state unchanged.
- [D-017] After one encoded key is sent, every modifier in `once` MUST return to `off`, while `locked` modifiers stay `locked`.
- [D-018] Reaching `locked` MUST call `navigator.vibrate(25)` only when that function exists, so a browser without the Vibration API locks silently and raises no error.
- [D-019] When any modifier is not `off`, data from `term.onData` that is exactly one printable ASCII character (0x20–0x7E) MUST be re-encoded through the encoder before `submitCapturedInput`, inside the existing `onData` handler, whatever the IME composition flags say, because Android keyboards deliver Latin letters through composition.
- [D-020] The latch MUST NOT transform non-ASCII data (Hangul syllables and other IME commits), multi-character data, parser replies, focus reports or programmatic paste.
- [D-021] The latch state SHALL live in one module-level store with subscribe/getSnapshot, read by `TerminalView` and by every keyboard component.
- [D-022] The re-encoding MUST happen after the provenance counter (`markUserXtermDataProvenance`) has been consumed and after the query-reply and replay guards have passed, so the re-encoded string is submitted under the original keystroke's permit (REL-BGSTAB-019).
