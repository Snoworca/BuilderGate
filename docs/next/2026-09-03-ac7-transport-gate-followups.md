# AC-7 전송 모드 게이트와 공허한 스위트 — 세션 핸드오프

| Field | Value |
| --- | --- |
| 작성일 | 2026-09-03 |
| 저장소 / 브랜치 | `C:\Work\git\_Snoworca\ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| 최종 작업 목표 | 우선순위가 높은 후보 셋을 순차 처리한다. HIGH(전송 모드 게이트) → C1(공허한 게이트) → S5-a0(도메인 전환) |
| 현재 상태 | 커밋 8개 전부 원격 반영. 추적 파일 변경 0건. 광역 node:test 0 fail |
| SSOT | 본 문서. S5-a0 만 `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md` 가 SSOT |
| 다음 세션 첫 행동 | 아래 "0. 다음 세션의 첫 행동" 참조 |

> 이 문서는 다음 세션이 **이 문서와 여기서 가리키는 SSOT 만 읽고** 작업을 이어갈 수 있도록 정리한 것이다. 대화 히스토리에 의존하지 말 것.

---

## 0. 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `git status --porcelain` 과 `git log --oneline -3` 으로 아래 "3. 현재 워킹트리·저장소 상태" 와 일치하는지 확인한다.
3. 아래 "8. 다음 세션 지시서" 의 **작업 A(HIGH)** 부터 시작한다. 사용자가 "우선순위가 높은 후보들을 순차적으로 처리" 하라고 지시했으므로 A → B → C 순서다.
4. 작업 A 는 조사부터 한다. 아래 "6. 미결정·유예 항목" 의 `wsTransportMode` 항목이 **설계 결정을 요구**하므로, 코드를 고치기 전에 그 결정을 먼저 세운다.

---

## 1. 최종 작업 목표

우선순위가 높은 후보 셋을 순차 처리한다.

| # | 작업 | 완료 조건 |
| --- | --- | --- |
| A | `IR-BGSTAB-001` AC-7 의 전송 모드 게이트 위배 해소 | 서버 설정이 `wsTransportMode: "split"` 일 때 클라이언트가 쿼리 파라미터를 생략해도 바이너리 협상이 거절된다. 그것을 증명하는 테스트가 있다 |
| B | `tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs` 의 공허 통과 해소 | 게이트가 형제 스위트를 실제로 실행하고, 형제 하나를 일부러 깨뜨렸을 때 red 가 된다 |
| C | S5-a0 — `encodedBytes` 도메인 전환 | `PERF-BGSTAB-011` AC-1 이 규정한 본문 바이트 도메인으로 JSON codec 경로가 전환되고, 회귀 0건 |

---

## 2. 현재까지 완료한 작업

이번 세션 커밋 8개. 전부 `origin/work/mcp-session-orchestration-20260709` 에 푸시 완료(`git log --oneline @{u}..HEAD` 가 빈 출력, 2026-09-03 실행).

- [x] **C3 — 소스 텍스트 계약의 검사 대상을 컴파일 산출물에서 `.ts` 원본으로** — 커밋 `2208d3b`. `server/src/services/TerminalAuthorityProductionRegression.test.ts` 18 insertions / 18 deletions
- [x] **`CLAUDE.md` 테스트 표면 지도 정정** — 커밋 `d3671e4`
- [x] **배선 — `realtime.terminalWireFormat` 이 프로덕션 `WsRouter` 에 도달** — 커밋 `21917f3`. `server/src/index.ts` 1 insertion, `server/src/test-runner.ts` 42 insertions
- [x] **부트 프로브 — 설정이 킬 스위치로 작동함을 실행으로 증명** — 커밋 `ddac3a4`. `server/src/ws/terminalWireFormatBoot.test.ts` 신규 326줄, `CLAUDE.md` 2 insertions / 1 deletion
- [x] 작업 기록 3건 — 커밋 `a048226`, `e511755`+`36614ff`, `a662633`

### 2.1 스위트 성적 (2026-09-03 실측)

| 스위트 | 실행 명령 (cwd) | 세션 시작 | 세션 종료 |
| --- | --- | --- | --- |
| 광역 node:test | `node node_modules/tsx/dist/cli.mjs --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts` (`server/`) | 863 tests / 836 pass / **13 fail** | 866 tests / 852 pass / **0 fail** |
| 서버 모놀리식 러너 | `node node_modules/tsx/dist/cli.mjs src/test-runner.ts` (`server/`) | 531 passed | **532 passed** |
| 부트 프로브 단독 | `node node_modules/tsx/dist/cli.mjs --test src/ws/terminalWireFormatBoot.test.ts` (`server/`) | (없었음) | **3 / 3 pass**. 벽시계 시간은 실행마다 다르다 — 세 번 측정해 14.4초·17.5초·18.3초 |
| `tsc --noEmit` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`server/`) | exit 0 | exit 0 |

광역 node:test 의 todo 14건은 `server/src/ws/WsRouterSplitHandshake.test.ts` 것이며 세션 시작 시점과 동일하다. 그것이 작업 B 와 성격이 같은 별개 항목이다(아래 "7. 남은 작업 전체 목록" 참조).

### 2.2 기억과 실제가 달랐던 항목

세션 중 사실로 적었다가 뒤집힌 것들. 다음 세션이 같은 오판을 반복하지 않도록 남긴다.

| 기록했던 진술 | 실제 (확인 방법) |
| --- | --- |
| "앵커를 `'readDriverViewIdentity: ('` 로 넓혀도 계약이 유지된다" | **거짓.** 인자 추가 뮤턴트가 살아남았다. 같은 뮤턴트를 두 앵커에 걸어 대조한 결과 느슨한 `(` 는 38/38 green, 정정한 `()` 는 35/38 로 3건 red |
| "`config.realtime` 을 객체째 넘기면 된다" | **거짓.** zod 가 `wsTransportMode` 도 채우므로 `WsRouter.ts:639` 의 하드코딩 `'unified'` 까지 대체되어 Wave-1 특성화 경로가 살아난다. `terminalWireFormat` 키 하나만 담은 리터럴을 넘겨야 한다 |
| "`wsTransportMode` 배선 결함은 이번 변경이 만든 것이 아니다" | **절반만 참.** 배선 결함 자체는 선재하나, **AC-7 위반의 도달 가능성은 커밋 `21917f3` 이 만들었다.** 그 커밋 이전 상태로 서버를 띄워 `wsTransportMode: "split"` + `terminalWireFormat: "binary-optin"` 을 설정하면 `terminal-binary:rejected` 가 나온다(서브에이전트 실측) |
| "`CLAUDE.md` 에 `BUILDERGATE_SERVER_ROOT` 를 빠뜨리면 즉시 `server/certs/` 와 `server/data/` 에 쓰기가 발생한다 (실측)" | **거짓.** 그 변수를 빼고 돌려도 두 디렉터리 모두 쓰기 0건이었다. `server/data/` 는 `process.cwd()` 기준이라 그 변수와 무관하고, `server/certs/` 는 인증서가 유효하면 `SSLService.ts:123-137` 이 재사용만 한다. **확인하지 않은 것에 "실측" 딱지를 붙인 사례다** |
| "`server/src/**/*.test.ts` 가 37개" (`CLAUDE.md` 의 기존 표기) | **거짓.** `find server/src -name '*.test.ts' \| wc -l` 결과 **60개**. 커밋 `ddac3a4` 에서 정정 |

---

## 3. 현재 워킹트리·저장소 상태

`git status --porcelain` (2026-09-03 실행) 기준.

- 브랜치: `work/mcp-session-orchestration-20260709`, `HEAD` = `a662633`, origin 과 동일(ahead 0 / behind 0)
- **추적 파일 변경 0건**
- 미추적 파일 8개 — 이 핸드오프 문서 자신 포함:
  - `docs/next/2026-09-03-ac7-transport-gate-followups.md` (이 문서)
  - `.codex/config.toml`, `CLAUDE.local.md`
  - `t1_verdict_1.txt`, `t1_verdict_2.txt`, `t2_verdict_1.txt`, `t2_verdict_2.txt`, `t2_verdict_incomplete_True.txt`
- `docs/next/LATEST.md` 는 이 문서를 가리키도록 수정되므로 `M` 으로 나타난다
- 커밋 여부 판단: 이 문서와 `LATEST.md` 는 커밋 권장. 나머지 7개는 이전 세션에서 "커밋에서 제외" 로 확정된 것이므로 건드리지 않는다

**⚠️ 이 저장소는 여러 세션이 공유한다.** mutate → run → restore 실험을 할 때는 매 단계 sha256 을 찍을 것.

---

## 4. 관련 문서·코드 (절대경로)

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| SRS | `C:\Work\git\_Snoworca\ProjectMaster\docs\spec\30.buildergate-stability.srs.md` | `IR-BGSTAB-001` 은 `:4970`, AC 는 `:4995` 부터. `PERF-BGSTAB-011` 은 `:5107` |
| S5 정본 | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md` | §S5 는 `:1744-1970`. S5-a0 는 `:1746-1761` |
| 백로그 A~E | `C:\Work\git\_Snoworca\ProjectMaster\docs\plan\2026-09-01.remaining-work-backlog.plan.md` | 남은 작업 원본 목록. D 그룹은 `:88-97` |
| 테스트 표면 지도 | `C:\Work\git\_Snoworca\ProjectMaster\CLAUDE.md` | 어느 스위트를 어떻게 돌리는지, exit code 를 믿을 수 없는 파일이 어느 것인지 |
| 직전 핸드오프 | `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-09-02-long-red-suite-cleanup.md` | 이번 세션이 이어받은 문서 |
| 이번 세션 보고서 | `C:\Work\git\_Snoworca\ProjectMaster\docs\report\2026-09-03.terminal-wire-format-wiring.md`, `…\2026-09-03.terminal-wire-format-boot-probe.md` | 배선과 부트 프로브의 상세 |

**작업 A 의 수정 대상 후보**: `C:\Work\git\_Snoworca\ProjectMaster\server\src\index.ts` (`:1531` 의 `new WsRouter(...)`), `C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouter.ts` (`:639`, `:1576-1579`)

**참고 선례**: `C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\terminalWireFormatBoot.test.ts` — 서버를 부팅해 설정 도달을 관측하는 유일한 테스트. 작업 A 의 검증도 같은 방식이 필요할 가능성이 높다

---

## 5. 확정된 결정 (변경 금지)

1. **소스 텍스트 계약 테스트는 `.ts` 원본을 읽는다** — **확정**. (근거: 커밋 `2208d3b`. 저장소의 다른 소스 텍스트 계약 테스트 넷이 전부 `.ts` 를 읽으며, `TerminalAuthorityController.test.ts:7537` 은 같은 어댑터를 이미 `.ts` 로 읽고 있었다)
2. **`terminalWireFormat` 만 `WsRouter` 에 넘기고 `wsTransportMode` 는 넘기지 않는다** — **확정**. (근거: 커밋 `21917f3`, `server/src/test-runner.ts` 의 `assert.doesNotMatch(construction, /wsTransportMode/u)`. 객체째 넘기면 Wave-1 특성화 경로가 살아난다. **작업 A 가 이 결정을 바꾸려면 그 단언부터 손대야 한다**)
3. **부트 프로브는 스키마 기본값을 핀하지 않는다** — **확정**. (근거: `docs/spec/30.buildergate-stability.srs.md:5003` 의 AC-7 이 "이 키의 기본값이 어느 값인지는 이 Requirement 의 불변식이 아니며" 라고 명시하고, `:5042` 의 2026-08-18 변경 노트가 그 불변식을 의도적으로 제거했다고 기록한다)
4. **모든 회귀 판정에 경계 대조군을 붙인다** — **확정**. 뮤턴트가 죽는 것만으로는 부족하다. 계약을 위반하지 **않는** 같은 형태의 변형이 green 인지 확인해, red 가 겨냥한 조건 때문임을 분리한다
5. **커밋 메시지에 시그니처를 넣지 않는다** — **확정**. (근거: `C:\Users\beom\.claude\CLAUDE.md` §6. 이번 세션 커밋 8개 전부 시그니처 0건)
6. **결정 게이트에서는 묻지 말고 권장안을 자동 선택한다** — **확정**. 2026-09-03 사용자 지시. 되돌리기 어렵거나 외부로 나가는 행위(force push, history 재작성, 대량 삭제)만 예외이며, 일상적인 `git push` 는 자동 진행에 포함된다

---

## 6. 미결정·유예 항목

- **작업 A 의 설계 방향** — `wsTransportMode` 를 `WsRouter` 에 넘기는 것만으로는 안 된다. `server/src/ws/WsRouterSplitHandshake.test.ts` 가 "Wave-1 production unified limitation characterization" 을 **todo 13건**으로 특성화해 두었으므로, split 전송 자체가 의도적 미구현이다. 그 파일의 todo 는 모두 14건이며 14번째(`WsRouter split reroutes queued output to control when output socket closes`)는 다른 문구(`Wave-3 split client-group routing; Wave 2 preserves the standalone split limitation (REL-BGSTAB-008 AC-10)`)를 단다. 그 특성화를 깨지 않으면서 AC-7 을 충족하는 방법을 먼저 정해야 한다. 결정 방법: 착수 시 조사 서브에이전트로 두 요구사항(AC-7 과 Wave-1 특성화)의 관계를 확인한 뒤 판단
- **`D-S5` 착수 시점** — 아래 "7. 남은 작업 전체 목록" 의 S5-a0 를 끝내야 S5-a 재측정에 들어갈 수 있다. 그 전에 `server/src/services/TerminalResourcePolicy.test.ts` 의 키 집합 단정 보강이 선행이다. `docs/research/binary-comms/06-work-plan.md:2413-2415` 를 직접 읽어 확인했다(2026-09-03): "§7 항목 9 — TerminalResourcePolicy.test.ts 키 집합 단정 보강 → S5 재측정 전", `strategy` · `visibilityWeight` · `driverWeight` 가 현재 무단정이며 기대값은 리터럴 `'deficit-round-robin'` / `8` / `16` 이고 resolver 재호출은 금지된다
- **S4-d 의 shadow parity soak** — 정본 테스트 `server/src/ws/binaryShadowParity.test.ts` 가 **존재하지 않는다.** `ls server/src/ws/binaryShadowParity.test.ts` 가 `No such file or directory` 를 반환한다(2026-09-03 실행). soak 자체가 미수행이라는 것은 ⚠️ 미검증 — 서브에이전트 보고이며 수행 기록의 부재를 저장소로 증명하기는 어렵다

---

## 7. 남은 작업 전체 목록

### 이번 세션이 넘기는 우선순위 셋

- [ ] **A (HIGH) — AC-7 전송 모드 게이트** — 완료 조건: 서버 설정이 `wsTransportMode: "split"` 일 때 클라이언트가 쿼리 파라미터를 생략해도 바이너리 협상이 거절되고, 그것을 증명하는 테스트가 있다. Wave-1 특성화(todo 14건)를 깨지 않는다
- [ ] **B (C1) — `boundary-gate` 공허 통과** — `tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs:35` 의 `spawnSync` 에 `env` 지정이 없어 `NODE_TEST_CONTEXT` 를 상속하고 형제를 0개 실행한 뒤 exit 0 을 낸다. 형제인 `admission-gate` 는 `:63` 에서 그 변수를 걸러낸다. 완료 조건: 형제를 실제로 실행하고, 형제 하나를 일부러 깨뜨렸을 때 red 가 된다 (⚠️ 미검증 — `CLAUDE.md:96` 의 2026-08-19 기록이며 이번 세션에서 재측정하지 않았다)
- [ ] **C (S5-a0) — `encodedBytes` 도메인 전환** — `PERF-BGSTAB-011` AC-1 이 "원장은 본문 바이트 도메인을 따르고 JSON codec 경로도 같은 도메인으로 전환한다" 고 규정한다. AC-9 가 "와이어가 아직 JSON 인 상태에서 먼저 수행하고 단독 측정한 뒤 opt-in 활성화" 를 못박는다. 완료 조건: 도메인 전환 후 회귀 0건, 그리고 단독 측정 결과가 기록된다

### 그 뒤

- [ ] **C2 — `WsRouterSplitHandshake.test.ts` 의 todo 14건 중 13건이 실패하는데 exit 0 이다.** 단독 실행은 `tests 28 / pass 14 / fail 0 / todo 14`(2026-09-03 실측). 그 13건은 성격이 셋으로 갈린다.

  | 성격 | 건수 | 비고 |
  | --- | --- | --- |
  | 실제로 깨진 단언 | 11 | `0 !== 1`, `3 !== 1` 등 |
  | `TypeError` | 1 | `split output pairing rejects wrong token…` (`:361`). `router.isValidSplitOutputPair` 가 프로덕션에 **없다**. 설정 배선과 무관한 미구현 API 다 |
  | `ZodError` | 1 | `split reroutes current output to control when output socket hits hard limit` (`:796`). `WsRouter` 생성자가 구성을 거부해 **단언에 도달조차 못 한다** |

  나머지 1건(`WsRouter split control connection returns group metadata and pair token`)은 todo 로 표시된 채 실제로 통과하며 `✖ failing tests:` 에 나타나지 않는다. 작업 A 가 "배선하면 몇 건이 풀리나" 를 셀 때 `TypeError`·`ZodError` 두 건을 분모에 넣으면 안 된다
- [ ] **C4 — `frontend/tests/e2e/busy-agent-workspace-bounce.spec.ts` 타이밍 취약** (10회 중 1회 배너 미출력)
- [ ] **B3 — E2E wave1 2건** — 실패 문구 `authority recovery live websocket input seam is unavailable`. seam 은 스펙이 `frontend/tests/e2e/wave1-retained-state-characterization.spec.ts:862-863` 의 `addInitScript`/`evaluate` 로 주입하므로 프로덕션에 seam 을 추가할 것이 아니라 주입이 왜 적용되지 않는지를 찾아야 한다 (⚠️ 미검증 — 2026-09-01 시점 기록)
- [ ] **S4-d 완료** — shadow parity soak (client `1/2/8` × session `1/8/32/54` 전수 불일치 0건)
- [ ] **S5-a / S5-b / S5-c0 / S5-c** — S5-a0 이후 순차
- [ ] **D 그룹 S6 · S7 · C6** — S5 이후
- [ ] **숨김 탭 스크롤백 유실** — 직전 핸드오프 `docs/next/2026-09-02-long-red-suite-cleanup.md` 참조. 사용자 확인 필요
- [ ] **`AC-8` — `/api/runtime-config` 에 `realtime.terminalWireFormat` 노출** — 미구현. `RuntimeConfigStore.getPublicRuntimeConfig`(`:274-288`)가 그 키를 노출하지 않고 `RuntimeConfigStore.ts` 전체에 그 이름이 0건이다 (서브에이전트 실측). SRS 자신이 `docs/spec/30.buildergate-stability.srs.md:625` 에 그 간극을 기록해 두었다
- [ ] **E 그룹(문서)** — `CLAUDE.local.md` 규칙 1 에 따라 **사용자가 직접 지시할 때만** 손댄다

---

## 8. 다음 세션 지시서

### 작업 A — AC-7 전송 모드 게이트 (먼저)

**확인된 사실** (서브에이전트가 서버를 실제로 부팅해 실측). 설정을 `realtime: { wsTransportMode: "split", terminalWireFormat: "binary-optin" }` 으로 두고 같은 서버에 두 가지로 접속한 결과다.

| 접속 URL | 협상 응답 |
| --- | --- |
| `/ws?token=…&wsTransportMode=split` | `terminal-binary:rejected` / `group-not-eligible` |
| `/ws?token=…` (파라미터 생략) | **`accepted: true`** |

원인 사슬이다.

1. `server/src/index.ts:1531` 이 `wsTransportMode` 를 `WsRouter` 에 넘기지 않는다 → `WsRouter.ts:639` 의 `this.wsTransportMode` 가 항상 `'unified'`
2. `WsRouter.ts:1576-1579` 의 `handleUpgrade` 가 쿼리 파라미터 부재 시 그 값을 fallback 으로 쓴다
3. 서버는 `url.searchParams.get('wsTransportMode')` 를 읽는데 브라우저는 `params.set('mode', 'split')` 을 보낸다(`frontend/src/utils/webSocketUrl.ts:58`). 이름이 달라 브라우저 연결에서 그 값은 항상 `null` 이다
4. `mode` 를 읽고(`:30`) `split-disabled` 게이트까지 갖춘(`:47-52`) 정식 파서 `server/src/ws/wsTransportMode.ts:23-93` `parseWsTransportRequest` 는 **프로덕션 임포터가 0건**이다. `grep -rn "parseWsTransportRequest" server/src frontend/src tools` 결과가 3건뿐이며 전부 자기 자신(`wsTransportMode.ts:23`)과 자기 테스트(`wsTransportMode.test.ts:4`·`:9`)다

(1~4 전부 2026-09-03 에 파일을 직접 열어 확인했다.)

**절차**

1. 조사 서브에이전트(모델 opus)로 **AC-7 과 Wave-1 특성화의 관계**를 확인한다 → 검증: `WsRouterSplitHandshake.test.ts` 의 todo 14건이 무엇을 특성화하는지, 그리고 `wsTransportMode` 를 배선하면 그중 몇 건이 어떻게 바뀌는지 실측으로 답이 나온다
2. 그 결과로 설계를 정한다. 위 "5. 확정된 결정" 의 2번이 `wsTransportMode` 를 넘기지 않기로 정했으므로, 바꾸려면 그 근거를 뒤집어야 한다 → 검증: 결정과 근거가 한 문장으로 정리된다
3. TDD — 실패 테스트를 먼저 쓴다. 부트 프로브(`server/src/ws/terminalWireFormatBoot.test.ts`)에 케이스를 추가하는 것이 자연스럽다. 설정이 `split` 일 때 파라미터 없는 연결이 거절되는지 보는 케이스다 → 검증: red 확인
4. 최소 구현 → 검증: 그 케이스가 green, 광역 node:test 실패 이름 집합이 늘지 않는다
5. 뮤테이션 + 경계 대조군 → 검증: 겨냥한 조건만 red 이고 무해한 변형은 green

### 작업 B — `boundary-gate` 공허 통과

1. `tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs:35` 와 형제 `…admission-gate.test.mjs:63` 을 대조한다 → 검증: `env` 지정 유무가 유일한 차이임을 확인한다
2. `admission-gate` 와 같은 방식으로 `NODE_TEST_*` 를 걸러낸다 → 검증: 게이트 실행 시간이 84ms 수준이 아니라 형제 9개를 실제로 도는 시간이 된다
3. 형제 하나를 일부러 깨뜨려 red 를 확인한다 → 검증: 게이트가 red

### 작업 C — S5-a0 도메인 전환

1. `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md:1746-1761` 을 정독한다 → 검증: S5-a0 가 무엇을 요구하는지 그 절에서 확인된다
2. `server/src/ws/wsSendPolicy.ts:631-644` 의 `fairDeliveryBytes()` 를 본다. 지금은 `createWsTransportMessage(...).byteLength`, 즉 JSON 봉투 전체를 센다 (⚠️ 미검증 — 서브에이전트 보고) → 검증: 그 함수를 직접 읽어 확인한다
3. **`wsSendPolicy.ts` 는 fair-scheduler provenance 핀 파일이다.** 저장 즉시 게이트가 닫히므로 `docs/next/2026-09-02-long-red-suite-cleanup.md` 의 재게시 절차를 따른다 → 검증: 핀 목록을 `server/tools/write-fair-scheduler-source-provenance.mjs:7-14` 에서 직접 확인한다
4. TDD → 최소 구현 → 회귀 → 뮤테이션

---

## 9. 거버넌스·게이트·함정

**규칙**

- dev 서버 포트는 항상 2222. `kill {pid}` 와 `taskkill /F /IM node.exe` 금지
- 연구·계획은 서브에이전트에 위임(모델 opus5). 검증도 서브에이전트 — 자기가 쓴 것을 자기가 검증하지 않는다
- 커밋 메시지에 시그니처 금지, 제목에 `Phase N`·`Step N`·`TASK-XXX` 금지
- 코드 주석은 검증(리뷰) 범위에서 제외
- 결정 게이트는 묻지 말고 권장안을 자동 선택한다(2026-09-03 사용자 지시)

**이번 세션에 실제로 밟은 함정**

- **앵커를 완화할 때는 그 앵커가 무엇을 함께 고정하고 있었는지 본다.** `'readDriverViewIdentity: () =>'` 에서 `=>` 만 떼려다 `()` 까지 떼어 "인자가 없다" 는 고정이 풀렸다. 슬라이스 안쪽만 겨냥한 뮤턴트로는 잡히지 않는다 — **인자 개수를 바꾸는 뮤턴트를 따로 걸어야 한다**
- **소스 텍스트 계약은 "그 줄이 있다" 만 증명한다.** `index.ts` 에 배선 줄이 있는지 보는 테스트는 `'json'` 하드코딩과 잘못된 출처(`runtimeValues.realtime?.…`)를 둘 다 놓쳤다. 출처까지 정규식에 넣으면 잡히지만, 그러면 의미가 같은 추출(`const wireFormat = …`)이 거짓 red 를 낸다
- **슬라이스 끝 앵커가 이른 위치를 가리키면 음성 단언이 조용히 공허해진다.** `indexOf('});')` 는 중첩 호출에 잘린다. `-1` 가드로는 못 막는다 — 값이 `-1` 이 아니라 그저 이른 위치이기 때문이다. **슬라이스가 대상 전체를 담았는지 요구하는 단언을 따로 둔다**
- **테스트가 무엇을 잡지 않을지도 설계해야 한다.** 부트 프로브의 케이스가 스키마 기본값을 핀했는데, AC-7 이 그 기본값을 자기 불변식에서 명시적으로 배제하고 `MIG-BGSTAB-004` 에 위임했다. 승인된 마이그레이션을 회귀로 오표기하게 된다
- **한 구멍을 메우면 다른 구멍이 열릴 수 있다.** 위 문제를 고치려고 케이스를 명시적 `json` 으로 바꾸자, 두 케이스 모두 `realtime` 을 명시하게 되어 실제 배포 형태(키 없음)가 커버리지에서 빠졌다
- **확인하지 않은 것에 "실측" 딱지를 붙이지 않는다.** 서브에이전트 보고를 문서에 옮기면서 실측 표기를 붙였고, 그 보고 자체가 부정확했다. 정정한 뒤에도 실측 범위(인증서 없음)를 넘어 검증하지 않은 조건(만료)까지 같은 딱지 아래 넣었다
- **검증자에게 넘기는 "정답" 이 틀리면 검증이 정확한 기록을 틀렸다고 판정한다.** 뮤턴트 개수를 4건으로 잘못 넘겨, 5건으로 정확히 적힌 작업 로그가 B 등급을 받았다
- **부팅 테스트의 포트는 `listen(0)` 으로 고를 수 없다.** `server/src/index.ts:129` 가 `HTTP_PORT = PORT - 1` 을 함께 바인딩하고 `:1620` 의 `listen()` 에 error 핸들러가 없어 `process.exit(1)` 한다. 인접 두 포트를 함께 잡아 봐야 하고, **예약 프로브에 호스트를 지정하면 안 된다** — 서버가 호스트 없이 `listen()` 하여 듀얼스택 `::` 에 바인딩하므로 `'0.0.0.0'` 으로 검사하면 거짓 "비어 있음" 판정이 난다
- **Windows 에서 자식 exit 직후 임시 디렉터리는 잠겨 있다.** `fs.rmSync` 가 `EPERM` 을 낸다. `maxRetries` 를 준다
- **`npx` 가 다른 체크아웃의 바이너리를 실행한다.** `node server/node_modules/tsx/dist/cli.mjs` 처럼 경로를 박는다

**복붙 가능한 테스트 명령**

```
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs src/test-runner.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/ws/terminalWireFormatBoot.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
cd C:\Work\git\_Snoworca\ProjectMaster\frontend && node --experimental-strip-types --test tests/unit/*.test.ts
```

광역 node:test 는 **exit code 를 믿을 수 없다.** `ℹ fail N` 요약 줄과 `✖ failing tests:` 목록을 봐야 한다.

---

## 10. 리스크·잔존 이슈

- **AC-7 위반이 도달 가능해졌다** — 영향: 설정이 `wsTransportMode: "split"` 이어도 클라이언트가 파라미터를 생략하면 바이너리 협상이 열린다. 기본 설정(두 키 모두 미설정)에서는 도달하지 않는다. 대응: 작업 A
- **부트 프로브가 케이스마다 서버를 띄운다** — 영향: 광역 node:test 가 약 18초 늘었고 케이스마다 인접 두 포트를 20000~40000 에서 잡는다. 다른 테스트와 병렬로 돌릴 때 알아야 한다. 대응: `CLAUDE.md` 의 테스트 표에 기록해 두었다
- **`SessionManagerTerminalAuthorityRuntimePorts.test.ts:764` 가 간헐적으로 실패한다** — 광역 실행 4회 중 1회 관측. 격리 실행 3회는 전부 통과(각 12/12). 실패 형태가 눈에 띈다: 바로 앞줄의 `retainedStateParity === false` 는 통과했는데 같은 사실을 담아야 할 `blockers` 배열에는 그 항목이 없었다. **한 사실을 두 곳에 따로 기록하는 구조로 추정되며, 그렇다면 flaky 가 아니라 두 값이 갈릴 수 있는 제품 쪽 문제다.** 이번 세션 범위 밖이라 조사하지 않았다
- **`TerminalAuthorityProductionRegression.test.ts` 의 `:1184` 앵커가 `.ts`·`.js` 양쪽에서 `-1` 이다** — 영향: `rollback` 슬라이스가 의도한 함수 대신 파일 끝까지 17,324자로 넓어져 세 정규식이 함수 바깥 코드에도 매치될 수 있다. 이번 변경이 만든 것이 아니다. 앵커는 `const scheduleTopologyRecovery` 인데 실제 식별자는 `scheduleCompatibilityTopologyRecovery` 다. **다만 이름만 고쳐서는 해결되지 않는다** — 그 식별자는 `.ts` 안에 2회 나오는데 둘 다 `rollbackStart` 보다 앞에 있으므로 `indexOf(..., rollbackStart)` 는 교체 후에도 `-1` 이다(2026-09-03 계산). 끝 앵커를 다시 고르거나 슬라이스 방식을 바꿔야 한다
- **`buildCheckpointCapability` 정규식 꼬리의 `[\s\S]*?` 가 인자 추가를 놓친다** — 영향: "인자 목록 전체를 고정한다" 는 주장이 성립하지 않는다. 선재 문제이며 닫으려면 인자 개수를 세는 단언으로 바꿔야 한다
- **`server/config.json5` 는 gitignored 다** — 다른 설치본에는 이 세션의 설정이 반영되지 않는다
