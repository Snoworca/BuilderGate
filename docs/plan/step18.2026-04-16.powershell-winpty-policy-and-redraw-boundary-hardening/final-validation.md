---
name: Step18 Final Validation
description: Step18 설계 완료 시 충족해야 하는 최종 기준을 정리한다.
---

# Final Validation

## Functional

- [ ] PowerShell rapid `A + Enter` repetition no longer causes overlapping vertical corruption
- [ ] output stacks line-by-line in the plain prompt
- [ ] issue does not reappear after restart, refresh, or workspace reuse
- [ ] PSReadLine history recall / completion / wrapped edit / paste / backspace regressions 없다
- [ ] PowerShell child TUI 1종에서 repaint / resize regression 없다

## Structural

- [ ] Workspace / Tab architecture unchanged
- [ ] `TerminalRuntimeLayer` unchanged in role
- [ ] server-authoritative snapshot model unchanged
- [ ] single WebSocket channel unchanged

## Safety

- [ ] non-PowerShell shells retain expected behavior
- [ ] per-session `windowsPty` metadata is truthful
- [ ] snapshot ACK timing is hardened
- [ ] interactive-ready barrier is enforced
- [ ] winpty probe / failure policy is deterministic
- [ ] mixed backend cohort behavior is documented and validated
- [ ] rollback trigger와 운영 절차가 검증되었다

## Evidence

- [ ] server tests pass
- [ ] frontend build passes
- [ ] Playwright PowerShell regression passes
- [ ] manual PowerShell validation logged
