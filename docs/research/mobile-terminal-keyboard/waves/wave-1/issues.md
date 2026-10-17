# Wave 1 boundary issues

Sources: worker review residuals (W1-F3, F4, F6, F7), loop P round 1 (1 MEDIUM, 4 LOW), test sufficiency.

| id | finding | class | resolution |
|---|---|---|---|
| W1-I1 | FR-MKB-003 AC-2 untested (loop P MEDIUM) | local-defect | test `FR-MKB-003 AC-2` in frontend/tests/unit/terminalMobileLatchOnData.test.ts, commit 2fa2c248 |
| W1-I2 | IR-MKB-001 AC-3 had no citing test (test sufficiency gap) | local-defect | test `IR-MKB-001 AC-3` in frontend/tests/unit/terminalMobileLatchOnData.test.ts, commit 2fa2c248 |
| W1-I3 | design baseline D-009 / D-022 lagged the SRS (loop P LOW) | design-gap | design/00.design.1.lock.json@sha256:ccb4a6ef2f456989b941bf82e63221d2e0107cc39e8175d5a7b557efd77bf0be |
| W1-I4 | latch store is global; once the bar can set it, it would also apply to a desktop hardware keyboard (W1-F6, loop P) | missing-task | carried into wave-2 design as an implementation rule: the bar resets the latch when `isMobile` turns false and never renders on desktop (I-002) |

Accepted LOW residuals (recorded, not opened as issues, per CLAUDE.md work-intensity policy):
- modified F1–F12 follow FR-MKB-001 AC-7/AC-8 (Alt prefix, Ctrl/Shift ignored) rather than xterm.js parameter forms (W1-F3).
- holding an already locked key vibrates again (loop P LOW).
- `LatchPress.cancel()` skips the generation check `release()` has; test-only impact (W1-F7, loop P LOW).
- `resetForTests` is on the production store API (W1-F7).
- a multi-character Gboard commit (word suggestion) is not transformed and leaves `once` on — allowed by FR-MKB-003 AC-3.
