# Final Validation Checklist

## Automated

- `frontend`: `npm run build`
- `server`: `npm test`
- Playwright shell-level regression:
  - held `Space`
  - `Backspace`

## Manual

- `Codex TUI` held `Space`
- rapid `type + Enter` overlap reproduction
- same repro from plain PowerShell and from `codex` launched inside PowerShell

## Evidence To Capture

- browser terminal debug events
- server session debug capture
- screenshot or short textual observation of the visible failure/success state

## Pass Criteria

- If fixed: no visible overlap corruption and no delayed held-space cursor freeze caused by dropped client input.
- If not fully fixed: exact failing layer is identified and documented from the capture evidence.
