# P0 잔여 작업 완성 가이드 + 핸드오프 (2026-07-03)

P0 구현(kiwi-pm run `2026-07-03.projectmaster.p0-native-perf`)의 독립 검증 결과, 잔여 결함을 해소하고 FR-BGSTAB-019를 완결하기 위한 차기 세션용 문서다.

## 1. 현재 상태 스냅샷

| 항목 | 값 |
|---|---|
| 브랜치 | `feature/buildergate-wave1-process-observation`, HEAD `d52e7d2` |
| **워킹트리** | **P0 구현 전체가 미커밋 상태** (23파일, +1348/-104 + 신규 `terminalOutputHotPath.ts`, plans/analysis 문서) |
| 테스트 기준선 | 서버 **312/312** PASS · 프론트 변경 테스트 34/34 · daemon 61/61 · 양쪽 typecheck PASS |
| config.json5 (미추적) | `processCleanup.mode: "enforce"`(:26), `visibleFlushBudgetBytes: 262144`(:86) |
| speckiwi | 5개 REQ 전부 `status=planned / stability=evolving / evidence=0` (의도적 — 완결 전 승급 금지) |
| pipeline 마지막 이벤트 | kiwi-pm `NEEDS_USER` (FR-019 soak 게이트) |

### 검증 판정 요약 (독립 검증자 3명 + 정적 분석, 2026-07-03)

| REQ | 판정 | 남은 것 |
|---|---|---|
| PERF-BGSTAB-001 | ✅ 완료 (AC 5/5) | 없음 (SRS 반영만) |
| PERF-BGSTAB-002 | ✅ 실질 완료 | AC-4 전용 테스트 (LOW) |
| PERF-BGSTAB-003 | ⚠️ **PARTIAL** | **R1** 호출횟수 회귀 가드 테스트 (AC-5 mandatory) |
| PERF-BGSTAB-004 | ✅ 완료 (AC 4/4) | 없음 (SRS 반영만) |
| FR-BGSTAB-019 | ❌ **미완** | **R3** soak + 영속화 + 롤백 문서화 |
| (정적 분석 신규) | — | **R2** sessionId stale closure |

---

## 2. 조치 항목 상세 가이드

### R1 [MEDIUM] PERF-BGSTAB-003 — 호출횟수 회귀 가드 테스트 추가

**왜**: SRS AC-5와 Implementation Notes가 "call-count regression guard is **mandatory**"로 명시. 현재는 `resolveInputDebugPayload`를 무조건 재계산으로 되돌려도 기존 테스트 34개가 전부 green — 회귀를 못 잡는다(과거 1회→3회 악화 전례가 이 REQ의 존재 이유).

**무엇을**: 키 입력 1회가 파이프라인(TerminalView onData → TerminalContainer handleInput → sequencer → transmitSequencedInput)을 통과할 때 `buildTerminalInputDebugPayload` 호출이 **≤1회**임을 단언하는 테스트.

**어떻게 (TDD)**:
1. 실패 재현 먼저: 가드 테스트를 작성하고, `TerminalContainer.tsx:114`의 `resolveInputDebugPayload`를 임시로 "metadata 무시하고 항상 build 호출"로 바꿔 red 확인 → 원복 후 green 확인. (구현은 이미 올바르므로 테스트만 추가하는 케이스 — red 실증은 임시 변형으로 수행)
2. 구현 힌트: `terminalDebugCapture.ts`의 build 함수를 모듈 spy로 감쌀 수 있게 counter export를 추가하거나(테스트 전용 `__getBuildCallCountForTest`), 컴포넌트 통합이 어려우면 **재계산의 역사적 지점을 직접 겨냥**: metadata가 이미 있는 `SequencedTerminalInput`을 `resolveInputDebugPayload`에 통과시켜 build가 0회 호출됨을 단언하는 유닛 테스트로도 AC-5의 정신 충족 가능(검증자 D-1 권고안).
3. 위치: `frontend/tests/unit/` 신규 또는 `terminalInputSequencer.test.ts` 확장. 역사적 회귀 지점(참고): TerminalContainer 구 재계산 위치 :363/:389/:626/:711/:1697 → 전부 `resolveInputDebugPayload(:114)` 경유로 교체된 상태.

**부수(D-2, LOW, 선택)**: `terminalInputSequencer.test.ts:49-91`의 throwing-codec 가드는 모듈 싱글턴이 import 시점에 캡처돼 재계산을 못 잡는다 — R1 테스트가 이를 대체하므로 필수는 아님.

**DoD**: 신규 가드 테스트 red(임시 변형)→green 확인, 전체 프론트 변경 테스트 green 유지.

### R2 [MEDIUM] sessionId stale closure 수정

**왜**: PERF-003 리팩터가 추가한 `resolveInputDebugPayload(..., sessionId)`가 컴포넌트 스코프의 `sessionId`를 캡처하는데 훅 의존성 배열에 없다. 탭 유지 상태에서 세션 재시작 시 옛 sessionId로 `isTerminalDebugCaptureEnabled`를 판정(텔레메트리 한정 오동작).

**어디를**:
- `frontend/src/components/Terminal/TerminalContainer.tsx:701-705` — useCallback deps에 `sessionId` 추가 (내부에서 resolveInputDebugPayload 사용). 같은 파일의 나머지 resolveInputDebugPayload 사용 콜백들도 deps 점검(사용 지점 5곳).
- `frontend/src/components/Terminal/TerminalView.tsx:1583` — useImperativeHandle deps에 `sessionId`(+기존 경고의 `queueFocusRestoreIfFocused`) 추가.

**주의**: deps 추가로 콜백이 재생성되면 하위 effect 재구독이 유발될 수 있음 — 추가 후 `npx eslint`로 신규 경고 0 확인 + `terminalViewRecoveryContract.test.ts` 등 관련 테스트 green 확인. 대안으로 `sessionIdRef` 패턴도 허용(기존 코드베이스에 ref 패턴 선례 다수).

**DoD**: ESLint에서 해당 2건 경고 소멸(기존 12건 외 신규 0), 프론트 테스트 green.

### R3 FR-BGSTAB-019 완결 (soak + 영속화 + 문서화)

검증자가 명시한 4개 잔여 항목:

**(a) [핵심] 2h 다중세션 soak 실행 + 증거 (AC-3)**
- 전제: 서버가 **enforce 모드로 실제 동작 중**이어야 함. 구현 세션에서 stale PID 67440이 재기동을 막았다(`docs/analysis/kiwi-planner-2026-07-03.projectmaster.p0-native-perf/implementation-evidence.md:99-108` 참조). daemon stop-client 개선분(이번 diff의 tools/daemon/*)이 이 문제 대응이므로 먼저 정상 재기동을 확인하라.
- **금지**: `taskkill /F /IM node.exe` 절대 금지(CLAUDE.md). stale PID는 대상 PID 지정 종료 또는 daemon stop 경로로만.
- 절차: ① 서버 재기동 후 `/health` + 시작 로그에서 `cleanup.mode:"enforce"` 확인 → ② 다중 세션(예: 8~16개)에서 자식 spawn 워크로드(detached 포함: `Start-Process`, 백그라운드 node 등)를 주기 실행 → ③ 세션 생성/삭제 반복 ≥2h → ④ 각 삭제 후 잔존 verified-descendant 0 확인(`/api/sessions/telemetry`의 cleanup 텔레메트리 + `Get-CimInstance Win32_Process` 대조) → ⑤ 증거를 `docs/analysis/.../soak-evidence-{date}.md`로 기록(시각, 세션 수, 종료 수, 잔존 0 확인 방법, 로그 발췌).
- observe 롤백 리허설 1회 포함 권장(config 되돌림→재기동→동작 확인→enforce 복귀).

**(b) enforce 활성화의 추적 가능한 영속화 (AC-1)**
- 현재 enforce는 **미추적** `server/config.json5`에만 있음. `server/config.json5.example:57`은 observe.
- 결정 필요(사용자 확인 권장): example을 enforce로 올릴지(신규 설치 기본 유도) vs example은 observe 유지 + 운영 런북에 활성화 절차 명시(보수적, 스키마 기본 observe 원칙과 정합). **후자 권장** — FR-019 statement 자체가 "스키마 기본값 불변, 운영 config 활성화"이므로.
- 실서버 재기동 후 실제 enforce로 동작함을 로그로 확인(검증 시점엔 observe로 돌고 있었음).

**(c) 롤백 경로의 추적 문서화 (AC-4)**
- 현재 config.json5 인라인 주석 + analysis 문서에만 존재. `docs/` 하위 추적 파일(예: 운영 가이드 또는 SRS Implementation Notes 갱신 — speckiwi `append_section_note` 사용)로 옮겨라. **SRS 파일 직접 Edit 금지(황금률)**.

**(d) speckiwi 반영**
- soak 완료 후: `add_verification_evidence`(soak 증거 경로) → `update_status(FR-BGSTAB-019, implemented)` → 검증 통과 시 verified. MCP mutation 도구만 사용.

**DoD**: soak 증거 문서 존재 + 서버가 enforce로 동작하는 로그 증거 + 롤백 문서 추적화 + speckiwi evidence/status 갱신.

### R4 [LOW] 부수 정리 (같은 커밋에 포함 권장)

1. **PERF-002 AC-4 테스트**: async 신원조회의 reject/timeout이 세션 생성에 영향 없음(null 귀결)을 단언하는 테스트 1건 — `server/src/test-runner.ts`에 추가. 구현(`.catch()` + execFile timeout)은 이미 존재.
2. **死코드**: `readProcessStartIdentitySync`(`server/src/utils/processTreeTerminator.ts:328`)가 무참조가 됨 — 제거 또는 deprecated 주석. 제거 시 관련 import/테스트 정리.
3. **SRS 동기화**: 완료 확정된 PERF-BGSTAB-001/002/003/004에 대해 `add_verification_evidence`(테스트/검증 보고 경로) + `update_status(implemented)`. 검증 보고 위치: 본 세션 대화 및 `docs/worklog/2026-07-03.jsonl` 첫 항목.
4. **trace 라인 드리프트(cosmetic)**: PERF-001의 SRS trace가 구 라인(config.json5:79, scheduler 52-105)을 가리킴 — 실제는 :86, drainFrame 77-141. 여유 있으면 `add_trace_link`로 갱신.

---

## 3. 커밋 전략 (권장)

1. **커밋 A (선행)**: R1+R2+R4-1,2 수정 후 — P0 구현 전체(현 워킹트리)를 커밋. 메시지 예: `feat: 키 입력 디버그 계산을 1회로 줄이고 세션 신원조회를 비동기화한다` (perf/feat 성격 혼재 시 지배적 변경 기준). 커밋 전: 서버 312+ green, 프론트 변경 테스트 green, ESLint 신규 경고 0, 시그니처 0건.
2. **커밋 B**: R4-3 SRS 반영(문서).
3. **커밋 C (soak 후)**: R3 증거 문서 + FR-019 SRS 갱신.
- 미추적 유지 대상: `.agents/`, `.kiwi/`, `.serena/`, `server/data/`, `kiwi/.pipeline-path`. `server/data/recovery-options.json`은 .gitignore 등재 검토(형제 파일들과 동일 패턴).

## 4. 참조 경로

- 검증 근거: `docs/worklog/2026-07-03.jsonl`(검증 요약), 계획 `docs/plans/2026-07-03.projectmaster.p0-native-perf.plan.md` + sidecar, 구현 증거 `docs/analysis/kiwi-planner-2026-07-03.projectmaster.p0-native-perf/implementation-evidence.md`
- SRS: `docs/spec/30.buildergate-stability.srs.md` (PERF-BGSTAB-001~004, FR-BGSTAB-019 블록)
- 테스트: 서버 `cd server && npx tsx src/test-runner.ts` / 프론트 `cd frontend && node --experimental-strip-types --test tests/unit/<파일>` / daemon `node --test tools/daemon/<파일>`
- **별도 트랙 주의**: recovery-option 테스트 red 6건(recoveryOptionDialog 3/8, recoveryOptionIcon 0/7)은 P0와 무관한 의도된 TDD red(MetadataRow 통합 미구현) — 이번 작업 범위 아님, 전체 스윕 green 기준에서 제외하고 판단.

## 5. 미결 사용자 결정 (이월)

| # | 항목 |
|---|---|
| 1 | R3-(b) example config enforce 반영 여부 (권장: example은 observe 유지 + 런북) |
| 2 | OQ-1/OQ-2 (REL-BGSTAB-005 shutdown 병렬 동시성 상한/타임아웃 스케일) — 유일한 draft 잔존 |
| 3 | P0-3b (observe 모드 신원조회 생략) 등록 여부 — FR-BGSTAB-009 AC-2 충돌로 보류 중 |
