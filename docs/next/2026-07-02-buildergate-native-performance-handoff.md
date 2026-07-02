# BuilderGate 네이티브 성능 작업 핸드오프 (2026-07-02)

다음 세션이 이 문서 하나로 컨텍스트를 복원할 수 있도록 작성한 인수인계 문서다.

## 1. 현재 상태 스냅샷

| 항목 | 값 |
|---|---|
| 브랜치 | `feature/buildergate-wave1-process-observation` (origin과 동기화됨) |
| HEAD | `475d5e7` docs: 네이티브 성능 심층 분석과 P0 SRS 등록·feasibility 승급 결과를 기록한다 |
| 직전 커밋 | `3049ebc` feat: 출력 폭주 중 입력이 밀리지 않도록 WS 송신 우선순위와 입력 yield를 추가한다 |
| 서버 테스트 | **308/308 PASS** (`cd server && npx tsx src/test-runner.ts`) |
| 프론트 단위 테스트 | 완료분 green (scheduler 9/9, staleKeyRepeat 5/5, webSocketUrl 3/3, splitWSLifecycle 2/2) |
| **의도된 TDD red** | `recoveryOptionDialog.test.ts` 3/8 실패, `recoveryOptionIcon.test.ts` 7/7 실패 — **MetadataRow 복구 옵션 아이콘 통합 미구현** (테스트 선행 작성 상태) |
| 미커밋 잔여 | `.agents/`, `.kiwi/`, `.serena/`(도구 상태), `server/data/`(런타임 데이터), `kiwi/.pipeline-path`(빈 파일) — 의도적 제외 |
| speckiwi 활성 target | `0.5.5-buildergate-stability` — 총 30 REQ (stable 16 / evolving 12 / draft 1 / discarded 1), validate 0 errors |

## 2. 이번 세션(2026-07-02)에서 완료한 것

1. **네이티브 성능 심층 분석** — 서브에이전트 5축 분석으로 병목 22건(F1~F22) 규명.
   - 문서: `docs/research/2026-07-02.buildergate-native-performance-54-sessions-deep-analysis.md` (**북극성 문서 — 반드시 먼저 읽기**)
   - 핵심: F1 DOM 렌더러(WebGL 애드온 부재), F2 visibleFlushBudgetBytes=16KB 스로틀(~960KB/s 상한), F3 processCleanup observe 휴면, F4 세션 생성 동기 PowerShell 1s 블로킹
2. **P0 SRS 등록** (kiwi-srs) — P0 5건 → 요구사항 6건:
   - `PERF-BGSTAB-001` 프레임 시간예산 출력 flush + 16KB override 복원 (F2)
   - `FR-BGSTAB-019` enforce 프로세스 트리 종료 운영 활성화 + soak 게이트 (F3)
   - `REL-BGSTAB-005` shutdown 병렬 종료 + 타임아웃 스케일 (F3/F19; REL-BGSTAB-002 대체)
   - `PERF-BGSTAB-002` 신원조회 비동기화 (F4), `PERF-BGSTAB-003` 키입력 payload 1회화 (F7), `PERF-BGSTAB-004` onOutput 할당 제거 (F18)
3. **feasibility 전수 평가** (kiwi-srs-feasibility) — stable 16건 승급(사용자 승인 완료), evolving 5건 승급(위 신규 REQ). 판정 conditionally-ready.
   - 보고서: `docs/analysis/kiwi-srs-feasibility-2026-07-02.projectmaster.0-5-5-buildergate-stability.v01/report.md`
4. **커밋·push** — 진행 중이던 WS 송신 우선순위 레인/입력 yield/복구 옵션 기반 소스 + 문서 전체.

## 3. 미결 사용자 결정 (차기 세션에서 확인)

| # | 항목 | 차단 대상 |
|---|---|---|
| 1 | **OQ-1**: shutdown 병렬 종료 동시성 상한 값 | REL-BGSTAB-005 AC-8 (유일한 draft 잔존 원인) |
| 2 | **OQ-2**: 3s 고정 cleanup 타임아웃 대체 값/공식(54세션 스케일) | REL-BGSTAB-005 AC-9 |
| 3 | **P0-3b**(observe 모드 신원조회 생략) 등록 여부 — FR-BGSTAB-009 AC-2와 텍스트 충돌로 보류 | 선택적 최적화 (P0-3a=PERF-BGSTAB-002로 핵심은 해소) |

## 4. 다음 작업 (권장 순서)

1. **P0 구현**: evolving 승급된 5건(PERF-BGSTAB-001~004, FR-BGSTAB-019)을 `/kiwi-planner` → `/kiwi-pm`(또는 kiwi-coder)으로 구현. pipeline next_hint = kiwi-planner.
   - **주의**: PERF-BGSTAB-001과 FR-BGSTAB-017(planned)은 같은 `terminalOutputScheduler.ts`를 대상으로 함 — 구현 순서 조율 필요 (SRS trace notes 참조)
   - PERF-BGSTAB-001의 "프레임 시간예산 설정 가능" AC-3은 내부 상수 vs config 키 결정이 구현 시점에 필요
2. **진행 중 복구 옵션 마무리**: MetadataRow 아이콘 통합 구현으로 red 테스트 2파일 green 전환 (기존 TDD red가 명세다).
3. **P1 로드맵**(연구 문서 §5): WebGL 렌더러 도입(visible-only), repair/snapshot 단일 write 파이프라인, 그리드 초기 fit 수정 등 — 착수 전 kiwi-srs로 SRS 등록 필요.
4. 부수 정리: OBS-BGSTAB-001의 stale extends 링크(discarded REL-BGSTAB-002 → REL-BGSTAB-005 재지정), PERF-BGSTAB-001 AC 라벨 중복("AC-1: AC-1:") cosmetic, REL-BGSTAB-002 discard의 Change Notes 행 누락, `maxTotalSessions: 32` vs 실사용 54 모순, 스키마 기본 `wsSendMode='direct'` footgun.

## 5. 핵심 경로 참조

- 연구(북극성): `docs/research/2026-07-02.buildergate-native-performance-54-sessions-deep-analysis.md`
- SRS SSOT: `docs/spec/30.buildergate-stability.srs.md` (BGSTAB), 인덱스 `docs/spec/00.index.md`
- SRS 등록 run: `docs/analysis/kiwi-srs-2026-07-02.projectmaster.p0-native-perf/`
- feasibility run: `docs/analysis/kiwi-srs-feasibility-2026-07-02.projectmaster.0-5-5-buildergate-stability.v01/`
- 파이프라인 이벤트: `kiwi/pipeline.jsonl` (마지막 이벤트 next_hint = kiwi-planner)
- 작업 로그: `docs/worklog/2026-07-02.jsonl`
- 실행: `node dev.js` (서버 4242 + 프론트 4545, hot reload — **kill/taskkill node.exe 금지**)
- 테스트: 서버 `cd server && npx tsx src/test-runner.ts` / 프론트 `cd frontend && node --experimental-strip-types --test tests/unit/<파일>`

## 6. 워크플로 제약 (필수 준수)

- 모든 코드/문서 변경 전 `docs/spec/00.index.md` → 관련 REQ ID 확인, 작업 요약에 REQ ID 명시.
- stability=draft REQ는 구현 착수 금지 (현재 REL-BGSTAB-005만 해당 — OQ 해소 후 feasibility 재평가로 승급).
- TDD 의무: 구현 전 실패 테스트 선행. speckiwi MCP mutation 도구만으로 SRS 변경 (Edit 금지, 황금률).
- 커밋 메시지에 AI 시그니처 절대 금지.
