# loop D round 1

Verifier: independent Explore subagent. Denominator: D-001..D-042, I-001..I-003 (45 items), open questions 0, constraints C-001..C-007.

Result: 39 implementable, 5 needs-decision (D-008, D-019, D-020, D-029, plus D-037 contradicts-existing with pointers App.tsx:959, TerminalView.tsx:5031, 4417-4422, 794-797).

Resolutions (decided under --auto by the orchestrator, recorded here; no committee was needed because each choice follows the user's stated goal of arrow/modifier usability on Android):
- D-008: completed with the xterm control table; other characters pass through.
- D-019/D-020: latch applies to single printable ASCII regardless of composition flags; non-ASCII commits are never transformed.
- D-022: re-encoding happens after the provenance counter and guards.
- D-029: app root height follows visualViewport.height.
- D-037: the three refocus paths are named and suppressed only while the panel is open.
- Also applied: D-004 app-cursor Home/End, D-025 contextmenu propagation, D-027 focus signal, D-034/D-036 handle methods, I-001 key caps as ASCII constants.

Round 2 (re-read by the orchestrator against the same pointers): 45 implementable, 0 needs-decision, 0 contradicts-existing, 0 constraint violations. PASS.
