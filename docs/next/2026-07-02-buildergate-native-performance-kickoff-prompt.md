# 차기 세션 킥오프 프롬프트 (2026-07-02 작성)

아래 블록을 새 세션의 첫 프롬프트로 그대로 붙여넣어 사용한다. goal 모드 운용을 전제로 작성됐다.

---

## 킥오프 프롬프트 (복사용)

```
[목표]
BuilderGate를 "웹에서 54개 이상 동시 셸 + 네이티브 터미널 동등 성능"으로 만든다.
이번 세션의 goal: evolving 승급이 완료된 P0 성능 요구사항 5건을 구현한다.
- PERF-BGSTAB-001: 프레임 시간예산(6~8ms) 다중 청크 flush + config.json5 visibleFlushBudgetBytes 16KB→256KB 복원
- PERF-BGSTAB-002: 세션 생성 동기 PowerShell 신원조회(readProcessStartIdentitySync) 비동기화
- PERF-BGSTAB-003: 키 입력당 buildTerminalInputDebugPayload 1회화 + TextEncoder/Intl.Segmenter 싱글턴
- PERF-BGSTAB-004: onOutput 경로 TextEncoder/리소스 한도 캐시
- FR-BGSTAB-019: session.processCleanup.mode=enforce 운영 활성화(+soak 게이트, 스키마 기본값 불변)

[먼저 읽을 것 — 순서대로]
1. docs/next/2026-07-02-buildergate-native-performance-handoff.md (인수인계 — 현재 상태/미결 결정/주의사항)
2. docs/research/2026-07-02.buildergate-native-performance-54-sessions-deep-analysis.md §2~§5 (근거와 로드맵)
3. docs/spec/30.buildergate-stability.srs.md 에서 위 REQ 5건의 statement/AC/trace

[진행 방법]
/kiwi-planner 로 위 5건의 구현 계획을 수립한 뒤 /kiwi-pm --auto 로 Task 루프를 실행한다.
(수동 진행 시에도 TDD 필수: REQ별 실패 테스트 선행 → 최소 구현 → 회귀 전체 green)

[제약]
- SpecKiwi 워크플로 준수: REQ ID 없는 구현 금지, SRS 변경은 speckiwi MCP mutation만 사용
- PERF-BGSTAB-001은 FR-BGSTAB-017(planned)과 같은 terminalOutputScheduler.ts 대상 — 구현 순서/충돌 조율 후 착수
- REL-BGSTAB-005는 draft(OQ-1/OQ-2 미결)이므로 구현 금지 — 내 답변을 먼저 요청할 것
- dev.js 실행 중 kill/taskkill node.exe 금지, 커밋 메시지 AI 시그니처 금지
- 완료 기준: 서버 테스트 전체 green(기준 308개+신규), 프론트 단위 테스트 green,
  연구 문서 §6 검증 계획의 해당 항목(출력 처리량/부하 중 입력 지연) 실측 개선 확인

[미결 결정 — 필요 시 나에게 질문]
- OQ-1: shutdown 병렬 종료 동시성 상한 값
- OQ-2: cleanup 타임아웃 스케일 값/공식 (현재 3s 고정, 54세션)
- P0-3b(observe 모드 신원조회 생략) 등록 여부
```

---

## 참고: 세션 시작 직후 상태 검증 명령

```bash
git log --oneline -3        # 475d5e7 / 3049ebc 확인
cd server && npx tsx src/test-runner.ts   # 308 PASS 기준선
```

## 참고: 이 프롬프트가 전제하는 상태

- 브랜치 `feature/buildergate-wave1-process-observation` = origin 동기화(475d5e7)
- speckiwi 활성 target `0.5.5-buildergate-stability`, PERF-BGSTAB-001~004·FR-BGSTAB-019 = planned/evolving
- 복구 옵션 UI(MetadataRow 아이콘)는 의도된 TDD red 상태로 별도 트랙 — P0 goal과 혼동 금지
