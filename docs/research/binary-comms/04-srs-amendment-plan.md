# 바이너리 전환을 위한 SRS 개정 계획

| 항목 | 값 |
|---|---|
| 작성일 | 2026-08-16 |
| 대상 저장소 | `C:\Work\git\_Snoworca\ProjectMaster` (BuilderGate) |
| 대상 SRS | `docs/spec/30.buildergate-stability.srs.md`, `docs/spec/40.mcp-session-orchestration.srs.md` |
| 규칙 | `docs/rule/SRS-MD-Rules-v2.5.0.md` |
| 전제 | control 평면 JSON 유지, output/snapshot 평면만 바이너리. 즉시 도입 결정됨. 조건부 측정 게이트 계획 폐기됨. |
| 이 문서의 성격 | **계획 문서**. SRS 파일을 수정하지 않았고 speckiwi mutation 도구를 호출하지 않았다. |

---

## 0. 요약 (먼저 읽을 것)

조사 과정에서 **개정 전략 전체를 결정짓는 도구 제약 두 개**가 확인되었다. 이것이 이 계획의 형태를 만든다.

### 0.1 제약 A — speckiwi 는 기존 REQ 의 Statement 와 AC 텍스트를 편집할 수 없다

실측한 도구 표면:

```
$ npx speckiwi append-note --help
  --section <section>  rationale | research | implementation_notes
$ npx speckiwi check-ac --help
  (체크/해제만. 텍스트 편집 없음)
```

MCP `append_section_note` 의 스키마도 동일하고, `check_acceptance_criteria` 는 체크박스만 토글한다. `#### Requirement` 본문과 `#### Acceptance Criteria` 문구를 바꾸는 mutation 도구는 **존재하지 않는다**.

따라서 연구 과제 1이 제시한 네 선택지 중 **"AC 수정"은 도구로 표현 불가능한 선택지**다. 실제로 표현 가능한 이동은 두 가지뿐이다.

1. **전체 REQ supersede** — `add_requirement`(신규) + `add_trace_link(supersedes)` + 구 REQ `update_status(discarded)`. 규칙 §29.3/§30 상 supersede 는 **요구사항 단위**이며 부분 AC 단위가 아니다.
2. **신규 REQ + `extends`/`refines` trace + `append_section_note`** — 구 REQ 의 Status·Stability·본문을 건드리지 않고, 신규 REQ 가 그 표면을 확장·구체화한다고 그래프에 기록한다.

차단 REQ 12건 중 **전체 폐기(discard)가 정당한 것은 0건**이다(§2 참조). 그러므로 이 계획의 지배 전략은 (2)이며, `supersedes` 는 사용하지 않는다.

> [설계결정] "부분 AC supersede"를 흉내내려고 구 REQ 를 discarded 로 내리고 신규 REQ 로 통째로 재작성하는 방식은 거부한다. FR-BGSTAB-008 은 검증 증거 11건, REL-BGSTAB-007 은 6건과 wave-3 하위 REQ 다수의 `depends_on` 대상이다. 이들을 discarded 로 만드는 것은 CLAUDE.md 의 "bulk-archive 금지 / 증거 없는 상태 전이 금지" 정신에 정면으로 어긋나며, 실제로는 바이너리와 무관한 계약(프로세스 정리, 큐 예산, Settings 계약)까지 함께 사장시킨다.

### 0.2 제약 B — Scope Boundaries(§2) 를 고치는 mutation 도구가 없다

`append_section_note` 는 `req-scoped` 이며 `id` 를 요구한다(규칙 §30.3). Scope 문서의 `### In Scope` / `### Out of Scope` 불릿은 어떤 mutation 도구의 사정거리에도 들어오지 않는다. `speckiwi scaffold-scope` 도 이 버전 CLI 에 없다(`speckiwi --help` 실측 — 명령 목록에 부재).

따라서 연구 과제 3(Out-of-Scope 개정)은 **도구 공백**이며, CLAUDE.md 의 "If the configured MCP/CLI cannot register the target, stop ... unless the user explicitly authorizes a minimal SRS-MD patch" 절차를 따라 **사용자 명시 승인 후 최소 수동 패치**로만 진행해야 한다. 이 패치는 Requirement ID 를 건드리지 않고 Status/Stability 를 바꾸지 않으므로 금지 조항(수동 ID 편집, bulk-archive, 증거 없는 verified)에 저촉되지 않는다.

### 0.3 확인된 좋은 소식 — "차단 조항" 중 상당수는 실제로 차단하지 않는다

| 조항 | 통념 | 실제 |
|---|---|---|
| `REL-BGSTAB-007` AC-11 | 바이너리 기본화를 금지 | **금지가 아니라 경로 지정.** 원문은 "자동 승인하지 않는다 ... 각각 **별도 Requirement, TDD, rollout evidence와 사용자 승인이 필요하다**". 우리가 하려는 일이 정확히 그 경로다. **개정 불필요.** |
| `PERF-BGSTAB-009` AC-7 | 바이너리 WebSocket 금지 | **자기 범위 면책 선언.** "이 Requirement는 binary WebSocket 을 변경하지 않는다" — 타 REQ 를 구속하지 않는다. 게다가 `string\|Uint8Array` staged path 를 이미 열어두었다(= enabler). **개정 불필요.** |
| `REL-BGSTAB-007` AC-4 | Ordinal64 를 decimal string 으로 고정 | 원문은 "**JSON wire 에서는** canonical unsigned decimal string 으로만". 바이너리 프레임은 JSON wire 가 아니다 → **모순이 아니라 미규정 공백**. 신규 REQ 가 공백을 메운다. |

즉 실제 개정 노동은 처음 추정보다 작다. 남는 진짜 작업은 (a) Scope Boundaries 2건 수동 패치, (b) 신규 REQ 4건, (c) 기존 REQ 6건에 노트 부착, (d) 재벤치마크 의무의 명문화다.

---

## 1. 사전 확인된 사실 (실측)

```
$ npx speckiwi validate --json   →  summary: {"errors":1,"warnings":19,
                                     "byCode":{"SRS-W018":5,"SRS-W023":14,"SRS-E002":1}}
$ npx speckiwi summary --target wave-5 --json
   → total: 0, countsByStatus: {}, goal: "binary/split adopt-or-skip, all-consumer convergence,
     reversible default, two-release soak와 안전한 legacy physical deletion을 수행한다."
$ npx speckiwi active-target        → wave-3
```

- `wave-5` 는 `docs/spec/00.index.md:37` Target Map 에 **이미 등록**되어 있고 Goal 도 이미 설정되어 있다(`00.index.md:45-47`). **신규 target 생성 불필요** → `set_active_target` 스키마에 `create` 파라미터가 없다는 점(실측)이 문제가 되지 않는다.
- BGSTAB scope 의 사용 중 prefix: `FR`(≤023), `REL`(≤019, 단 013–015 는 step SRS 에도 존재), `PERF`(≤010), `MIG`(≤003), `OBS`(≤007), `OPS`(≤007). `IR` · `DR` · `NFR` · `CON` 은 **미사용**.
- 기준선 진단 3종은 전부 **본 작업과 무관한 기존 부채**다: `SRS-E002`×1 은 step SRS 의 `REL-BGSTAB-015` 중복, `SRS-W018`×5 는 Scope Map 에 미등록된 step SRS 문서, `SRS-W023`×14 는 `Stability=draft` 요구사항.

---

## 2. 연구 과제 1 — 차단 REQ 별 처리 방식

범례: **[유지]** 변경 불필요 · **[노트]** `append_section_note` 로 주석만 부착 · **[패치]** 수동 SRS-MD 패치(승인 필요) · **[supersede]** 전체 대체.

### 2.1 결정 요약표

| REQ ID | Status / Stability | 결정 | 도구 | 사유 요약 |
|---|---|---|---|---|
| `FR-BGSTAB-001` (AC-3) | implemented / **stable** | **[유지]** | 없음 | `wsTransportMode` enum 을 건드리지 않는 설계를 채택. §2.2 참조 |
| `FR-BGSTAB-006` | implemented / **stable** | **[유지]** | 없음 | 핸드셰이크는 인코딩 불가지(agnostic). 페어 토큰 계약 불변 |
| `FR-BGSTAB-007` | implemented / **stable** | **[노트]** | `append_section_note(implementation_notes)` | 라우팅 계약은 "terminal payload" 추상에 걸려 있어 인코딩 중립. 단 **fallback 시 바이너리 유지** 규칙이 미규정 → 신규 REQ 가 규정 |
| `FR-BGSTAB-008` (AC-5) | implemented / **stable** | **[노트]** | `append_section_note(implementation_notes)` | 진짜 충돌. `/api/runtime-config` 허용목록이 열거형. 신규 REQ 가 `refines` 로 항목 1개 확장 |
| `FR-BGSTAB-012` | implemented / **stable** | **[유지]** | 없음 | UTF-8 byte cap 은 **headless pending queue**(wire 이전) 대상. transport 계층은 이미 encoded-byte 회계 |
| `REL-BGSTAB-007` (AC-4/AC-11) | planned / **stable** | **[노트]** | `append_section_note(implementation_notes)` | AC-11 은 경로 지정이지 금지가 아님. AC-4 는 JSON wire 한정 → 공백 메우기 |
| `PERF-BGSTAB-010` | **in_progress** / evolving | **[노트]** | `append_section_note(research)` | 임계값은 AC 텍스트가 아니라 evidence bundle 세대에 있음. 바이너리 세대 재발행이 답 |
| `FR-BGSTAB-016` (AC-3/4) | planned / evolving | **[유지]** | 없음 | `bufferedAmount + payload bytes` 는 바이너리에서도 성립. 단 병합 재분할 문제는 신규 REQ 소관 |
| `REL-BGSTAB-003` (Rationale) | planned / evolving | **[노트]** | `append_section_note(rationale, mode=append)` | 충돌은 AC 가 아니라 Rationale 문구. **유일하게 도구로 직접 고칠 수 있는 항목** |
| `PERF-BGSTAB-009` (AC-7) | implemented / evolving | **[노트]** | `append_section_note(implementation_notes)` | 자기 범위 면책 선언. `Uint8Array` staged path 는 enabler |
| `REL-BGSTAB-006` (AC-5) | implemented / evolving | **[유지]** | 없음 | split disposition unresolved 유지 = 우리 설계와 무모순(바이너리 ≠ split) |
| `30.*:27` Out of Scope | (scope 레벨) | **[패치]** | 수동 (승인 필요) | §4 참조 |
| `40.*:27` Out of Scope | (scope 레벨) | **[패치]** | 수동 (승인 필요) | §4 참조 |

**`discard` 0건, `supersede` 0건.**

### 2.2 Stability=stable 6건 상세

> 연구 과제 1은 "stable 6건은 supersede 에 무엇이 필요한지 구체적으로" 쓰라고 요구했다. 아래에 (a) supersede 를 하려면 무엇이 필요한지, (b) 그럼에도 **왜 하지 않는지**를 REQ 별로 쓴다.

#### supersede 를 하려면 필요한 것 (규칙상 완전한 절차)

SRS-MD Rules v2.5.0 §29.3 + §30 + CLAUDE.md 워크플로를 합치면 stable REQ 1건 supersede 의 최소 절차는 다음과 같다.

1. **신규 REQ 작성** — `add_requirement`(ID 자동 할당. 수동 ID 지정 금지). 구 REQ 의 **모든 AC 를 흡수**해야 한다. 흡수하지 않고 버리는 AC 가 있으면 그것은 supersede 가 아니라 계약 축소이며 별도 사용자 승인 사안이다.
2. **trace link** — 신규 REQ 쪽에 `add_trace_link(id=<신규>, type=Requirement, reference=<구 REQ>, relation=supersedes)`. 방향이 중요하다: §30.1 은 discarded 헤딩 마커(`[DISCARDED → see REQ-Y]`)의 후속자를 **"이 요구사항을 가리키는 행"** 을 스캔해서 찾는다. 구 REQ 자기 표에 `supersedes` 를 넣으면 마커가 빈 채로 남는다.
3. **메타데이터 권장 필드** — §23.4.5 상 `Supersedes` / `Superseded By` 행 갱신이 권장되나, 이를 쓰는 mutation 도구가 없다(=또 하나의 도구 공백). 생략하거나 승인된 수동 패치가 필요하다.
4. **TDD** — CLAUDE.md 및 규칙상 동작 변경이므로 실패 테스트 선행 → 최소 구현 → 회귀. 신규 REQ 의 모든 AC 가 자동 테스트로 커버되어야 한다.
5. **검증 증거** — `add_verification_evidence` 로 AC 커버리지가 `all` 또는 개별 AC 를 덮도록. `check_acceptance_criteria` 로 전 AC 체크. 그 다음에야 `update_status(verified)` 가 `MUTATION_DENIED` 없이 통과한다(§14.2).
6. **구 REQ 폐기** — `update_status(<구 REQ>, discarded)`. 구 REQ 가 `verified` 였다면 `confirmDiscardVerified` 가 필요하다(§14.2).
7. **참조 정리** — 구 REQ 를 `depends_on` 하던 모든 REQ 의 trace 를 신규 REQ 로 재지정. **이것이 실질 비용의 대부분이다.**

#### REQ 별 판단

**`FR-BGSTAB-001` — Runtime resource limits (AC-3: `wsTransportMode` enum `unified|split-shadow|split` 닫힘, "unsupported modes fall back to unified")**

- supersede 비용: 이 REQ 는 `FR-BGSTAB-006`, `FR-BGSTAB-008` 이 `depends_on` 한다. AC-1/AC-2 는 바이너리와 무관한 런타임 설정 파싱 계약이며 그대로 다시 써야 한다.
- **결정: [유지].** [설계결정] 바이너리 프레이밍을 `wsTransportMode` 의 **네 번째 값으로 만들지 않는다.** `wsTransportMode` 는 *소켓 토폴로지*(unified/split), 바이너리는 *페이로드 인코딩*이다. 두 축을 한 enum 에 합치면 `unified-json / unified-binary / split-json / split-binary / split-shadow-json / split-shadow-binary` 의 곱집합이 되고, 기존 6개 REQ 의 "unsupported → unified fallback" 규칙이 인코딩 폴백까지 떠맡는다. §10.1(한 개념에 진입점 하나), §10.2(개념 단위 중복 금지) 위반이다.
- 대신 **직교 키 `realtime.terminalWireFormat: 'json' | 'binary'`** 를 신설한다(신규 `IR-BGSTAB-001` 소관). AC-3 의 닫힌 enum 은 `wsTransportMode` 에만 적용되므로 문구 그대로 계속 참이다.
- 잔여 리스크: `/api/runtime-config` 허용목록(`FR-BGSTAB-008` AC-5)은 여전히 확장이 필요하다 → 아래 항목으로 이동.

**`FR-BGSTAB-006` — Split handshake and channel isolation**

- 다섯 AC 전부가 페어 토큰·인증 신원·중복 소켓·shadow 격리를 다룬다. **payload 인코딩을 한 글자도 언급하지 않는다.**
- **결정: [유지].** 개정 사유가 없다. 바이너리 capability 협상은 이 핸드셰이크의 *메타데이터*가 아니라 별도 negotiation(=`MIG-BGSTAB-002` 의 capability 협상 재사용)에 올린다.

**`FR-BGSTAB-007` — Split payload routing and failure recovery**

- 진짜 미규정 지점: AC-3/AC-4 의 "control socket 으로 fallback" 이 **바이너리 프레임에 대해 무엇을 의미하는가**. 두 해석이 가능하다.
  - (i) fallback 시 JSON 으로 재인코딩 → **거부.** 인코더 경로가 둘이 되어 §10.2 중복이고, 재인코딩 실패 모드가 새로 생긴다.
  - (ii) control socket 이 그 프레임만 바이너리로 운반 → **채택.** WebSocket 은 프레임 단위로 텍스트/바이너리를 섞을 수 있다. "control 평면 JSON 유지"는 *control 메시지의* 인코딩 규약이지 소켓의 물리 제약이 아니다.
- **결정: [노트] + 신규 REQ 가 (ii) 를 명문화.** AC 텍스트는 인코딩 중립이므로 그대로 참이다. supersede 하면 AC 7개를 전부 재작성해야 하고 `REL-BGSTAB-003`·`REL-BGSTAB-006` 의 `extends` 링크가 끊긴다. 이익 대비 손실이 크다.

**`FR-BGSTAB-008` — Wave 0 baseline config contract (AC-5: `/api/runtime-config` 허용목록)**

- **여섯 건 중 유일하게 문면상 진짜 충돌**이다. AC-5 는 "the response exposes **only** non-secret public values: inputReliabilityMode, wsTransportMode, browser-needed resourceLimits sections, and frontendRuntimeResidency mode" — 닫힌 열거다. `terminalWireFormat` 을 노출하면 이 문장은 거짓이 된다.
- supersede 비용: 검증 증거 **VE-1~VE-11 (11건)**, AC 6개 전부 체크됨, `FR-BGSTAB-012` 가 `depends_on`. 전량 재작성 + 증거 재수집.
- **결정: [노트] + 신규 REQ 의 `refines` 링크.** 신규 `IR-BGSTAB-001` 의 Statement 가 "허용목록에 `realtime.terminalWireFormat` 하나를 **추가**하며 그 외 비밀·비공개 값은 계속 노출하지 않는다"를 명시적으로 선언하고, `add_trace_link(IR-BGSTAB-001 → FR-BGSTAB-008, refines)` 로 그래프에 기록한다. `FR-BGSTAB-008` 에는 implementation_notes 로 확장 지점을 남긴다.
- [설계결정] 이것이 규칙 안에서 "AC 를 부분 개정"에 가장 가까운 유일한 표현이다. 대안(구 REQ discard)은 Wave 0 baseline 자체를 사장시킨다. **단, 이 처리는 AC-5 문면과 구현이 어긋난 상태를 남긴다는 점을 정직하게 기록해야 한다** — 그래서 노트가 필수이며 선택이 아니다.

**`FR-BGSTAB-012` — Wave 4 bounded output queues (큐 예산 UTF-8 byte)**

- AC-2 의 "UTF-8 byte caps" 는 **headless pending output queue** 대상이다. 이 큐는 PTY 에서 나온 서버 내부 문자열을 담으며 wire 인코딩 이전 단계다. 바이너리 전환은 이 지점을 지나가지 않는다.
- AC-6/AC-7 의 transport queue 는 `bufferedAmount`·"queued/coalesced bytes" 로 이미 바이트 회계이고, `PERF-BGSTAB-010` AC-5 가 이미 "실제 encodedBytes ledger"를 요구한다 → 인코딩 인지 회계가 이미 계약에 있다.
- **결정: [유지].** 신규 REQ 는 "바이너리 프레임의 encodedBytes = 프레임 페이로드 바이트 길이"만 정의하면 된다.
- **단 하나의 실제 위험**: AC-7 의 same-session **인접 병합(coalescing)**. JSON 메시지 병합은 배열/구분자로 재분할이 가능했지만, 바이너리 페이로드를 단순 연결하면 수신측이 레코드 경계를 복원할 수 없다. → 신규 `IR-BGSTAB-001` 이 **길이 접두(length-prefixed) 레코드 프레이밍**을 강제해야 한다. 이것을 놓치면 병합 경로에서 조용한 데이터 손상이 난다.

**`REL-BGSTAB-007` — Configured retained-state server authority (AC-4 Ordinal64, AC-11 비승인 조항)**

- **AC-11**: 원문 재확인 — "이 Requirement는 ... WebGL/binary/split 기본화 ... 를 **자동 승인하지 않는다**. 각각 별도 Requirement, TDD, rollout evidence와 사용자 승인이 필요하다." 이것은 금지가 아니라 **절차 요구**다. 사용자 승인은 확보되었고, 이 계획이 별도 Requirement·TDD·rollout evidence 를 조달한다. **개정 대상 아님.**
- **AC-4**: "Ordinal64는 streamEpoch 안의 unsigned 64-bit ordinal이며 **JSON wire에서는** canonical unsigned decimal string으로만 표현하고 내부 비교는 정밀도를 잃지 않는 정수 연산을 사용해야 한다." → 조건절이 `JSON wire` 로 한정되어 있다. 바이너리 프레임의 ordinal 표현은 **미규정**이다.
- supersede 비용: AC 12개, 검증 증거 6건, `MIG-BGSTAB-002`·`REL-BGSTAB-012`·`PERF-BGSTAB-009` 가 `depends_on`/`extends`, Task trace 27행. 사실상 wave-3 전체의 앵커. **절대 폐기 불가.**
- **결정: [노트] + 신규 REQ 가 공백을 메움.** 신규 `IR-BGSTAB-001` 이 "Ordinal64 의 바이너리 표현은 고정폭 unsigned 64-bit 정수이며, 동일 ordinal 의 JSON canonical decimal string 표현과 무손실 왕복(round-trip)해야 한다"를 규정한다. 두 표현이 같은 값을 낸다는 것이 AC 로 검증되면 AC-4 는 계속 참이다.

### 2.3 evolving 6건 상세

**`PERF-BGSTAB-010` (in_progress/evolving) — 재벤치마크 필요**

- Research 노트(:3715) 원문: "Orca data batcher의 ... 원칙을 이식하되 WebSocket/WAN, **JSON encoding**과 다중 client 조건에 맞춰 algorithm과 숫자는 benchmark/policy로 결정한다."
- 중요한 구조적 사실: **AC 텍스트에는 숫자가 없다.** AC-3/AC-4 는 임계값을 "현재 authoritative evidence bundle" 과 `TerminalResourcePolicy` 에서 **파생**하도록 되어 있고, AC-3 은 "publication generation" 개념을 이미 갖고 있다. 즉 인코딩이 바뀌면 **새 bundle 세대를 발행**하는 것이 계약이 이미 예상한 동작이다.
- **결정: [노트](`research` 섹션) + 재벤치마크 의무를 신규 `PERF-BGSTAB-011` 의 AC 로 편입.** Status 는 `in_progress` 유지(임의 전이 금지).
- ⚠️ 운영 함정 (기억된 사실, 재확인 필요): fair-scheduler provenance 는 워킹트리가 아니라 **HEAD** 를 읽는다. 그리고 `write-fair-scheduler-evidence-bundle.mjs` 가 `docs/analysis/terminal-fairness-authority/` 의 sha256 매니페스트를 재검증해 불일치 시 **server build 를 throw** 시킨다 → 루트 build 스크립트 18개 + CI + Playwright 가 전부 깨진다. 그러므로 순서는 반드시 **코드 커밋 → republish → 증거 커밋**.

**`FR-BGSTAB-016` (planned/evolving) — AC-3/AC-4**

- AC-3 `bufferedAmount + payload bytes`: `ws` 의 `bufferedAmount` 는 텍스트/바이너리 무관하게 바이트 수다. `payload bytes` 는 바이너리에서 `ArrayBuffer.byteLength`. **성립.**
- AC-4 same-session 인접 병합 + byte limit: 위 `FR-BGSTAB-012` 와 동일한 레코드 프레이밍 이슈. AC-4 는 "무엇을 병합해도 되는가"를 규정하고 "어떻게 재분할하는가"는 규정하지 않는다 → 신규 REQ 소관.
- **결정: [유지].** `planned`+`evolving` 이라 개정이 가장 싼 대상이긴 하나, **표면당 1개 원칙**에 따라 바이너리 프레이밍을 여기 끼워넣지 않는다. `extends` 링크로 연결.

**`REL-BGSTAB-003` (planned/evolving) — Rationale "Current replay state is string-tail based"**

- 충돌 지점이 **AC 가 아니라 Rationale 문구**다. 그리고 `append_section_note(section=rationale)` 는 도구가 지원한다. **12건 중 유일하게 원문을 직접 갱신할 수 있는 항목.**
- AC-1 "truncation is byte-aware ... does not split UTF-8 characters" 는 바이너리에서도 **그대로 필요**하다 — 프레임 안의 터미널 페이로드는 여전히 UTF-8 이고, 프레임 경계에서 문자를 쪼개면 안 된다. 오히려 바이너리에서 구현이 쉬워진다.
- **결정: [노트](`rationale`, `mode=append`).** AC 불변, Status/Stability 불변.

**`PERF-BGSTAB-009` (implemented/evolving) — AC-7**

- AC-7 원문: "Production ingress는 string을 유지하고 scheduler-to-xterm 구간만 `string|Uint8Array` compatible staged path로 확장한다. 이 Requirement는 binary WebSocket ... 을 변경하지 않는다."
- 두 문장의 성격이 다르다. 둘째 문장은 자기 범위 면책이며 타 REQ 를 구속하지 않는다. 첫 문장은 *그 요구사항이 인도한 시점의 상태 기술*이며 `[x]` 로 체크되어 있다.
- **결정: [노트](`implementation_notes`).** AC-7 을 **체크 해제하지 않는다.** 해제하면 그 시점에 실제로 통과했던 검증 증거(VE-1~VE-4)를 사후적으로 거짓으로 만들고, `verified` 조건(§14.4)과 무관하게 이력을 오염시킨다. 규칙 §21.3.6 도 AC 삭제·약화를 금지한다.
- staged path(`string|Uint8Array`)는 이 계획의 **1급 enabler** 다. 신규 REQ 는 이 경로를 새로 만들지 않고 소비한다.

**`REL-BGSTAB-006` (implemented/evolving) — AC-5**

- AC-5 는 split disposition 을 unresolved 로 유지하고 split runtime 활성화를 금지한다. 본 계획은 **split 을 활성화하지 않는다**(바이너리는 인코딩 축, split 은 토폴로지 축). **무모순.**
- **결정: [유지].** 노트도 불필요.

---

## 3. 연구 과제 2 — 신규 요구사항 초안

### 3.1 설계 원칙

- **표면당 1개.** 네 개의 검증 표면이 서로 다른 Verification Method 를 요구한다(규칙 §29.1 "Different verification methods are required" → 분할 사유).
  1. 와이어 포맷 + 협상 (프로토콜 계약 테스트)
  2. 생산자/소비자 수렴 (정적 caller contract 테스트 + 통합)
  3. 공정 전달·백프레셔 회계 (벤치마크 + evidence bundle 재발행)
  4. 기본값 전환·롤백·soak (E2E drill + 릴리스 soak)
- **4개 미만으로는 못 줄인다.** 3을 2에 합치면 벤치마크 증거와 계약 테스트가 한 REQ 에 섞여 AC 목록이 길어지고(§29.1 case 5), 4를 1에 합치면 "포맷이 존재한다"와 "포맷이 기본값이다"가 같은 REQ 가 되어 롤백이 계약 위반이 된다.
- 전부 scope `BGSTAB`, 문서 `30.buildergate-stability.srs.md`. [설계결정] 신규 scope 문서(`50.*`)를 만들지 않는다 — (a) `scaffold-scope` CLI 가 이 버전에 없어 Scope Map 2곳 수동 등록이 필요하고 `SRS-W018` 증가 위험이 있으며, (b) 바이너리 데이터 평면은 BGSTAB 의 In Scope 주제(WebSocket transport / terminal output)와 동일 계층이다(§10.2 "새 계층 만들기 전에 기존 계층에 자리 확인").
- **ID 는 `add_requirement` 가 자동 할당**한다. 아래 ID 는 *예측*이며 수동 지정하지 않는다. [추측] 관측된 최댓값 기준 예측: `IR-BGSTAB-001`, `FR-BGSTAB-024`, `PERF-BGSTAB-011`, `MIG-BGSTAB-004`. 실제 할당값이 다르면 그 값을 그대로 쓰고 이 문서를 사후 갱신한다.
- 전부 `Target=wave-5`, `Status=planned`, **`Stability=evolving`**. `stability` 를 생략하면 도구가 `draft` 를 적용해 `SRS-W023` 이 4건 늘고, CLAUDE.md 상 draft 는 구현 착수가 금지된다(§5 검증 계획 참조).

### 3.2 REQ-1 · `IR-BGSTAB-001` — 터미널 데이터 평면 바이너리 와이어 포맷과 능력 협상

| Field | Value |
|---|---|
| Type | `interface` |
| Target | `wave-5` |
| Status | `planned` |
| Priority | `critical` |
| Risk | `high` |
| Stability | `evolving` |
| Tags | `buildergate, wave-5, binary-wire, data-plane, negotiation, ordinal64, framing` |
| Verification Method | 프레임 인코더/디코더 왕복 property 테스트, Ordinal64 이진↔JSON canonical decimal string 등가 테스트(0 / 1 / 2^53-1 / 2^53 / 2^63 / 2^64-1 경계), 길이 접두 레코드 재분할 fuzz, 협상 실패·다운그레이드 경로 계약 테스트, `/api/runtime-config` 응답 필드 화이트리스트 테스트, split fallback 시 프레임 타입 보존 통합 테스트 |

**Statement (EARS)**

> 시스템은 control 평면 메시지를 JSON 텍스트 프레임으로 유지하면서, terminal output·checkpoint·replay·screen-repair 페이로드를 능력 협상으로 합의된 경우에 한해 길이 접두 레코드로 구성된 단일 바이너리 WebSocket 프레임 포맷으로 전송해야 한다. 협상이 성립하지 않거나 협상된 세대가 무효화되면 시스템은 동일 페이로드를 기존 JSON 표현으로 전송해야 한다.

**Acceptance Criteria (초안)**

- AC-1: 바이너리 프레임은 magic/version, frame kind, `sessionId`, `streamEpoch`, `deliverySeq` 를 포함한 고정폭 헤더와 그 뒤 0개 이상의 **길이 접두 레코드**로 구성되고, 수신측은 프레임 바이트만으로 레코드 경계를 결정론적으로 복원해야 한다. 헤더 version 이 미지원이면 프레임을 폐기하지 않고 관측 가능한 프로토콜 오류로 수렴해야 한다.
- AC-2: `sourceSeq`, `snapshotSeq`, `oldestRetainedSeq` 및 checkpoint/apply/drain/delivery ACK 가 운반하는 모든 Ordinal64 는 바이너리 프레임에서 고정폭 unsigned 64-bit 정수로 표현되며, 동일 ordinal 의 JSON canonical unsigned decimal string 표현과 무손실 왕복해야 한다. `0`, `1`, `2^53-1`, `2^53`, `2^63`, `2^64-1` 경계에서 두 표현의 값이 같음을 테스트로 증명해야 한다. (`REL-BGSTAB-007` AC-4 의 JSON 표현 규정은 변경하지 않는다.)
- AC-3: 능력 협상은 `MIG-BGSTAB-002` 의 capability 협상과 rollback epoch 위에서 수행되고, 한 `streamEpoch` 안에서 데이터 평면 인코딩은 JSON 또는 binary 중 하나로만 고정되어야 하며 같은 epoch 에서 두 인코딩을 혼합해서는 안 된다.
- AC-4: 협상 실패, 클라이언트 미지원, 디코드 실패와 rollback 은 새 `streamEpoch` 와 fresh checkpoint 로 JSON 데이터 평면에 복귀해야 하며, byte tail 을 임의로 이어붙이거나 silent tail 로 수렴해서는 안 된다.
- AC-5: control 평면 메시지(input, resize, subscribe, unsubscribe, ACK, repair request, ping, status, 입력 거부)는 협상 결과와 무관하게 JSON 텍스트 프레임을 유지해야 한다.
- AC-6: `FR-BGSTAB-007` 의 split fallback 경로에서 바이너리 terminal payload 가 control socket 으로 재라우팅될 때 프레임은 바이너리 형식을 유지해야 하며, JSON 으로 재인코딩하는 두 번째 인코더 경로를 만들어서는 안 된다.
- AC-7: 데이터 평면 인코딩은 `wsTransportMode` 와 독립된 런타임 설정 키 `realtime.terminalWireFormat`(`json` | `binary`)로 제어되고, `wsTransportMode` 의 기존 닫힌 enum(`unified|split-shadow|split`)과 그 fallback 규칙을 변경해서는 안 된다.
- AC-8: `/api/runtime-config` 응답은 `FR-BGSTAB-008` AC-5 의 기존 공개 값에 `realtime.terminalWireFormat` **하나만** 추가로 노출하고, 그 외 비밀·비공개 설정 값을 새로 노출해서는 안 된다.
- AC-9: 이 Requirement 는 데이터 평면 기본 인코딩을 binary 로 전환하지 않으며, 기본값 전환은 `MIG-BGSTAB-004` 소관이다.

**의존 관계 (`add_trace_link`)**

| Type | Reference | Relation | Notes |
|---|---|---|---|
| Requirement | `MIG-BGSTAB-002` | `depends_on` | capability 협상과 rollback epoch 재사용 |
| Requirement | `PERF-BGSTAB-009` | `depends_on` | `string\|Uint8Array` staged path 소비 |
| Requirement | `REL-BGSTAB-007` | `extends` | Ordinal64 의 바이너리 표현 공백을 메움 (AC-4 의 JSON 규정 불변) |
| Requirement | `FR-BGSTAB-007` | `extends` | split fallback 시 프레임 형식 보존 규칙 추가 |
| Requirement | `FR-BGSTAB-008` | `refines` | `/api/runtime-config` 허용목록을 필드 1개 확장 |
| Requirement | `FR-BGSTAB-001` | `depends_on` | 런타임 설정 파싱·fallback 계약 |
| Doc | `docs/research/binary-comms/04-srs-amendment-plan.md` | `informed_by` | 본 개정 계획 |

### 3.3 REQ-2 · `FR-BGSTAB-024` — 바이너리 데이터 평면 생산자·소비자 단일 경로 수렴

| Field | Value |
|---|---|
| Type | `functional` |
| Target | `wave-5` |
| Status | `planned` |
| Priority | `critical` |
| Risk | `high` |
| Stability | `evolving` |
| Tags | `buildergate, wave-5, binary-wire, all-consumer-convergence, sole-writer, decoder` |
| Verification Method | 모든 production 송신·수신 caller 에 대한 정적 contract 테스트(두 번째 인코더/디코더 경로 부재 증명), 서버 encode ↔ 브라우저 decode 왕복 corpus 테스트(ASCII/CJK-wide/combining/ZWJ emoji/split ANSI/alternate buffer), checkpoint 청크 순서·digest 검증, `https://localhost:2222` refresh/remount/reveal E2E |

**Statement (EARS)**

> 바이너리 데이터 평면이 협상된 세션에서, 시스템은 모든 terminal output·checkpoint·replay·screen-repair 페이로드를 단일 서버 인코더와 단일 브라우저 디코더 쌍을 통해서만 생산·소비해야 하며, 디코드된 페이로드는 기존 `TerminalWriteCoordinator` sole-writer 트랜잭션과 동일한 순서 계약으로 적용되어야 한다.

**Acceptance Criteria (초안)**

- AC-1: 협상된 세션의 모든 terminal payload 송신은 단일 인코더 진입점을 통과해야 하고, 정적 caller contract 테스트가 이를 우회하는 production 송신 경로가 0개임을 증명해야 한다.
- AC-2: 브라우저의 모든 terminal payload 수신은 단일 디코더 진입점을 통과해야 하고, 디코드 산출물은 `PERF-BGSTAB-009` 의 `string|Uint8Array` staged path 를 통해 `FR-BGSTAB-022` 의 `TerminalWriteCoordinator` 로 전달되어야 한다.
- AC-3: ASCII, BMP CJK-wide, combining sequence, ZWJ/emoji, split ANSI, normal/alternate buffer, resize/reflow corpus에서 바이너리 경로의 최종 terminal state hash 가 동일 입력의 JSON 경로 결과와 정확히 같아야 한다.
- AC-4: checkpoint chunk index/count, total encoded bytes 와 content digest 는 바이너리 표현 위에서 계산·검증되어야 하며, missing/duplicate/out-of-order chunk 와 digest mismatch 는 empty success 나 silent tail 이 아니라 명시적 실패와 새 epoch fresh checkpoint 로 수렴해야 한다.
- AC-5: 디코드 실패, 미지원 frame kind 와 잘린 레코드는 해당 view 를 stale 로 만들고 관측 가능한 사유를 남겨야 하며, PTY producer 또는 다른 client 를 중단해서는 안 된다.
- AC-6: 사용자 input, local echo, prompt redraw, cursor movement 와 waiting-for-input repaint 는 바이너리 경로에서도 interactive AI TUI session 을 running 으로 전환해서는 안 된다.
- AC-7: 이 Requirement 는 hidden renderer residency 정책, UI visual·label·layout, snapshot localStorage 예산과 legacy JSON 데이터 평면 코드의 물리 삭제를 변경하지 않는다.

**의존 관계**

| Type | Reference | Relation |
|---|---|---|
| Requirement | `IR-BGSTAB-001` | `depends_on` |
| Requirement | `FR-BGSTAB-022` | `extends` |
| Requirement | `REL-BGSTAB-011` | `extends` |
| Requirement | `REL-BGSTAB-012` | `extends` |
| Requirement | `PERF-BGSTAB-009` | `depends_on` |
| Requirement | `REL-BGSTAB-003` | `depends_on` |

### 3.4 REQ-3 · `PERF-BGSTAB-011` — 바이너리 인코딩 기준 공정 전달 회계와 증거 번들 재발행

| Field | Value |
|---|---|
| Type | `performance` |
| Target | `wave-5` |
| Status | `planned` |
| Priority | `high` |
| Risk | `high` |
| Stability | `evolving` |
| Tags | `buildergate, wave-5, binary-wire, fair-scheduler, encoded-bytes, evidence-bundle, rebenchmark` |
| Verification Method | 동일 seed·warm-up·trial·hardware 의 paired run 으로 JSON 세대 대비 binary 세대 벤치마크, lane 별 p50/p95/p99/max service·control latency 와 maximum no-service interval 비교, 길이 접두 레코드 병합·재분할 fuzz, `PERF-BGSTAB-010` AC-3 규격을 만족하는 신규 evidence bundle 발행과 sha256 provenance 재검증 |

**Statement (EARS)**

> 바이너리 데이터 평면이 활성인 동안, 시스템은 공정 전달 스케줄러와 ACK credit ledger 의 `encodedBytes` 를 실제 바이너리 프레임 바이트 길이로 산정해야 하며, `PERF-BGSTAB-010` 이 요구하는 authoritative evidence bundle 을 바이너리 인코딩 조건에서 재측정한 새 publication generation 으로 발행하기 전에는 바이너리 데이터 평면을 기본값으로 승격해서는 안 된다.

**Acceptance Criteria (초안)**

- AC-1: 바이너리 프레임의 `encodedBytes` 는 실제 전송 바이트 길이로 산정되어야 하며, 페이로드 문자열의 UTF-8 길이나 JSON 직렬화 추정치를 사용해서는 안 된다.
- AC-2: 동일 session 의 인접 바이너리 프레임 병합은 길이 접두 레코드 경계를 보존해야 하고, 병합 후 수신측이 원래 레코드 열을 정확히 복원함을 fuzz 테스트로 증명해야 한다. snapshot, repair, status, readiness, input rejection 과 cross-session 메시지는 병합 대상이 아니다.
- AC-3: `bufferedAmount` + payload bytes 기반 고수위/하드리밋 판정(`FR-BGSTAB-016` AC-3)과 bounded transport queue 예산(`FR-BGSTAB-012` AC-6/AC-7)은 바이너리 프레임에서도 동일 임계값 의미로 적용되어야 한다.
- AC-4: 바이너리 조건 벤치마크는 JSON baseline 과 동일 workload schema·seed·warm-up·trial count·hardware/process 의 paired run 으로 수행하고, lane 별 enqueue-to-first-service / enqueue-to-complete latency, maximum no-service interval, control latency, peak application/socket queued bytes, aggregate throughput 을 p50/p95/p99/max 로 기록해야 한다.
- AC-5: 재측정 결과는 `PERF-BGSTAB-010` AC-3 이 규정한 decision artifact 구조(workload schema/config hash, candidate 와 baseline, sample count, raw evidence paths, metric 별 exact threshold 와 regression tolerance 및 그 source, accepted/rejected reason)를 만족하는 **새 publication generation** 으로 발행되어야 하며, JSON 세대 artifact 를 덮어쓰거나 fallback 으로 사용해서는 안 된다.
- AC-6: 어떤 eligible lane 에도 unbounded starvation 이 없고 등록된 모든 threshold 를 통과할 때만 바이너리 세대를 채택하며, artifact 가 없거나 불완전·변조·이탈하면 바이너리 기본값 승격을 금지해야 한다(fail-closed).
- AC-7: evidence bundle 재발행은 provenance 소스가 커밋된 상태에서 수행되어야 하며, 재발행 후 sha256 매니페스트 재검증이 통과해 server build 가 실패하지 않아야 한다.

**의존 관계**

| Type | Reference | Relation |
|---|---|---|
| Requirement | `FR-BGSTAB-024` | `depends_on` |
| Requirement | `PERF-BGSTAB-010` | `extends` |
| Requirement | `FR-BGSTAB-016` | `extends` |
| Requirement | `FR-BGSTAB-012` | `extends` |

> ⚠️ AC-7 은 형식적 요구가 아니다. `write-fair-scheduler-evidence-bundle.mjs` 가 `docs/analysis/terminal-fairness-authority/` 의 sha256 매니페스트 불일치 시 throw 하고, 그러면 루트 build 스크립트 18개·CI·Playwright 가 전부 깨진다. 순서는 **코드 커밋 → republish → 증거 커밋**.

### 3.5 REQ-4 · `MIG-BGSTAB-004` — 바이너리 데이터 평면 기본값 전환과 되돌릴 수 있는 롤백

| Field | Value |
|---|---|
| Type | `migration` |
| Target | `wave-5` |
| Status | `planned` |
| Priority | `high` |
| Risk | `high` |
| Stability | `evolving` |
| Tags | `buildergate, wave-5, binary-wire, default-flip, rollback-epoch, soak, legacy-retention` |
| Verification Method | 기본값 전환 전/후 config 계약 테스트, 세션 단위·전역 kill switch drill, rollback epoch 순서 drill, 무캐시/오염 캐시 hard reload E2E, 2개 릴리스 soak 관측, legacy JSON 데이터 평면 잔존 확인 |

**Statement (EARS)**

> `PERF-BGSTAB-011` 의 바이너리 세대 evidence bundle 이 채택된 뒤, 시스템은 `realtime.terminalWireFormat` 의 기본값을 `binary` 로 전환해야 하며, 전환 이후에도 설정 한 값으로 JSON 데이터 평면에 되돌아갈 수 있어야 하고 legacy JSON 데이터 평면 코드를 물리 삭제해서는 안 된다.

**Acceptance Criteria (초안)**

- AC-1: 기본값 전환은 `PERF-BGSTAB-011` 이 발행한 바이너리 세대 evidence bundle 이 채택 상태일 때만 유효하며, artifact 부재·불완전·변조 시 기본값은 `json` 으로 남아야 한다(fail-closed).
- AC-2: 전환 후에도 `realtime.terminalWireFormat = 'json'` 설정만으로 전체 롤백이 가능해야 하며, 롤백에 코드 배포·데이터 마이그레이션·사용자 데이터 삭제가 필요해서는 안 된다.
- AC-3: 롤백은 `MIG-BGSTAB-002` AC-5 의 순서(new admission 중지 → new responder/lease revoke → affected view stale → parser reset → 기존 ACK/backlog 폐기 → 새 `streamEpoch` 의 fresh checkpoint → post-snapshot output → legacy responder enable)를 그대로 따라야 하며 byte tail 을 임의 연결해서는 안 된다.
- AC-4: 세션 단위 kill switch 와 전역 kill switch 가 각각 존재하고, 한 세션의 강등이 다른 세션의 인코딩이나 PTY producer 를 중단해서는 안 된다.
- AC-5: 브라우저 local cache 가 absent 또는 poisoned 인 hard reload 에서도 바이너리 기본값 상태의 retained range 와 terminal state hash 가 server checkpoint 와 이후 output 만으로 복구되어야 한다.
- AC-6: 기본값 전환 뒤 최소 2개 릴리스의 soak 관측을 통과하기 전에는 legacy JSON 데이터 평면 인코더/디코더, local snapshot, viewport replay 와 legacy recovery 경로를 물리 삭제해서는 안 되며, 삭제는 별도 stable deletion Requirement 와 사용자 승인을 요구한다.
- AC-7: 기본값 전환은 `wsTransportMode` 기본값(`unified`)을 변경하지 않으며 split WebSocket 을 기본 전송으로 만들지 않는다.
- AC-8: 기본값 전환은 UI visual·label·layout·interaction, resource profile 기본 숫자와 AI TUI idle/running 의미 불변식을 변경하지 않는다.

**의존 관계**

| Type | Reference | Relation |
|---|---|---|
| Requirement | `PERF-BGSTAB-011` | `depends_on` |
| Requirement | `IR-BGSTAB-001` | `depends_on` |
| Requirement | `FR-BGSTAB-024` | `depends_on` |
| Requirement | `MIG-BGSTAB-002` | `extends` |
| Requirement | `REL-BGSTAB-006` | `related_to` |

### 3.6 의존 그래프

```
MIG-BGSTAB-002 ─┐
PERF-BGSTAB-009 ┼─→ IR-BGSTAB-001 ──→ FR-BGSTAB-024 ──→ PERF-BGSTAB-011 ──→ MIG-BGSTAB-004
REL-BGSTAB-007 ─┤        (포맷/협상)      (전 소비자 수렴)     (회계/재벤치)      (기본값/롤백)
FR-BGSTAB-007  ─┤
FR-BGSTAB-008  ─┘
```

---

## 4. 연구 과제 3 — Scope Boundaries 개정안 (수동 패치, 승인 필요)

> ⚠️ 이 절의 변경은 mutation 도구가 없어 **수동 SRS-MD 패치**로만 가능하다(§0.2). 사용자 명시 승인 전에는 적용하지 않는다. Requirement ID·Status·Stability 를 건드리지 않으므로 CLAUDE.md 의 금지 3항(수동 ID 편집 / bulk-archive / 증거 없는 verified)에 저촉되지 않는다.

### 4.1 `docs/spec/30.buildergate-stability.srs.md`

**패치 1 — In Scope 에 항목 추가 (line 23 뒤)**

Before:
```md
- Feature-flagged split WebSocket handshake, routing, fallback, and rollback-safe behavior.
- Non-2002 validation requirements for agent-run live checks.
```

After:
```md
- Feature-flagged split WebSocket handshake, routing, fallback, and rollback-safe behavior.
- Negotiated binary wire format for the terminal output, checkpoint, replay, and screen-repair data plane, including its default flip and reversible rollback.
- Non-2002 validation requirements for agent-run live checks.
```

*사유*: §8.3 상 scope 의 요구사항은 In Scope 로 덮여 있어야 한다. 신규 REQ 4건이 걸릴 자리를 만든다.

**패치 2 — Out of Scope line 27 개정**

Before (`:27`):
```md
- Making split WebSocket the default transport.
```

After:
```md
- Making split WebSocket the default socket topology. This exclusion covers socket topology only and does not restrict the terminal data plane wire format, which is in scope.
```

*사유*: 원 문장은 *토폴로지* 기본값 배제인데, "default transport" 라는 표현이 전송 계층 전반의 기본값 동결로 오독된다. 배제 대상을 토폴로지로 좁히고 인코딩 축이 in scope 임을 명시한다. **split 을 기본으로 만들지 않는다는 원래 의도는 그대로 보존**되므로 `REL-BGSTAB-006` AC-5 와 무모순이다.

**패치 3 — Assumptions and Constraints 에 항목 추가 (line 35 "The default WebSocket transport mode remains `unified`." 뒤)**

After (추가 줄):
```md
- The terminal data plane wire format is controlled by `realtime.terminalWireFormat`, which is independent of `wsTransportMode`; the control plane stays JSON in every mode.
```

*사유*: `wsTransportMode` 와 `terminalWireFormat` 의 직교성이 이 계획의 핵심 설계결정인데, 이것이 scope 문서에 없으면 다음 작업자가 다시 enum 확장을 시도하게 된다.

### 4.2 `docs/spec/40.mcp-session-orchestration.srs.md`

**패치 4 — Out of Scope line 27 개정**

Before (`:27`):
```md
- Making split WebSocket the default transport or changing existing WebSocket protocol compatibility.
```

After:
```md
- Making split WebSocket the default socket topology.
- Changing the MCP control-plane message encoding, which remains JSON. The negotiated binary terminal data plane specified in the BuilderGate Stability scope is not restricted by this exclusion.
```

*사유*: 원 문장은 두 개의 서로 다른 배제를 한 불릿에 묶었고, 뒷부분("changing existing WebSocket protocol compatibility")이 데이터 평면 프로토콜 변경 전반을 금지하는 것으로 읽힌다. MCP scope 가 실제로 지키려는 것은 **MCP control 평면의 JSON 계약**이다. 둘을 분리하고 보호 대상을 정확히 명명한다.

**패치 5 — Assumptions and Constraints 에 항목 추가**

After (추가 줄):
```md
- MCP tool calls, webhook payloads, and MCP-delivered session input remain JSON regardless of the terminal data plane wire format.
```

*사유*: MCP 는 control 평면 소비자다. 바이너리 전환의 사정거리 밖임을 명문화해 다음 작업자가 MCP 도구 응답까지 바이너리화하려는 시도를 차단한다.

### 4.3 패치하지 않는 것

- `30.*:29` "Changing AI TUI idle/running semantic invariants" — 신규 REQ 들이 이 불변식을 명시적으로 보존한다(`FR-BGSTAB-024` AC-6). 유지.
- `30.*:35` "The default WebSocket transport mode remains `unified`." — split 을 기본화하지 않으므로 그대로 참. 유지.
- `40.*` In Scope — MCP scope 에 신규 REQ 를 만들지 않으므로 변경 불필요.

---

## 5. 연구 과제 4 — 실행 순서 (speckiwi 호출 시퀀스)

> 각 mutation 은 **`dryRun: true` 선행** 후 실제 호출한다. `add_requirement`·`set_active_target`·`set_target_goal`·`append_section_note` 는 `dryRun` 을 지원한다(스키마 실측). `add_trace_link` 와 `update_status` 는 `dryRun` 이 없으므로 **호출 전 인자를 문서와 대조**하고 호출 후 즉시 파일 diff 로 확인한다.
>
> ⚠️ 기억된 환경 함정: `mcp__speckiwi__*` 는 메인 ProjectMaster 체크아웃에 바인딩된다. 워크트리에서 작업 중이라면 MCP 대신 `npx speckiwi --root <워크트리>` CLI 를 쓴다.
>
> ⚠️ `edit-table-rows` 계열에서 top-level `notes` 가 조용히 무시된 전례가 있다. **모든 mutation 후 `git diff` 로 실제 기록 여부를 확인**한다.

### Phase 0 — 읽기 전용 기준선 확보 (mutation 없음)

1. `get_active_target` → `wave-3` 확인.
2. `summarize_target(target="wave-5")` → `total: 0`, goal 존재 확인.
3. `validate_spec` → `summary.byCode` 를 파일로 보존. **이것이 §6 델타 비교의 기준선이다.**
4. `list_requirements(target="wave-5")` → 빈 배열 확인.

### Phase 1 — 사용자 게이트 (필수, 건너뛸 수 없음)

5. §4 의 수동 패치 5건(before/after 전문)을 사용자에게 제시하고 **명시 승인**을 받는다. 승인 없이 Phase 3 로 가지 않는다.
6. §3.1 의 신규 REQ 4건 구성(개수·경계·target)을 함께 승인받는다.

### Phase 2 — Active Target 전환

7. `set_active_target(target="wave-5", dryRun=true)` → 결과 확인.
8. `set_active_target(target="wave-5")`.
9. `get_active_target` → `wave-5` 확인.
10. `set_target_goal` 은 **호출하지 않는다** — goal 이 이미 설정되어 있고 본 계획이 그 goal("binary/split adopt-or-skip, reversible default, two-release soak, 안전한 legacy physical deletion")과 정확히 일치한다. 불필요한 mutation 금지(§3 Surgical Changes).

### Phase 3 — Scope Boundaries 수동 패치 (Phase 1 승인 후에만)

11. `30.buildergate-stability.srs.md` 패치 1·2·3 적용.
12. `40.mcp-session-orchestration.srs.md` 패치 4·5 적용.
13. `validate_spec` → `byCode` 델타 0 확인. 증가하면 **즉시 되돌린다**.

### Phase 4 — 신규 REQ 생성 (의존 순서대로)

각 REQ 마다 `dryRun: true` → 검토 → 실제 호출 → `get_requirement(<할당된 ID>)` 로 확인.

14. `add_requirement` — REQ-1 (`type=interface`, `scope=BGSTAB`, `target=wave-5`, `status=planned`, **`stability=evolving`**, `priority=critical`, `risk=high`, AC 9개, `verificationMethod`, `rationale`, `relatedDocs=[docs/research/binary-comms/04-srs-amendment-plan.md]`, `changeNotes`).
15. `add_requirement` — REQ-2 (`type=functional`, AC 7개).
16. `add_requirement` — REQ-3 (`type=performance`, AC 7개).
17. `add_requirement` — REQ-4 (`type=migration`, AC 8개).

각 호출마다 즉시 `validate_spec` 으로 `SRS-W023` 증가 0 을 확인한다(= `stability` 인자가 실제로 먹혔는지 검증). `evidence` 는 **비워 둔다** — 증거 없는 상태 승급 금지.

> `add_requirement` 는 `trace` 배열을 인자로 받는다. 다만 참조 대상 REQ 가 아직 없는 경우(REQ-2 가 REQ-1 을 참조 등)를 피하려면 위 순서대로 생성하고, **trace 는 Phase 5 에서 별도 호출**로 붙이는 편이 실패 지점을 좁힌다. 한 번에 넣고 싶다면 최소한 이미 존재하는 REQ 를 가리키는 행만 인라인한다.

### Phase 5 — Trace Link 부착 (에지 1개당 호출 1회)

18. REQ-1 의 6개 Requirement 에지 + `informed_by` Doc 에지 (§3.2 표).
19. REQ-2 의 6개 에지 (§3.3 표).
20. REQ-3 의 4개 에지 (§3.4 표).
21. REQ-4 의 5개 에지 (§3.5 표).
22. `links check --json` → broken reference 0 확인.

**`relation="supersedes"` 는 어느 호출에도 등장하지 않는다.** 등장한다면 그것은 이 계획에서 벗어난 것이다.

### Phase 6 — 기존 REQ 에 노트 부착 (6건, 각 500자 이내)

전부 `append_section_note`. **Status·Stability·AC 체크 상태를 건드리는 호출은 하나도 없다.**

23. `REL-BGSTAB-003` / `section=rationale` / `mode=append` — "String-tail 전제는 IR-BGSTAB-001 의 바이너리 데이터 평면에서 encoded-byte tail 로 대체된다. AC-1 의 UTF-8 경계 비분할 요구는 프레임 내부 터미널 페이로드에 그대로 적용된다."
24. `PERF-BGSTAB-009` / `section=implementation_notes` — "AC-7 의 string ingress 유지는 IR-BGSTAB-001 협상이 활성화되기 전까지의 상태 기술이다. AC-7 이 연 `string|Uint8Array` staged path 를 FR-BGSTAB-024 가 그대로 소비하며, 두 번째 스케줄러 경로를 만들지 않는다."
25. `PERF-BGSTAB-010` / `section=research` / `mode=append` — "현재 authoritative evidence bundle 은 JSON encoding 조건의 publication generation 이다. 바이너리 데이터 평면 기본값 승격 전에 PERF-BGSTAB-011 이 동일 workload schema 의 paired run 으로 바이너리 세대를 발행해야 하며, JSON 세대를 fallback 으로 사용하지 않는다."
26. `FR-BGSTAB-008` / `section=implementation_notes` — "AC-5 의 `/api/runtime-config` 허용목록은 IR-BGSTAB-001 AC-8 에 의해 `realtime.terminalWireFormat` 한 필드만 확장된다. 그 외 비밀·비공개 값의 신규 노출은 이 확장에 포함되지 않는다."
27. `FR-BGSTAB-007` / `section=implementation_notes` — "AC-3/AC-4 의 control socket fallback 은 바이너리 terminal payload 에 대해 프레임 형식을 보존한 채 수행된다(IR-BGSTAB-001 AC-6). fallback 시 JSON 재인코딩 경로를 만들지 않는다."
28. `REL-BGSTAB-007` / `section=implementation_notes` — "AC-4 의 canonical unsigned decimal string 규정은 JSON wire 표현에 한정된다. 바이너리 프레임의 Ordinal64 표현과 두 표현의 무손실 왕복은 IR-BGSTAB-001 AC-2 가 규정한다. AC-11 이 요구한 별도 Requirement·TDD·rollout evidence·사용자 승인 경로가 wave-5 에서 충족된다."

각 호출 후 `git diff <파일>` 로 실제 반영 확인.

### Phase 7 — 구현 (본 개정 범위 밖, 참고용)

29. REQ 별 TDD: 실패 테스트 선행 → 최소 구현 → 회귀. 착수 시 `update_status(<id>, "in_progress")`.
30. 구현 완료 시 `add_verification_evidence` → `check_acceptance_criteria` → `update_status(<id>, "implemented")`.
31. 전 AC 체크 + 증거 확보 후에만 `update_status(<id>, "verified")`. (증거 없이 호출하면 `MUTATION_DENIED` 로 거부된다 — 도구가 게이트를 강제한다.)
32. `PERF-BGSTAB-011` 은 **코드 커밋 → evidence bundle republish → 증거 커밋** 순서를 지킨다.

### Phase 8 — 마무리

33. `validate_spec` → `byCode` 델타 0 최종 확인.
34. `summarize_target(target="wave-5")` → `total: 4`, `countsByStability: {evolving: 4}`, `stabilityBlockers: []` 확인.
35. `links check --json` → 0 broken.
36. `add_completed_work` — 이 개정 작업 자체를 기록(`requirementIds` 에 신규 4건, `reportPaths` 에 본 문서).

### 금지 사항 재확인

- 기존 REQ 12건 중 **어느 것에도** `update_status` / `update_stability` 를 호출하지 않는다.
- `update_status(..., "verified")` 를 신규 REQ 에 대해 증거 없이 호출하지 않는다.
- Requirement ID 를 수동 편집하지 않는다. `add_requirement` 가 할당한 값을 그대로 쓴다.
- 여러 REQ 를 한 번에 넘기는 도구를 만들거나 호출하지 않는다.
- `speckiwi repair requirement-id-collisions` 는 이 작업과 무관하다. 기준선의 `SRS-E002`(step SRS 의 `REL-BGSTAB-015` 중복)는 **선행 부채이며 본 작업에서 건드리지 않는다.**

---

## 6. 연구 과제 5 — 검증 계획

### 6.1 기준선 (실측)

```json
{"errors":1,"warnings":19,"byCode":{"SRS-W018":5,"SRS-W023":14,"SRS-E002":1}}
```

**게이트는 `--fail-on-warning` 이 아니다.** 기준선이 이미 errors 1 / warnings 19 이므로 `--fail-on-warning` 은 무조건 실패한다. 실제 게이트는 **`byCode` 델타가 전 코드에서 0** 인 것이다.

### 6.2 코드별 증가 방지 근거

| 코드 | 기준선 | 증가 위험 | 방지 |
|---|---:|---|---|
| `SRS-E002` (중복 ID) | 1 | 수동 ID 지정 시 | ID 를 `add_requirement` 가 할당. 수동 지정 경로 자체가 없음 |
| `SRS-W018` (Scope Map 미등록 문서) | 5 | 신규 scope 문서(`50.*`) 생성 시 | **신규 scope 문서를 만들지 않는다.** 신규 REQ 전부 기존 `30.*` 에 들어감 |
| `SRS-W023` (draft 요구사항) | 14 | `stability` 생략 시 도구가 `draft` 적용 → **+4** | 4건 모두 `stability="evolving"` 명시. REQ 생성 직후 매번 `validate_spec` 로 확인 |
| `SRS-E012` (trace 참조 대상 부재) | 0 | 오타·미생성 ID 참조 | 참조 대상 21개 전부 실존 확인됨(§3 표). 의존 순서대로 생성. Phase 5 후 `links check` |
| `SRS-E010` (verified 인데 AC 미체크/증거 없음) | 0 | 성급한 `verified` | 신규 4건 모두 `status="planned"` 로 생성. Phase 7 이전 `verified` 호출 없음 |
| `SRS-E033` (verified 인데 draft) | 0 | 위와 동일 | 동일 |
| `SRS-W017` (Trace Links 행 형식 오류) | 0 | 수기 표 작성 시 | 표를 손으로 쓰지 않고 `add_trace_link` 로만 생성 |
| `SRS-W025` (Completed Work 중복 행) | 0 | `add_completed_work` 중복 호출 | Phase 8 에서 1회만 호출 |

### 6.3 검증 체크포인트

| 시점 | 명령 | 합격 조건 |
|---|---|---|
| Phase 0 | `speckiwi validate --json` | 기준선 저장 |
| Phase 3 직후 | `speckiwi validate --json` | `byCode` 델타 0 (특히 `SRS-W018` 불변) |
| Phase 4 각 REQ 직후 | `speckiwi validate --json` | `SRS-W023` 델타 0 (= evolving 이 실제로 적용됨) |
| Phase 5 직후 | `speckiwi links check --json` | broken 0, `SRS-E012` 0 |
| Phase 6 각 노트 직후 | `git diff <파일>` | 의도한 섹션에 실제 텍스트 반영 |
| Phase 8 | `speckiwi validate --json` | 기준선과 **완전 동일** |
| Phase 8 | `speckiwi summary --target wave-5 --json` | `total: 4`, `countsByStatus: {planned: 4}`, `countsByStability: {evolving: 4}`, `stabilityBlockers: []` |

### 6.4 실패 시 대응

- `byCode` 가 증가하면 **다음 단계로 진행하지 않고** 직전 mutation 을 되돌린다. `git diff` 로 변경 범위를 확인하고 해당 파일만 되돌린다.
- ⚠️ 기억된 함정: 공유 워크트리에서 `git add <경로>` 를 해도 `git commit` 은 인덱스 전체를 커밋해 타 작업의 스테이징을 쓸어간다. 되돌리기·커밋 모두 **`git commit -- <경로>`** 형태로 경로를 명시한다.
- `SRS-W023` 이 늘었다면 `stability` 인자가 무시된 것이다. `update_stability(<id>, "evolving")` 로 교정하고(이것은 신규 REQ 대상이므로 허용), 왜 무시되었는지 기록한다.

### 6.5 이 계획이 남기는 정직한 부채

- **`FR-BGSTAB-008` AC-5 의 문면과 구현이 어긋난 상태가 남는다.** AC-5 는 허용목록을 닫힌 열거로 쓰고 있고, 도구로는 그 문장을 고칠 수 없다. Phase 6-26 의 노트가 이 어긋남을 명시적으로 기록하지만 AC 문면 자체는 부정확한 채로 남는다. **AC 텍스트 편집 mutation 이 speckiwi 에 추가되면 가장 먼저 교정해야 할 항목이다.**
- **`PERF-BGSTAB-009` AC-7 의 "Production ingress는 string을 유지" 도 같은 성격**으로 남는다. 체크를 해제하지 않는 것이 옳다고 판단했으나(§2.3), 이는 판단이지 무결점 해법이 아니다.
- 위 두 항목은 SRS-MD v2.5.0 이 **부분 AC 개정이라는 연산을 제공하지 않는다**는 규격 한계에서 나온다. 규격 개선 제안 대상이다.

---

## 7. 열린 질문 (사용자 결정 필요)

1. **§4 수동 패치 5건을 승인하는가?** 도구 공백이므로 승인 없이는 Scope Boundaries 를 고칠 수 없고, 고치지 않으면 신규 REQ 4건이 scope 로 덮이지 않는다(§8.3 위반).
2. **`wsTransportMode` 와 별개인 `realtime.terminalWireFormat` 키 신설에 동의하는가?** 이것이 §2.2 전체를 지탱하는 설계결정이다. 반대라면 `FR-BGSTAB-001` AC-3 과 `FR-BGSTAB-008` AC-5 를 모두 실제 supersede 해야 하고, 그 경우 stable REQ 2건 폐기 + 검증 증거 13건 재수집이 발생한다.
3. **신규 REQ 4건 분할에 동의하는가?** 더 줄이면 Verification Method 가 한 REQ 안에서 섞이고(§29.1), 더 늘리면 표면당 1개 원칙을 벗어난다.
4. **`PERF-BGSTAB-010` 의 Status 를 `in_progress` 로 유지하는 것에 동의하는가?** 대안은 `blocked` 로 내리는 것인데, 바이너리 재벤치마크가 그 REQ 자체를 막는 것은 아니므로(별도 `PERF-BGSTAB-011` 소관) `in_progress` 유지가 정확하다고 판단했다.
