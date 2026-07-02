# kiwi-srs Report: ConPTY Recovery Input Lag

## Summary

`$kiwi-srs --max --auto` was applied to the ConPTY output recovery and input-lag implementation plan.

The active target is `0.5.5-buildergate-stability` and the scope is `BGSTAB`.

Five planned, evolving requirements were added to `docs/spec/30.buildergate-stability.srs.md`:

- `FR-BGSTAB-015` — ConPTY transport and recovery Settings contract
- `FR-BGSTAB-016` — Priority-aware WebSocket safe-send under output flood
- `REL-BGSTAB-003` — Byte-aware replay tail and screen repair overflow recovery
- `FR-BGSTAB-017` — Frontend recovery write gate and queued input release barrier
- `OBS-BGSTAB-001` — ConPTY input-lag recovery telemetry and soak evidence

## Key Decisions

- `wsSendMode` remains `direct` by default. Observe/enforce rollout remains evidence-gated.
- The Settings contract includes the exact 29-key matrix from the June 30 plan.
- Server safe-send owns server-sent recovery ordering only; queued input release is owned by frontend recovery gating.
- ConPTY redraw-flood E2E at `https://localhost:2222` is mandatory final validation.
- `start.bat --port 2222`, `stop.bat`, and no broad `node.exe` termination remain validation constraints.
- The work must not silently switch Codex or ConPTY sessions to winpty, pipe, or another PTY backend as a workaround.

## Review Loop

The max review loop used six evaluator iterations.

- Iteration 1 found weak Settings availability wording, vague telemetry counters, non-canonical trace relations, and Wave4 wording mismatch.
- Iteration 2 found missing snapshot ACK ordering, incomplete Settings matrix specificity, and incomplete soak pass/fail criteria.
- Iteration 3 found stale `configTemplate` path, missing FR-BGSTAB-015 dependency traces, safe-send scope leakage, optional ConPTY E2E wording, and PTY fallback guard omission.
- Iteration 4 found the Settings matrix still too grouped and two recovery settings not explicit enough.
- Iteration 5 had zero CRITICAL/HIGH/MEDIUM findings and one LOW trace-note completeness finding.
- Iteration 6 returned zero CRITICAL/HIGH/MEDIUM/LOW findings across all three evaluators.

## Verification

- SpecKiwi MCP strict validation: 0 errors, 0 warnings.
- `speckiwi --root . validate --fail-on-warning --json`: 0 errors, 0 warnings.
- `git diff --check`: passed; Git emitted only an LF-to-CRLF working-copy warning for the SRS file.
- Independent sub-agent review: completed through iteration 6 with zero findings.

## Artifacts

- `srs_delta.json`
- `eval_iter1.json`
- `eval_iter2.json`
- `eval_iter3.json`
- `eval_iter4.json`
- `eval_iter5.json`
- `eval_iter6.json`
- `improvement_log.json`
