---
name: Step18 Phase 1 Verification
description: PowerShell 전용 backend policy 도입 검증 체크리스트.
---

# Phase 1 Verification

- [ ] config schema가 `pty.windowsPowerShellBackend`를 허용한다
- [ ] 기본값 / `inherit` / `conpty` / `winpty`가 모두 검증된다
- [ ] PowerShell 세션 생성 시 per-session backend resolution이 적용된다
- [ ] non-PowerShell 세션은 기존 global `useConpty` 동작을 유지한다
- [ ] `pty.useConpty`와 PowerShell override의 운영자-facing 의미가 문서/표면에서 충돌하지 않는다
- [ ] RuntimeConfigStore / SettingsService / ConfigFileRepository / example config / startup log 경로가 모두 반영된다
- [ ] explicit `winpty` 요청 시 capability probe가 수행된다
- [ ] probe 실패 시 fail-fast 오류와 telemetry가 남는다
