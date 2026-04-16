---
name: Step18 Phase 3 Verification
description: snapshot apply/ACK/restore drain 경계 hardening 검증 체크리스트.
---

# Phase 3 Verification

- [ ] `replaceWithSnapshot()` 직후 ACK가 나가지 않는다
- [ ] restore drain 완료 후 ACK가 전송된다
- [ ] stale / duplicate snapshot guard는 유지된다
- [ ] restore 중 rapid input이 중간 권위 프레임으로 굳지 않는다
- [ ] first fit/resize, prompt-ready, restore-ready 이후에만 input-unblock 된다
- [ ] 세션 생성 직후 / 새로고침 직후 / reconnect 직후 즉시 입력에서도 barrier가 유지된다
