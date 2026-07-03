# 차기 세션 킥오프 프롬프트 — P0 잔여 완성 (2026-07-03 작성)

아래 블록을 새 세션의 첫 프롬프트로 그대로 붙여넣는다.

---

## 킥오프 프롬프트 (복사용)

```
[목표]
P0 구현(미커밋 워킹트리)의 검증 잔여 항목을 해소하고 커밋까지 완료한다.
우선순위: R1 → R2 → R4-1,2 → 커밋 A → R4-3(SRS) → R3(FR-BGSTAB-019 soak, 시간 소요 큼).

[먼저 읽을 것]
docs/next/2026-07-03-buildergate-p0-remediation-handoff.md (조치 항목 R1~R4 상세 가이드 — 이 문서가 작업 명세다)

[작업 항목 요약]
- R1 (MEDIUM): PERF-BGSTAB-003 AC-5의 필수 회귀 가드 — buildTerminalInputDebugPayload가
  키 입력당 ≤1회 호출임을 단언하는 테스트 추가. TDD: 임시 변형으로 red 실증 후 원복.
- R2 (MEDIUM): resolveInputDebugPayload의 sessionId stale closure 수정 —
  TerminalContainer.tsx:701-705 useCallback deps + TerminalView.tsx:1583 useImperativeHandle deps.
- R4-1 (LOW): PERF-BGSTAB-002 AC-4 테스트(async 신원조회 reject/timeout 격리) server test-runner에 추가.
- R4-2 (LOW): 무참조 readProcessStartIdentitySync(processTreeTerminator.ts:328) 정리.
- 커밋 A: 위 수정 + P0 구현 전체 커밋(시그니처 금지, push).
- R4-3: PERF-BGSTAB-001/002/003/004 speckiwi 반영 — add_verification_evidence + update_status(implemented).
  SRS 파일 직접 Edit 절대 금지(speckiwi MCP mutation만).
- R3: FR-BGSTAB-019 완결 — 서버 enforce 재기동 확인 → 2h 다중세션 soak(잔존 descendant 0 증거)
  → 롤백 문서 추적화 → SRS 갱신. stale PID는 대상 PID 지정으로만 처리.

[검증 기준 (완료 조건)]
- 서버 테스트 전체 green (기준선 312 + 신규), 프론트 변경 테스트 green, 양쪽 typecheck PASS
- ESLint: 변경 파일에서 신규 경고 0 (기존 12건은 무관 — handoff §2-R2 참조)
- recovery-option red 6건은 별도 트랙(의도된 TDD red)이므로 판단에서 제외
- 커밋 메시지 AI 시그니처 0건, git log -1 --format="%B" 로 검증

[금지/주의]
- taskkill /F /IM node.exe 절대 금지 (dev.js hot reload 환경)
- stability=draft REQ(REL-BGSTAB-005) 구현 금지 — OQ-1/OQ-2 미결
- FR-BGSTAB-019는 soak 증거 없이 implemented로 승급하지 말 것

[사용자에게 물어볼 것]
- R3-(b): config.json5.example을 enforce로 올릴지, observe 유지 + 런북으로 갈지 (권장: 후자)
- soak 2h를 이번 세션에서 실제 실행할지, 별도 일정으로 뺄지
```

---

## 세션 시작 직후 상태 검증 명령

```bash
git log --oneline -2          # d52e7d2 확인
git status --short | head -5  # P0 구현 미커밋 워킹트리 확인
cd server && npx tsx src/test-runner.ts 2>&1 | tail -1   # 312 test(s) passed 기준선
grep -nE 'mode:|visibleFlushBudgetBytes' server/config.json5 | head -3  # enforce / 262144
```

## 이 프롬프트가 전제하는 상태

- 브랜치 `feature/buildergate-wave1-process-observation` @ `d52e7d2`, P0 구현은 **미커밋 워킹트리**
- 검증 완료: PERF-001/002/004 완료, PERF-003 PARTIAL(R1), FR-019 미완(R3), 신규 발견 R2
- speckiwi: 5개 REQ 전부 planned/evidence 0 (완결 전 승급 금지 상태 유지 중)
