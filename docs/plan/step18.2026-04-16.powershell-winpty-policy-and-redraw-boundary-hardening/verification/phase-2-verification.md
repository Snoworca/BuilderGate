---
name: Step18 Phase 2 Verification
description: per-session windowsPty 메타데이터와 snapshot 계약 정합성 검증 체크리스트.
---

# Phase 2 Verification

- [ ] PowerShell winpty 세션 snapshot이 `backend: winpty`를 싣는다
- [ ] PowerShell conpty 세션 snapshot이 `backend: conpty`를 싣는다
- [ ] PowerShell `inherit + pty.useConpty=true` 세션 snapshot이 `backend: conpty`를 싣는다
- [ ] ConPTY 세션 snapshot이 `backend: conpty`를 싣는다
- [ ] headless terminal 생성 옵션이 session backend와 일치한다
- [ ] frontend가 snapshot metadata를 그대로 xterm에 반영한다
