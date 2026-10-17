# wave-2 excerpt
### Lockable-key marking

- [D-023] Only Ctrl, Alt and Shift MUST be lockable, each showing a corner dot that is grey when `off`, blue when `once` and glowing orange when `locked`.
- [D-024] The `once` state MUST render as blue text with underline and no filled background, and `locked` as an orange tinted box with an orange border.
- [D-025] While a lockable key is pressed, a fill MUST rise from the bottom over 1500 ms, with the browser context menu, text selection and `contextmenu` propagation to the tab wrapper suppressed.

## Accessory key bar

### Content and placement

- [D-026] The bar MUST show, left to right: Esc, Tab, Ctrl, Alt, separator, ←, ↑, ↓, →, separator, Home, End, PgUp, PgDn, and a keyboard-switch button.
- [D-027] The bar MUST render only when `useResponsive().isMobile` is true and either a document-level `focusin` has landed on the active tab's `.xterm-helper-textarea` without a later `focusout`, or the special keyboard is open.
- [D-028] The bar MUST sit directly above the system keyboard, using `window.visualViewport` (height and offsetTop) to compute the keyboard inset.
- [D-029] While the bar is shown, the app root height MUST follow `visualViewport.height` (through a CSS variable on `.app`), so the whole layout including the terminal shrinks above the keyboard and the existing ResizeObserver re-fits xterm.
- [D-030] The bar MUST scroll horizontally when wider than the screen, with its scrollbar hidden.
- [D-031] Every key MUST be at least `--ctl-touch` (44 px) in its smaller tappable dimension in the special keyboard and 36 px high in the bar.

### Focus

- [D-032] Pressing any bar or panel key MUST NOT move focus away from the terminal while the system keyboard is shown (`preventDefault` on `pointerdown`/`mousedown`).
- [D-033] Win, AltGr, mouse and screenshot keys MUST NOT appear anywhere in the bar or panel.
