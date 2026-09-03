# S5-a0 `encodedBytes` 도메인 전환 — 세션 핸드오프

| Field | Value |
| --- | --- |
| 작성일 | 2026-09-04 |
| 저장소 / 브랜치 | `C:\Work\git\_Snoworca\ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| 최종 작업 목표 | `PERF-BGSTAB-011` AC-1 이 규정한 본문 바이트 도메인으로 JSON codec 경로를 전환하고, 그 단독 효과를 측정해 기록한다 |
| 현재 상태 | 미착수. 직전 두 작업(AC-7 전송 모드 게이트, wave3 클로저 게이트 정리)은 완료·커밋·푸시됨. 추적 파일 변경 0건 |
| SSOT | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md` §S5 (`:1744-1970`, S5-a0 는 `:1746-1761`) |
| 다음 세션 첫 행동 | 아래 "0. 다음 세션의 첫 행동" 참조 |

> 이 문서는 다음 세션이 **이 문서와 SSOT 만 읽고** 작업을 이어갈 수 있도록 정리한 것이다. 대화 히스토리에 의존하지 말 것.

이 문서에서 `<REPO>` 는 `C:\Work\git\_Snoworca\ProjectMaster` 를 가리킨다.

---

## 0. 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `<REPO>\docs\research\binary-comms\06-work-plan.md` 의 `:1746-1761` (S5-a0) 을 정독한다.
3. `git status --porcelain` 과 `git log --oneline -3` 으로 아래 "3. 현재 워킹트리·저장소 상태" 와 일치하는지 확인한다.
4. **착수 전에 아래 "9. 거버넌스·게이트·함정" 의 "핀 파일 재발행은 두 곳이다" 를 반드시 읽는다.** `server/src/ws/wsSendPolicy.ts` 는 핀 파일이며, 백로그 부록의 절차만 따르면 테스트 2건이 red 로 남는다.
5. `<REPO>\server\src\ws\wsSendPolicy.ts` 의 `fairDeliveryBytes()` 를 읽어 현재 무엇을 세는지 확인한 뒤 착수한다.

---

## 1. 최종 작업 목표

`PERF-BGSTAB-011` AC-1 이 규정한 대로 `encodedBytes` 원장을 codec 과 무관한 **본문(body) 바이트 도메인**으로 산정하도록 JSON codec 경로를 전환한다.

완료 조건은 셋이다.

- 도메인 전환 후 회귀 0건 (아래 "9" 의 테스트 명령 전부)
- 전환의 **단독 측정** 결과가 기록된다 — `PERF-BGSTAB-011` AC-9 가 "와이어가 아직 JSON 인 상태에서 먼저 수행하고 단독 측정한 뒤 opt-in 활성화" 를 못박는다
- 핀 재발행 2건이 함께 커밋된다 (`wsSendPolicy.ts` 가 핀 파일이므로 필수)

---

## 2. 현재까지 완료한 작업

이번 세션 커밋 5개. 전부 `origin/work/mcp-session-orchestration-20260709` 에 푸시 완료(`git log --oneline @{u}..HEAD | wc -l` 결과 `0`, 2026-09-04 실행).

- [x] **AC-7 전송 모드 게이트 위배 해소** — 커밋 `e67e9c0 fix(server): gate binary negotiation on the configured transport mode`. 24개 파일 (소스 3, 봉인 문서 3, 신규 generation 18)
- [x] **그 작업 기록** — 커밋 `2b7af91`. `<REPO>\docs\report\2026-09-03.ac7-transport-gate.md`, 검증 A+ 2건
- [x] **lexical census 를 커밋된 소스에 맞춤** — 커밋 `9e75d1b test(wave3): update the frozen lexical census to the committed source`. 1개 파일, 4 insertions / 4 deletions
- [x] **공허한 boundary gate 제거** — 커밋 `2a20b4f test(wave3): retire the vacuous boundary gate for the admission gate`. 3개 파일, 3 insertions / 53 deletions
- [x] **wave3 작업 기록** — 커밋 `2170450`. `<REPO>\docs\report\2026-09-03.wave3-closure-gates.md`, 검증 A+ 2건

### 2.1 스위트 성적 (2026-09-03 실측)

cwd 는 표의 괄호에 적은 곳이며, `npx` 를 쓰지 않고 경로를 박아 실행했다.

| 스위트 | 실행 명령 | 세션 시작 | 세션 종료 |
| --- | --- | --- | --- |
| 광역 node:test | `node node_modules/tsx/dist/cli.mjs --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts` (`server/`) | 866 / 852 pass / 0 fail / 14 todo | **869 / 855 pass / 0 fail / 14 todo** |
| 부트 프로브 단독 | `node node_modules/tsx/dist/cli.mjs --test src/ws/terminalWireFormatBoot.test.ts` (`server/`) | 3 / 3 pass | **6 / 6 pass** |
| 모놀리식 러너 | `node node_modules/tsx/dist/cli.mjs src/test-runner.ts` (`server/`) | 532 passed | 532 passed |
| `tsc --noEmit` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`server/`) | exit 0 | exit 0 |
| `lexical.test.mjs` | `node --test tools/wave3/fair-readmission-closure-v3.lexical.test.mjs` (repo root) | 3 / 4 pass | **4 / 4 pass** |

### 2.2 기억과 실제가 달랐던 항목

이번 세션에 사실로 적었다가 뒤집힌 것들. 다음 세션이 같은 오판을 반복하지 않도록 남긴다.

| 기록했던 진술 | 실제 (확인 방법) |
| --- | --- |
| "`wsTransportMode` 를 배선하면 Wave-1 특성화(`WsRouterSplitHandshake.test.ts`)가 깨진다" | **거짓.** 그 스위트의 `createRouter()`(`:118-123`)가 값을 직접 주입하므로 `index.ts` 배선에 **구조적으로 둔감**하다. 배선 유무와 무관하게 `28 / pass 14 / fail 0 / todo 14` 로 동일(서브에이전트가 `index.ts` 에 뮤턴트를 걸고 `node node_modules/tsx/dist/cli.mjs --test src/ws/WsRouterSplitHandshake.test.ts` 를 돌려 실측, 2026-09-03). ⚠️ 그 수치는 저장소에 산출물이 없으므로 재실행으로만 재확인된다. 다만 구조적 근거는 코드로 확인된다 |
| "AC-7 의 '직교' 는 두 값을 라우터에 함께 넘기지 말라는 뜻이다" | **오독.** "직교하는 런타임 설정 키" 는 인코딩을 제어하는 키가 전송 모드 키와 **별개의 키**여야 한다는 뜻이다. AC-7 의 다음 문장이 오히려 결합을 요구한다("바이너리 인코딩은 `wsTransportMode` 가 `unified` 일 때만") |
| "확정 결정 #2(`wsTransportMode` 를 넘기지 않는다)의 근거는 AC-7 이다" | **결론은 옳고 근거가 틀렸다.** 실제 근거는 `REL-BGSTAB-006` AC-5(`docs/spec/30.buildergate-stability.srs.md:2532`)와 `REL-BGSTAB-008` AC-10(`:3029`)의 split runtime 비활성화다 |
| "`boundary-gate` 의 형제 9개 중 5개가 실제로 red 다" (이전 세션 기록) | **거짓.** 이 체크아웃에서 형제 아홉을 `node --test` 로 한 줄에 나열해 직접 돌린 결과 **49 tests / 49 pass / 0 fail / 181.7초** (2026-09-03 실행). 문제는 실패가 아니라 시간이었다. ⚠️ 이 수치는 저장소에 산출물이 남아 있지 않으므로 재실행으로만 재확인된다 |
| "`admission-gate` 는 타임아웃으로 실패한다" | **절반만 참.** 종료 양상이 부하에 따라 흔들린다. 118초 타임아웃으로 끝난 실행은 커밋 `2a20b4f` 메시지에 기록되어 있다. ⚠️ 미검증 — 100.5초에 형제 단언 실패로 끝난 실행도 관측했으나 저장소에 산출물이 없다. 실패 사유를 한 번의 실행으로 단정하지 말 것 |
| "커밋 `9e75d1b` 는 4줄 변경이다" | **거짓.** `git show --stat` 은 `8 ++++----`, `git show --numstat` 은 `4 4` 다. 이 오류를 검증 서브에이전트에 기준으로 넘겨, **정확한 보고서가 B 등급을 받았다** |
| 검증자가 "로그에 `126ms`·`181.7초`·`88.7초` 가 있다" 고 표에 ✓ 표기 | **거짓.** 실제로는 셋 다 부재했다. 다른 검증자가 그것을 잡았다 |

---

## 3. 현재 워킹트리·저장소 상태

`git status --porcelain` (2026-09-04 실행) 기준.

- 브랜치: `work/mcp-session-orchestration-20260709`, `HEAD` = `2170450`, origin 과 동일(ahead 0 / behind 0)
- **추적 파일 변경 0건**
- 미추적 파일 8개 — 이 핸드오프 문서 자신을 포함해서 센다:
  - `docs/next/2026-09-04-s5-a0-encoded-bytes-domain.md` (이 문서)
  - `.codex/config.toml`, `CLAUDE.local.md`
  - `t1_verdict_1.txt`, `t1_verdict_2.txt`, `t2_verdict_1.txt`, `t2_verdict_2.txt`, `t2_verdict_incomplete_True.txt`
- `docs/next/LATEST.md` 는 이 문서를 가리키도록 수정되므로 ` M` 으로 나타난다
- 커밋 여부 판단: 이 문서와 `LATEST.md` 는 커밋 권장. 나머지 7개는 이전 세션들에서 "커밋에서 제외" 로 확정된 것이므로 건드리지 않는다

**⚠️ 이 저장소는 여러 세션이 공유한다.** `git stash`·`git checkout`·`git reset` 을 워킹트리에 쓰지 말 것. mutate → run → restore 실험은 스크래치 백업과 sha256 대조로 한다.

---

## 4. 관련 문서·코드 (절대경로)

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| **SSOT** | `<REPO>\docs\research\binary-comms\06-work-plan.md` | §S5 는 `:1744-1970`, S5-a0 는 `:1746-1761` |
| SRS | `<REPO>\docs\spec\30.buildergate-stability.srs.md` | `PERF-BGSTAB-011` 은 `:5107` 부터. `IR-BGSTAB-001` AC-10 은 `:5006` (`encodedBytes` 도메인 규정) |
| **핀 재발행 절차** | `<REPO>\docs\plan\2026-09-01.remaining-work-backlog.plan.md` | §부록 "핀 파일과 재게시" 는 `:114` 부터. **불완전하다 — 아래 §9 참조** |
| 백로그 A~E | 같은 파일 | 남은 작업 원본 목록. D 그룹은 `:88-97` |
| 테스트 표면 지도 | `<REPO>\CLAUDE.md` | 어느 스위트를 어떻게 돌리는지. 이번 세션에 세 곳 갱신됨 |
| 이번 세션 보고서 | `<REPO>\docs\report\2026-09-03.ac7-transport-gate.md`, `<REPO>\docs\report\2026-09-03.wave3-closure-gates.md` | 두 작업의 상세 |
| 직전 핸드오프 | `<REPO>\docs\next\2026-09-03-ac7-transport-gate-followups.md` | 이번 세션이 이어받은 문서. **작업 A·B 완료를 반영하지 않은 상태로 남아 있다** |

**수정 대상 코드**: `<REPO>\server\src\ws\wsSendPolicy.ts` — `fairDeliveryBytes()` (`:631-644` 부근). 현재 `createWsTransportMessage(...).byteLength`, 즉 JSON 봉투 전체를 센다 (⚠️ 미검증 — 이전 세션의 서브에이전트 보고이며 이번 세션에서 그 줄을 직접 읽지 않았다. 다음 세션이 먼저 확인할 것)

**선행 작업**: `<REPO>\server\src\services\TerminalResourcePolicy.test.ts` 의 키 집합 단정 보강. `06-work-plan.md:2413-2415` 를 직접 읽어 확인했다(2026-09-03): "§7 항목 9 — TerminalResourcePolicy.test.ts 키 집합 단정 보강 → S5 재측정 전". `strategy`·`visibilityWeight`·`driverWeight` 가 현재 무단정이며 기대값은 리터럴 `'deficit-round-robin'` / `8` / `16` 이고 resolver 재호출은 금지된다

**참고 선례**: `<REPO>\server\src\ws\terminalWireFormatBoot.test.ts` — 서버를 실제로 부팅해 설정 도달을 관측하는 유일한 테스트. 6케이스에 약 20초

---

## 5. 확정된 결정 (변경 금지)

| 확정도 | 조건 |
| --- | --- |
| **확정** | 저장소에 근거가 있다 |
| **유력(미확정)** | 대화에서 정했으나 저장소 근거가 없다 |

1. **AC-7 게이트는 설정과 연결이 둘 다 `unified` 일 때만 연다** — **확정**. (근거: 커밋 `e67e9c0`, `server/src/ws/WsRouter.ts` 의 `ensureTerminalBinaryGroup`. AC-7 의 `wsTransportMode` 가 설정값인지 요청값인지는 **문면으로 판정 불가**이며 양쪽 해석 모두 각자 구멍을 남기므로, 논리곱으로 물음 자체를 무효화했다)
2. **`this.wsTransportMode` 에 설정을 배선하지 않는다** — **확정**. (근거: `REL-BGSTAB-006` AC-5 `:2532` "split runtime을 활성화하지 않는다", `REL-BGSTAB-008` AC-10 `:3029`. 배선하면 `WsRouter.ts` 에서 `meta.wsTransportMode` 를 읽는 라우팅 분기 여섯 곳(`:744`, `:892`, `:1149`, `:1163`, `:1176`, `:2377`)이 열려 금지된 split runtime 활성화가 된다. 같은 필드를 읽는 일곱 번째 지점 `:1958` 은 이번에 만든 바이너리 협상 게이트이며 라우팅과 무관하다)
3. **`boundary-gate` 는 제거하고 `admission-gate` 로 일원화한다** — **확정**. (근거: 커밋 `2a20b4f`. `admission` SDS §3 Decision "Replace the nine-file gate with one nonrecursive fixed gate covering every functional suite but excluding only itself", basis "a gate must cover its contracts". `boundary` SDS 의 `Status` 는 `superseded`)
4. **동결 census 는 소스를 따른다** — **확정**. (근거: 커밋 `9e75d1b`. lexical SDS §2 Non-goals 가 "source normalization" 을, §3 이 "source rewrite" 를 배제하므로 census 를 지키려 소스를 고치라는 해석은 계약이 자기 Non-goal 을 강제하는 모순이 된다)
5. **`server/src/ws/WsRouter.ts` 는 핀이 둘이다** — **확정**. (근거: 이번 세션 실측. 아래 §9 참조)
6. **커밋 메시지에 시그니처를 넣지 않는다** — **확정**. (근거: `C:\Users\beom\.claude\CLAUDE.md` §6. 이번 세션 커밋 5개 전부 시그니처 0건, `git log -1 --format="%B" | grep -ciE ...` 로 매 커밋 확인)
7. **결정 게이트에서는 묻지 말고 권장안을 자동 선택한다** — **확정**. 2026-09-03 사용자 지시. 되돌리기 어렵거나 외부로 나가는 행위만 예외이며, 일상적인 `git push` 는 자동 진행에 포함된다

---

## 6. 미결정·유예 항목

- **`lexical.test.mjs:95` 의 합계 단언을 실질화할지** — 그 단언은 코드베이스에 대해 공허하다. `dynamicEdges` 가 기대값 리터럴을 누산하므로 파싱 결과가 반영되지 않고, **합계만 유지하면 개별 `dynamicOccurrences` 를 재분배해도 통과한다**(검증 서브에이전트가 뮤턴트로 실측). 고치려면 `parseAdmittedImportSpecifiers` 가 `{ specifier, kind }` 를 반환하도록 공개 API 를 바꾸거나, 테스트가 소스를 다시 파싱해 세야 한다(후자는 파서 로직 복제라 §10.2 에 걸린다). 결정 방법: 사용자 확인
- **`admission-gate` 의 시간 예산 처리 방법** — 118초 안에 형제 20개를 돌려야 하는데 `tools/wave3/fair-readmission-closure-v3.wave.test.mjs:107` 의 테스트 `SDS-AC-3 publishes a deterministic deduplicated source closure only after native capture succeeds` 가 **88.7초**로 찍혔고, 그 테스트 본문이 하는 일은 `captureFrozenProvenance` 호출 하나다(2026-09-03 실측, node 가 테스트별로 출력한 소요 시간). ⚠️ 그 시간이 그 호출에 귀속된다는 것은 별도 계측으로 확인하지 않았다. 그 함수를 빠르게 만들지, 예산을 올릴지, 게이트 구조를 바꿀지 미정. 결정 방법: 사용자 확인
- **S4-d 의 shadow parity soak** — 정본 테스트 `<REPO>\server\src\ws\binaryShadowParity.test.ts` 가 **존재하지 않는다**(`ls` 로 확인, 2026-09-03). soak 자체가 미수행이라는 것은 ⚠️ 미검증 — 수행 기록의 부재를 저장소로 증명하기는 어렵다

---

## 7. 남은 작업 전체 목록

### 다음 세션이 할 것

- [ ] **S5-a0 — `encodedBytes` 도메인 전환** — 완료 조건: `PERF-BGSTAB-011` AC-1 의 본문 바이트 도메인으로 전환, 회귀 0건, 단독 측정 결과 기록, 핀 재발행 2건 동반 커밋

### 그 뒤 (S5 계열)

- [ ] **S5-a / S5-b / S5-c0 / S5-c** — S5-a0 이후 순차. SSOT `06-work-plan.md` §S5
- [ ] **S4-d 완료** — shadow parity soak (client `1/2/8` × session `1/8/32/54` 전수 불일치 0건)
- [ ] **D 그룹 S6 · S7 · C6** — S5 이후

### wave3 테스트 인프라 (이번 세션에 드러난 것)

- [ ] **`admission-gate` 시간 예산** — 위 §6 참조. 이것이 해결되기 전에는 저장소에 **green 인 closure 집합 게이트가 하나도 없다**
- [ ] **공유 매니페스트 병렬 경합** — 21개 스위트 중 **16개**가 `<REPO>\docs\analysis\kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3\` 를 공유한 채 node 병렬 러너로 동시에 돌아, `lexical-race` 와 `seal-race` 가 `reparse guard identity changed during batch probe` 로 간헐 실패한다. 단독 실행에서는 둘 다 통과
- [ ] **`lexical.test.mjs:95` 합계 단언 실질화** — 위 §6 참조

### 그 밖 (이전 핸드오프에서 이월)

- [ ] **C2 — `WsRouterSplitHandshake.test.ts` 의 todo 14건 중 13건이 실패하는데 exit 0** — 그 13건은 깨진 단언 11 / `TypeError` 1(`router.isValidSplitOutputPair` 미구현) / `ZodError` 1(생성자가 구성 거부)로 갈린다. 뒤의 둘은 배선으로 풀리지 않으므로 분모에 넣지 말 것
- [ ] **C4 — `frontend/tests/e2e/busy-agent-workspace-bounce.spec.ts` 타이밍 취약** (10회 중 1회 배너 미출력)
- [ ] **B3 — E2E wave1 2건** — 실패 문구 `authority recovery live websocket input seam is unavailable`. seam 은 스펙이 `frontend/tests/e2e/wave1-retained-state-characterization.spec.ts:862-863` 의 `addInitScript`/`evaluate` 로 주입하므로 프로덕션에 seam 을 추가할 것이 아니라 주입이 왜 적용되지 않는지를 찾아야 한다 (⚠️ 미검증 — 2026-09-01 시점 기록)
- [ ] **숨김 탭 스크롤백 유실** — `<REPO>\docs\next\2026-09-02-long-red-suite-cleanup.md` 참조. 사용자 확인 필요
- [ ] **`IR-BGSTAB-001` AC-8 — `/api/runtime-config` 에 `realtime.terminalWireFormat` 노출** — 미구현. `RuntimeConfigStore.getPublicRuntimeConfig`(`:274-288`)가 그 키를 노출하지 않는다. SRS 자신이 `docs/spec/30.buildergate-stability.srs.md:625` 에 그 간극을 기록해 두었다
- [ ] **E 그룹(문서)** — `CLAUDE.local.md` 규칙 1 에 따라 **사용자가 직접 지시할 때만** 손댄다

---

## 8. 다음 세션 지시서

1. `06-work-plan.md:1746-1761` 을 정독한다 → 검증: S5-a0 가 요구하는 산출물이 그 절에서 확인된다
2. `<REPO>\server\src\ws\wsSendPolicy.ts` 의 `fairDeliveryBytes()` 를 **직접 읽어** 현재 무엇을 세는지 확인한다 → 검증: JSON 봉투 전체를 세는지, 본문만 세는지가 코드로 판정된다 (§4 의 그 서술은 미검증이다)
3. 선행 작업을 먼저 한다 — `TerminalResourcePolicy.test.ts` 의 키 집합 단정 보강 (§4 참조) → 검증: `strategy`·`visibilityWeight`·`driverWeight` 세 키에 리터럴 기대값 단언이 생긴다
4. TDD — 실패 테스트를 먼저 쓴다. `encodedBytes` 가 본문 바이트만 세는지 보는 테스트다 → 검증: red 확인
5. 최소 구현 → 검증: 그 테스트가 green, §9 의 테스트 명령 전부에서 실패 이름 집합이 늘지 않는다
6. **핀 재발행 2건** (§9 참조) → 검증: `TerminalResourcePolicy.test.ts` 와 `WsRouterSendPriority.test.ts` 가 green 으로 돌아온다
7. 뮤테이션 + 경계 대조군 → 검증: 겨냥한 조건만 red 이고 의미가 같은 변형은 green
8. 단독 측정 결과를 기록한다 (AC-9 요구)

---

## 9. 거버넌스·게이트·함정

**규칙**

- dev 서버 포트는 항상 2222. `kill {pid}` 와 `taskkill /F /IM node.exe` 금지
- 연구·계획은 서브에이전트에 위임(모델 opus5). 검증도 서브에이전트 — 자기가 쓴 것을 자기가 검증하지 않는다
- 커밋 메시지에 시그니처 금지, 제목에 `Phase N`·`Step N`·`TASK-XXX` 금지
- 코드 주석은 검증(리뷰) 범위에서 제외
- 결정 게이트는 묻지 말고 권장안을 자동 선택한다

### ⚠️ 핀 파일 재발행은 두 곳이다 — 백로그 부록이 불완전하다

`<REPO>\docs\plan\2026-09-01.remaining-work-backlog.plan.md` §부록(`:114`)은 fair-scheduler provenance **하나만** 기록한다. 그 절차만 따르면 테스트 2건이 red 로 남는다. 2026-09-03 에 `WsRouter.ts` 를 고치며 실측한 결과다.

핀 6개는 다음과 같다(`<REPO>\server\tools\write-fair-scheduler-source-provenance.mjs:7-14`).

```
server/src/benchmarks/terminalFairnessCharacterization.ts
server/src/benchmarks/fairSchedulerAuthorityLocator.ts
server/src/ws/wsSendPolicy.ts          ← S5-a0 의 수정 대상
server/src/ws/WsRouter.ts
server/src/services/TerminalResourcePolicy.ts
server/src/services/TerminalResourcePolicyCanary.ts
```

**증상과 조치**

| 봉인 | 증상 | 조치 |
| --- | --- | --- |
| fair-scheduler source provenance | `decision-artifact-source-digest-mismatch` — `WsRouterSendPriority.test.ts` 등 14건 red | authority generation 재게시 (아래) |
| terminal resource consumer manifest | `source-hash-mismatch` — `TerminalResourcePolicy.test.ts` 2건 red | `node server/node_modules/tsx/dist/cli.mjs tools/wave3/terminal-resource-consumer-manifest-reseal.ts --reseal` |

**authority generation 재게시**는 `publishFairSchedulerAuthorityGeneration` 을 다음 인자로 호출한다. 프로덕션 스크립트가 없으므로 스크래치에 `.mjs` 를 만들어 `cwd=server/` 에서 tsx 로 돌린다.

```
authorityRoot: '../docs/analysis/terminal-fairness-authority'
clients: [1, 2, 8], wanLatencyMs: 150, wanJitterMs: 20, wanLossPercent: 0,
seed: 20260723, repeats: 5, samples: 30
```

**재게시는 5.4초에 끝난다** (2026-09-03 실측). `prng.rootSeed = 20260723` 의 `xorshift32` 결정론적 시뮬레이션이라 벽시계를 재지 않으므로, **머신 부하가 측정값에 섞이지 않는다.** 직전 세대와 trial 원자료 15개의 sha256 이 전부 같았고 `fair-scheduler-decision.json` 에서 다른 키는 `sourceDigest` 하나뿐이었다.

**커밋 범위**: 새 generation 디렉터리의 18개 파일을 **반드시 함께 커밋한다.** 선례 커밋 `5f891dc` 가 그렇게 했고, 빼면 `write-fair-scheduler-evidence-bundle.mjs` 가 대상을 못 찾아 **server build 가 깨진다.** 기존 세대는 손대지 않는다 — `terminalFairnessCharacterization.ts:2328` 이 내용이 다른 재발행을 거부하는 append-only 불변 아카이브다.

**재봉인 도구는 dry-run 이 기본이다.** 인자 없이 돌리면 무엇이 바뀔지만 출력하고 아무것도 쓰지 않는다. 출력에 "against the sealed historical manifest" 라는 단서가 붙은 항목들은 구 매니페스트와의 차이 리포트이지 `current.json` 에 새로 들어갈 변경이 아니다.

### 그 밖의 함정 (이번 세션에 실제로 밟은 것)

- **wave3 클로저 스위트 21개 중 11개가 workspace root 를 하드코딩한다.** `const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster'` 이므로 다른 워크트리에서 돌리면 `workspace root must equal the collector-derived workspace root` 로 즉시 던진다. **기준선 대조라는 표준 수단이 이 스위트들에는 통하지 않는다.** 대안은 개별 실패 메시지의 재현 여부와 입력 파일의 불변성으로 우회 판정하는 것이다
- **검증 서브에이전트에 넘기는 기준도 검증 대상이다.** 이번 세션에 `git show --stat` 의 총합(`8`)과 `--numstat` 의 insertions(`4`)를 혼동해 "4줄" 을 기준으로 넘겼고, **정확한 보고서가 B 등급을 받았다.** 반대 방향도 겪었다 — 검증자가 "수치가 있다" 고 ✓ 표기했으나 실제로는 부재했다. **검증 프롬프트에 "내 기준과 저장소가 어긋나면 저장소를 믿고 알려 달라" 를 넣을 것**
- **두 검증자가 모두 놓친 오류가 있었다.** `dynamicEdges`(합계 변수, 16→17)와 `occurrences`/`dynamicOccurrences`(14→15)를 뒤바꿔 적은 것을 제가 grep 하다가 발견했다. 서브에이전트 검증은 확증편향을 막지만 누락까지 막지는 않는다
- **핀 파일 뮤턴트는 false kill 을 낼 수 있다.** 겨냥한 뮤턴트를 걸기 전에 **의미가 같은 변형이 green 인지** 먼저 확인해 red 의 원인을 분리할 것. 이번 세션에는 부트 프로브가 핀 게이트와 무관함을 그렇게 확인했다
- **Bash heredoc 이 백슬래시를 벗긴다.** 정규식이 든 치환은 `Write` 로 `.cjs` 스크립트를 만들어 실행할 것. `<<'EOF'` 로도 손상됐다
- **`npx` 가 다른 체크아웃의 바이너리를 실행한다.** `node server/node_modules/tsx/dist/cli.mjs` 처럼 경로를 박는다

**복붙 가능한 테스트 명령**

```
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs src/test-runner.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/ws/terminalWireFormatBoot.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
cd C:\Work\git\_Snoworca\ProjectMaster && node --test tools/wave3/fair-readmission-closure-v3.lexical.test.mjs
```

광역 node:test 는 **exit code 를 믿을 수 없다.** `ℹ fail N` 요약 줄과 `✖ failing tests:` 목록을 봐야 한다.

---

## 10. 리스크·잔존 이슈

- **저장소에 green 인 closure 집합 게이트가 하나도 없다** — 영향: wave3 클로저 스위트 전체에 대한 회귀 신호가 없다. 삭제 전에는 형식상 green 이 하나 있었으나 그것이 0개를 실행하는 공허한 게이트였으므로, 이는 커버리지의 상실이 아니라 **이미 참이던 사실이 드러난 것**이다. 대응: §6 의 시간 예산 결정
- **`admission-gate` 의 종료 양상이 부하에 따라 흔들린다** — 영향: 같은 커밋에서 100.5초 자식 단언 실패와 118초 타임아웃을 모두 관측했다. 실패 사유를 한 번의 실행으로 단정하면 안 된다
- **`SessionManagerTerminalAuthorityRuntimePorts.test.ts:764` 가 간헐적으로 실패한다** — 이전 세션 관측(광역 실행 4회 중 1회). 바로 앞줄의 `retainedStateParity === false` 는 통과했는데 같은 사실을 담아야 할 `blockers` 배열에는 그 항목이 없었다. **한 사실을 두 곳에 따로 기록하는 구조로 추정되며, 그렇다면 flaky 가 아니라 두 값이 갈릴 수 있는 제품 쪽 문제다.** 이번 세션에서도 조사하지 않았다
- **`docs/next/` 의 이전 핸드오프 문서들이 낡았다** — 영향: `2026-09-03-ac7-transport-gate-followups.md` 가 작업 A·B 를 미완료로 표시하고 있고, `2026-09-02-long-red-suite-cleanup.md:149` 의 C1 체크박스도 그렇다. 대응: 그 문서들은 당시의 인수인계이므로 덮어쓰지 않았다. `LATEST.md` 가 이 문서를 가리키므로 다음 세션은 여기서 출발한다
- **`server/config.json5` 는 gitignored 다** — 다른 설치본에는 이 세션의 설정이 반영되지 않는다
