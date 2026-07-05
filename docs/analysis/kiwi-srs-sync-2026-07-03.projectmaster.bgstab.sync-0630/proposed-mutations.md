## §1 변경 분석 요약

- 변경 파일: 6개 / CU: 6개 (CU-001~006, 단일 hot-fix 의미 단위)
- 4방향 분류: conflict=0 / update=6(전부 PERF-BGSTAB-002) / new-feature=0 / new-scope=0
- 영향 REQ: PERF-BGSTAB-002 (주 대상, AC-6/7/8 신설) / FR-BGSTAB-019 (Implementation Notes만, AC/Status 불변) / FR-BGSTAB-009 (Implementation Notes 교차 참조만, AC/Status 불변)
- 외부 모듈 영향: 없음 (전 6개 CU가 server/src 내부)
- validate_spec 결과: **PASS** (0 errors, 기존 경고 1건 REL-BGSTAB-005 draft — 본 sync와 무관)
- Phase 4 평가: Opus 평가자 CRITICAL 0/HIGH 0/MEDIUM 1/LOW 2, Sonnet 평가자 CRITICAL 0/HIGH 0/MEDIUM 1/LOW 3 — Normal 게이트 통과

## §2 제안 mutation (호출 순서대로, 11건)

### CU-001~006 — update (PERF-BGSTAB-002)

1. **append_section_note** `{id: PERF-BGSTAB-002, section: "Acceptance Criteria"}` — 신규 AC-6(config화된 타임아웃, 기본 3000ms) / AC-7(최대 3회 재시도, backoff 200/400ms, finalize 시 타이머 정리) / AC-8(identityCapture Succeeded/Retried/Failed 카운터) 추가. 기존 AC-1~5 불변.
2~6. **add_trace_link** ×5 (Code, relation=verifies) — SessionManager.ts:2363-2413(핵심 재시도 로직), processTreeTerminator.ts:328-354(타임아웃 파라미터화), config.types.ts:114, config.schema.ts:89, ws-protocol.ts:60-62
7. **add_trace_link** (Test, verifies) — test-runner.ts 회귀 테스트 3종
8. **add_verification_evidence** `{id: PERF-BGSTAB-002, type: test}` — 위 3개 테스트명 + 315/315 전체 통과 + tsc 0 errors

### FR-BGSTAB-019 — 정보성 note (AC/Status 불변)

9. **append_section_note** `{id: FR-BGSTAB-019, section: "Implementation Notes"}` — 이 hot-fix가 선행 적용됐다는 사실 + **잔존 한계**(재시도 소진·즉시삭제 race 시 여전히 skipped-unverified 가능) + **미결 정책 질문**(enforce 미검증 시 PID-tree fallback kill 허용 여부는 별도 SRS 결정 필요). soak(AC-3) 미실행이므로 Status는 planned 유지.

### FR-BGSTAB-009 — 교차 참조 note (평가자 B 반영, AC/Status 불변)

11. **append_section_note** `{id: FR-BGSTAB-009, section: "Implementation Notes"}` — PERF-BGSTAB-002가 이 REQ 소유의 config/telemetry 표면(SessionProcessCleanupConfig, SessionCleanupTelemetry)에 신규 필드를 추가했음을 교차 참조. AC-1/AC-6 열거는 non-exhaustive해지나 모순은 아님. AC/Status/Stability 불변.

### 작업 로그

10. **add_completed_work** — target=0.5.5-buildergate-stability, scope=BGSTAB, requirementIds=[PERF-BGSTAB-002], reportPaths=hot-fix 분석 디렉토리

## §3 분류 모호/충돌 항목

없음. 6개 CU 전부 단일 REQ(PERF-BGSTAB-002)로 명확히 수렴, conflict 0건.

## §4 상태 변경 없음 (명시)

- **PERF-BGSTAB-002**: Status=implemented 유지(verified 미승급) — 잔존 한계(재시도 소진/즉시삭제 시 여전히 leak 가능)로 인해 verified 승급은 시기상조. Stability=evolving 유지.
- **FR-BGSTAB-019**: Status=planned 유지(soak AC-3 미실행), AC 불변.
- **FR-BGSTAB-009**: Status/Stability/AC 전부 불변(stable 계약 재개봉 없음, note만 추가).

## §5 사용자 게이트 4옵션

(1) apply-all — 11건 전체 실행
(2) apply-selected — 선택한 ordinal만 실행
(3) dry-run-only — 산출물만 보존, mutation 0건
(4) abandon — 산출물 삭제, 종료
