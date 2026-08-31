# Orca식 refresh 상태 복구 연구 요약

- Run ID: `2026-07-15.projectmaster.orca-refresh-state-refactor.s01`
- Mode: standalone
- Valid roles: Triage + Researcher A/B/C + Synthesizer
- Paraphrase validation: standard + adversarial detector final `pass`
- Runtime code mutation: 없음

## 판정

BuilderGate의 새로고침 후 scrollback 절단은 서버와 브라우저 snapshot이 모두 viewport-only이고 현재 E2E가 오래된 행의 부재를 성공으로 판정하는 계약 수준 문제다. 다만 사용자가 경험한 개별 사고가 viewport-only, oversized empty fallback, replay tail, remount handoff 중 어느 경계에서 발생했는지는 runtime correlation이 필요하다.

Orca에서 흡수할 후보는 무제한 history가 아니라 daemon-owned bounded model, disposable view, model-first ingest, absolute sequence, explicit gap/resync와 reload 때 dead renderer debt를 폐기하는 lifecycle이다. G1이 architectural migration을 선택한 경우에만 viewport-only/local-cache correctness path를 `계약 → shadow → canary → authority promotion → recovery equivalence → cache/legacy 제거` 순서로 대체한다. G1이 confirmed-bug-only를 선택하면 국소 수정과 회귀 증거에서 roadmap을 종료하고 authority promotion·legacy deletion을 진행하지 않는다.

## 최종 계획이 제안하는 핵심 계약

`full retained-state`는 무제한 transcript가 아니라 서버의 명시된 retention window 안에 남아 있는 normal scrollback, active screen, alternate buffer, cursor/mode/geometry와 snapshot sequence 전체를 뜻한다. Browser가 표시할 수 있는 history 범위가 server authoritative recovery 범위보다 커서는 안 된다.

## 감사 자료

- `triage.json`
- `research-raw/code-research.json`
- `research-raw/external-research.json`
- `research-raw/risk-research.json`
- `research-summary.json`
- `agent-manifest.json`
