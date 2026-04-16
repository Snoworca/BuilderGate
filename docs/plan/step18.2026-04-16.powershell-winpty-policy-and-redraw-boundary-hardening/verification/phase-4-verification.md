---
name: Step18 Phase 4 Verification
description: PowerShell 회귀 해결과 다른 셸/구조 안전성 검증 체크리스트.
---

# Phase 4 Verification

- [ ] plain PowerShell prompt에서 rapid `A + Enter` 겹침이 사라진다
- [ ] `codex` launched from PowerShell에서도 동일 문제 재현이 사라진다
- [ ] PSReadLine history recall / completion / wrapped edit / paste / backspace 회귀가 없다
- [ ] PowerShell child TUI 1종에서 repaint / resize 회귀가 없다
- [ ] bash / wsl / cmd 회귀가 없다
- [ ] `tab <-> grid`, workspace switch, reconnect가 유지된다
- [ ] legacy ConPTY PowerShell 세션과 신규 winpty PowerShell 세션의 mixed cohort가 검증된다
- [ ] winpty unavailable 환경의 fail-fast / rollback 절차가 검증된다
- [ ] incident rollback 시 effective backend가 명시적으로 `conpty`가 되는지 확인한다
