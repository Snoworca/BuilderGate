# Wave 2 boundary issues

Sources: worker review residuals (FND-101, LOWs), loop P round 1 (0 CRITICAL/HIGH/MEDIUM, 4 LOW, 3 INFO), test sufficiency (pass after the worker's own AC-5 fill).

| id | finding | class | resolution |
|---|---|---|---|
| W2-I1 | lock colour uses `--warn` gold, mock uses orange #ffb02e / text #ffd27a (loop P L1) | missing-task | carried into wave-3 design: add an orange token pair and use it for locked state |
| W2-I2 | hold fill alpha 0.14 vs mock 0.28 (loop P L2) | missing-task | carried into wave-3 design |
| W2-I3 | Ctrl/Alt LatchKey lacks the 8 px drag cancel of FR-MKB-006 AC-4 (loop P L3) | missing-task | carried into wave-3 design |
| W2-I4 | focus listeners run on desktop and re-render AppContent (loop P L4) | missing-task | carried into wave-3 design: gate the hook on isMobile |
| W2-I5 | MobileKeyBar.tsx exports non-components; eslint react-refresh/only-export-components +2 (worker FND-101) | missing-task | carried into wave-3 design: move helpers to a .ts module |

Accepted (recorded, not opened): locked-pulse animation absent (no AC); `useVisualViewportInset` currently unused by App (kept for wave 3 panel height); a second finger's pointerdown overwrites the first tap; Android back-key keyboard close leaves the bar visible while the textarea keeps focus; post-merge unit run saw a timing flake in restoreLatencyInstrumentCost.test.ts (#113, passes 3/3 alone, unrelated file).
