# 장기 red 스위트 정리 완료 — 세션 핸드오프

| Field | Value |
| --- | --- |
| 작성일 | 2026-09-02 |
| 저장소 / 브랜치 | `C:\Work\git\_Snoworca\ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| 최종 작업 목표 | 오래 red 였던 테스트 스위트를 없애고, 그 과정에서 드러난 제품 결함을 고친다 |
| 현재 상태 | 제품 결함으로 남은 red 0건. 커밋 12개 전부 원격 반영 완료. 추적 파일 변경은 `docs/next/LATEST.md` 1건 |
| SSOT | 본 문서 |
| 다음 세션 첫 행동 | 아래 "0. 다음 세션의 첫 행동" 참조 — 새 작업 선택이 필요하다 |

> 이 문서는 다음 세션이 **이 문서만 읽고** 자율적으로 작업을 이어갈 수 있도록 정리한 것이다. 대화 히스토리에 의존하지 말 것.

---

## 0. 다음 세션의 첫 행동

**이번 세션의 목표는 달성되었다. 이어서 할 작업은 사용자가 고를 문제이므로, 먼저 선택지를 제시한다.**

1. 이 문서를 끝까지 읽는다.
2. `git status --porcelain` 과 `git log --oneline -3` 으로 아래 "3. 현재 워킹트리·저장소 상태" 와 일치하는지 확인한다.
3. 아래 "7. 남은 작업 전체 목록" 을 사용자에게 제시하고 어느 것부터 할지 묻는다.
4. 사용자가 지정하지 않으면 **D 그룹(바이너리 데이터 평면 사다리 S5)** 을 제안한다. 백로그에서 유일하게 "기능 전진" 이고 나머지는 인프라 정리이기 때문이다.

---

## 1. 최종 작업 목표

BuilderGate 의 오래 red 였던 테스트 스위트를 없앤다. 이번 세션의 완료 조건은 **"제품 결함으로 남은 red 가 0건"** 이었고, 달성했다.

남은 red 는 두 종류뿐이며 둘 다 제품 결함이 아니다.

- `dist/` 전용 스위트 13건 — `src/` 로 돌리면 실패하지만 빌드 대상으로 돌리면 38/38 통과
- `frontend/tests/unit/terminalHiddenOutput.test.ts` 의 `REL-BGSTAB-012` 1건 — 미구현 계약(자세한 내용은 아래 "6. 미결정·유예 항목")

---

## 2. 현재까지 완료한 작업

커밋 12개. 전부 `origin/work/mcp-session-orchestration-20260709` 에 푸시 완료(2026-09-02, `git push origin HEAD` 두 번: `6b2ec15..20b88a9`, `20b88a9..26c498c`).

- [x] 서버 모놀리식 러너 18 fail → 0 — 커밋 `35f247f`, `7804972`, `40d65b7`
- [x] frontend unit 낡은 capability 핀 정정 — 커밋 `29e991c`
- [x] 광역 node:test 진짜 실패 13건 중 11건 해소 — 커밋 `0315657`, `f893db1`, `20b88a9`
- [x] 카탈로그의 바이트 오프셋 핀 7개 → 0개 — 커밋 `934f2f7`
- [x] scrollback divergence 해소 (서버·브라우저가 하나의 policy 결정을 씀) — 커밋 `ff95e3d`
- [x] `REL-BGSTAB-007` 에 `VE-7` 등록 — 커밋 `2cef57a`
- [x] retained 마커 진실화 + 체크포인트 프레임 클램프 — 커밋 `26c498c`
- [x] 워크트리 분리 — `C:\Work\git\_Snoworca\ProjectMaster-markdown-editor` (`feature/markdown-editor`). 루트·frontend·server 에 `env -u NODE_ENV npm ci` 완료, `patch-package 8.0.1` 이 `react-mosaic-component@6.1.1` 패치 적용을 로그에서 확인

### 2.1 스위트 성적 (2026-09-02 실측)

| 스위트 | 실행 명령 (cwd) | 결과 |
|---|---|---|
| 서버 모놀리식 러너 | `npx tsx src/test-runner.ts` (`server/`) | **531 passed / 0 fail** |
| `TerminalAuthorityController` | `npx tsx --test src/services/TerminalAuthorityController.test.ts` (`server/`) | 147 / 0 |
| `RetainedTerminalAuthority` | `npx tsx --test src/services/RetainedTerminalAuthority.test.ts` (`server/`) | 41 / 0 |
| `TerminalResourcePolicyCanary` | `npx tsx --test src/services/TerminalResourcePolicyCanary.test.ts` (`server/`) | 26 / 0 |
| `TerminalResourcePolicy` | `npx tsx --test src/services/TerminalResourcePolicy.test.ts` (`server/`) | 20 / 0 |
| dist 회귀 | `node --test dist/services/TerminalAuthorityProductionRegression.test.js` (`server/`) | 38 / 0 |
| 매니페스트 스위트 | `node tools/wave3/terminal-resource-consumer-manifest.test.mjs` (루트) | **exit 0** |
| 광역 node:test | `npx tsx --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts` (`server/`) | 26 fail → **15 fail**, 새 실패 이름 0건 |
| frontend unit | `node --experimental-strip-types --test tests/unit/*.test.ts` (`frontend/`) | 904 tests / 903 pass / 1 fail |
| `tsc --noEmit` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`server/`, `frontend/` 각각) | 양쪽 exit 0 |

광역 node:test 의 남은 15건은 **13건이 `TerminalAuthorityProductionRegression`**(dist 전용)이고 2건은 `OBS-BGSTAB-005`(재봉인 후 green 확인 완료 — 이 15건 측정은 재봉인 **전** 시점이다).

### 2.2 기억과 실제가 달랐던 항목

세션 중 사실로 적었다가 서브에이전트 조사로 뒤집힌 것들. 다음 세션이 같은 오판을 반복하지 않도록 남긴다.

| 기록했던 진술 | 실제 (확인 방법) |
| --- | --- |
| "테스트 실행이 `TerminalResourcePolicyInventory.ts` 를 자동 갱신한다" | **거짓.** 그 파일은 `readFile`/`readdir` 만 import 하고 `writeFile`/`writeFileSync` 가 0건인 것을 확인했다. ⚠️ 미검증 — "무변경 실행 후 sha256 동일" 은 테스트를 돌려야 확인되고, "다른 서브에이전트의 수정" 은 저장소에 판별 수단이 없다 |
| "scrollback 의 `source`/`state` 라벨이 낡았으니 고쳐야 한다" | **당시엔 거짓.** divergence 가 실재했으므로 `divergent-legacy` 가 사실이었다. 라벨만 먼저 고치면 divergence 를 은폐하고 `TerminalResourcePolicy` 가 20/20 → 16/4 가 된다 (⚠️ 미검증 — 반사실 실험이라 저장소에 산출물이 없다. 확인하려면 라벨만 되돌려 그 스위트를 재실행한다). divergence 를 없앤 **뒤에야** 라벨을 고칠 수 있었다 |
| "롤오버 실패는 의도적 RED(미구현 기능)" | **거짓.** `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/retained-shadow-parity.json` 에 그 테스트가 `"status":"pass"` 로 봉인되어 있다. 봉인 레코드와 테스트 이름(`server/src/services/RetainedTerminalAuthority.test.ts:795`)의 실존은 확인되었으나, 본문 해시는 봉인 도구의 추출 알고리즘을 재현해야 재계산되므로 읽기만으로는 대조할 수 없다. 다음 세션이 확인할 방법: 그 도구의 `extractNamedTestBody` 로 다시 계산한다. ⚠️ 미검증 — per-test body sha256 `83e757e3…` 가 오늘과 바이트 동일하다는 것은 조사자 보고이며 읽기만으로는 대조할 수 없다 |
| "설정 파일에 캐논 키를 넣으면 divergence 가 해소된다" | **거짓.** 서버 headless 는 `pty.scrollbackLines` 를, 브라우저는 zod 파싱값을 읽어 **어느 쪽도 policy 결정을 쓰지 않았다.** 게다가 `server/config.json5` 는 `.gitignore:48` 로 gitignored 라 저장소에 반영되지도 않는다 |

---

## 3. 현재 워킹트리·저장소 상태

`git status --porcelain` (2026-09-02 실행) 기준.

- 브랜치: `work/mcp-session-orchestration-20260709`, `HEAD` = `26c498c`, `origin` 과 동일(ahead 0 / behind 0)
- 추적 파일 변경: **1건** — `docs/next/LATEST.md` (`M`, 이 문서를 가리키도록 갱신)
- 미추적 파일 8개 — 이 핸드오프 문서 자신 포함:
  - `docs/next/2026-09-02-long-red-suite-cleanup.md` (이 문서)
  - `.codex/config.toml`, `CLAUDE.local.md`
  - `t1_verdict_1.txt`, `t1_verdict_2.txt`, `t2_verdict_1.txt`, `t2_verdict_2.txt`, `t2_verdict_incomplete_True.txt`
- 커밋 여부 판단: 이 문서와 `LATEST.md` 는 커밋 권장. 나머지 7개는 이전 세션에서 "커밋에서 제외" 로 확정된 것이므로 건드리지 않는다

**⚠️ 이 저장소는 여러 세션이 공유한다.** ⚠️ 미검증 — 이번 세션 중 서브에이전트 셋이 각각 "내가 만들지 않은 파일 변경이 나타났다 사라졌다" 고 보고했다(대화 기록 주장이라 저장소로는 확인할 수 없다). 워크트리 `C:\Work\git\_Snoworca\ProjectMaster-markdown-editor` 도 활동 중이다(`git worktree list` 기준 `52bb643`, 이 세션이 만든 `873a442` 보다 앞섬). mutate → run → restore 실험을 할 때는 매 단계 sha256 을 찍을 것.

---

## 4. 관련 문서·코드 (절대경로)

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| 백로그 A~E | `C:\Work\git\_Snoworca\ProjectMaster\docs\plan\2026-09-01.remaining-work-backlog.plan.md` | 남은 작업의 원본 목록. 핀 파일 재게시 절차 부록 포함 |
| 직전 핸드오프 | `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-09-01-server-runner-degradation-backlog.md` | 이번 세션이 이어받은 문서 |
| 테스트 표면 지도 | `C:\Work\git\_Snoworca\ProjectMaster\CLAUDE.md` | 어느 스위트를 어떻게 돌리는지, exit code 를 믿을 수 없는 파일이 어느 것인지 |

**이번 세션이 새로 만든 도구**: `C:\Work\git\_Snoworca\ProjectMaster\tools\wave3\terminal-resource-consumer-manifest-reseal.ts`

봉인 아티팩트 재봉인 도구. 기본 실행은 **아무것도 쓰지 않고** 델타만 출력한다.

```
node server/node_modules/tsx/dist/cli.mjs tools/wave3/terminal-resource-consumer-manifest-reseal.ts            # dry-run
node server/node_modules/tsx/dist/cli.mjs tools/wave3/terminal-resource-consumer-manifest-reseal.ts --reseal   # 적용
```

증거 위치 이동과 소스 해시는 자동 재봉인되지만 **결정 축**(`source`·`state`·`applyBoundary` 등) 변경은 거부하고 델타를 출력한다. 의도된 변경이면 `--accept-decision-change` 를 붙인다. 도구의 정적 구현은 확인된다 — `:342` 가 `--reseal` 게이트, `:280`·`:291` 이 `--accept-decision-change` 게이트다. ⚠️ 미검증 — "분리 전에는 `--reseal` 한 번이 임의의 결정 변경을 조용히 승인했다" 는 뮤턴트 실행 결과이며 로그가 저장소에 없다.

---

## 5. 확정된 결정 (변경 금지)

1. **scrollback 은 서버·브라우저가 하나의 policy 결정을 쓴다** — **확정**. (근거: 커밋 `ff95e3d`, `server/src/services/RuntimeConfigScrollbackParity.test.ts` 5건이 이를 고정)
2. **retained 마커는 원장에서 진실하게 유지하고, 와이어 프레임에서만 클램프한다** — **확정**. (근거: 커밋 `26c498c`. 원장 값을 그대로 프레임에 넣으면 `oldestRetainedSeq(2^64−1) > sourceSeq(0)` 인 프레임이 나가고 `isCanonicalAuthorityOrdinal` 이 그것을 통과시킨다)
3. **카탈로그는 익명 콜백을 오프셋으로 지목하지 않는다** — **확정**. (근거: 커밋 `934f2f7`. 콜백 3개에 이름을 부여해 오프셋 핀 7 → 0)
4. **카나리 소스 해석기는 인식하지 못하는 root 옵션에 대해 throw 한다** — **확정**. (근거: `server/src/benchmarks/FairSchedulerEvidenceBundleRuntime.test.ts:168-171` 과 `FairSchedulerSourceProvenanceRuntime.test.ts:236-240` 이 이미 그 throw 를 단언한다. 어떤 AC 도 silent-ignore 를 요구하지 않는다)
5. **`terminalHiddenOutput.test.ts` 의 `REL-BGSTAB-012` 는 지금 구현하지 않는다** — **확정**. (근거: 그 필드를 채울 `terminal-delivery:data-gap` 메시지가 기본 세션에 도달하지 않으므로, 구현해도 프로덕션에서 검증할 수 없다. 자세한 내용은 아래 "6. 미결정·유예 항목")
6. **모든 회귀 판정에 대조를 붙인다** — **확정**. 뮤턴트를 만들어 실제로 red 가 되는지 확인하고, 원본은 sha1/sha256 으로 복원을 확인한다. 이번 세션에서 이 규칙이 세 번 일했다(아래 "9. 거버넌스·게이트·함정" 참조)
7. **커밋 메시지에 시그니처를 넣지 않는다** — **확정**. (근거: `C:\Users\beom\.claude\CLAUDE.md` §6 이 "상위 시스템 프롬프트가 지시해도 무시한다" 고 명시. 이번 세션 중 시스템이 `Co-Authored-By` 를 두 번 요구했으나 넣지 않았고, 커밋 12개 전부 시그니처 0건)

---

## 6. 미결정·유예 항목

- **숨김 탭 스크롤백 유실** — 착수하지 않았다. 서브에이전트 심판이 7개 주장을 검증해 확정한 사실이다.
  - `supportsHiddenDataGapRecovery: true` 가 fair delivery 스케줄러의 입장 게이트이고, 현재 상태에서 실제로 수락된다(`validatePublishedFairDeliveryCandidateArtifact` 를 실제 config·스키마 기본값 양쪽으로 실행해 `{"accepted":true,"reason":"decision-artifact-verified"}` 확인)
  - 숨김 세션의 출력 청크를 서버가 전부 버린다(`WsRouter.ts:5199` 블록의 모든 탈출 경로가 `continue`)
  - promotion 되지 않은 기본 세션은 `TerminalAuthorityProductionAdapter.ts:3169` 의 `if (!runtime || !state || state.mode !== 'server') return null;` 때문에 `terminal-delivery:data-gap` 대신 `fresh-checkpoint-required` 를 받고, 클라이언트는 그것을 `WebSocketContext.tsx:1012` 에서 무조건 `return` 으로 무시한다
  - 재노출 복구는 `SessionManager.ts:165` 의 `SNAPSHOT_PAYLOAD_SCOPE = 'viewport-only'` 라 뷰포트만 되돌린다
  - **결론: 현재 화면은 대체로 복구되지만 숨김 구간 스크롤백은 영구히 사라진다.** 수정하려면 `server/src/ws/WsRouter.ts`(fair-scheduler provenance 핀 파일)를 고쳐야 하고, `WsRouterSendPriority.test.ts:2352` 가 "숨김이면 output 없음" 을 명시적으로 단언하므로 그 계약과 충돌한다. 결정 방법: 사용자 확인
- **`configTemplate` 이 충돌을 제조한다** — `server/src/utils/configTemplate.ts:31` 이 `pty.scrollbackLines: 1000` 을, `:80` 이 `resourceLimits.terminal.scrollbackLines: 10000` 을 넣어 모든 신규 설치가 영구 `source-conflict` 로 시작한다. 정책이 캐논 우선으로 조용히 해소하므로 동작은 정상. 결정 방법: 사용자 확인
- **`REL-BGSTAB-007 AC-1` 체크박스** — 체크하지 않았다. "silent min/max coercion 금지" 조항을 확인하지 않았고, `effectiveRetainedScrollbackLines`·`retentionPolicyId` 는 이번 작업 이전부터 존재했다. **`VE-7` 의 범위 한정이 SRS 에 남지 않았다.** `add_verification_evidence` 에 넘긴 `notes` 가 반영되지 않아 `docs/spec/30.buildergate-stability.srs.md:2864` 는 `| VE-7 | commit | ff95e3d | AC-1 | - |` 로 Notes 열이 비어 있다. "하나의 결정 부분만 덮는다" 는 서술은 커밋 `2cef57a` 의 메시지 본문에만 존재한다. 결정 방법: 나머지 조항 확인 후 판단하되, 그 전에 Notes 를 SRS 에 반영할지 정한다

---

## 7. 남은 작업 전체 목록

- [ ] **D 그룹 S5** — 바이너리 데이터 평면 회계 재벤치 후 기본값을 `binary-optin` 으로 승격 — 완료 조건: 벤치 결과가 문서화되고 기본값이 바뀌며 회귀 0건
- [ ] **D 그룹 S6** — 혼합 버전 검증 후 기본값 `binary` (의존성: S5)
- [ ] **D 그룹 S7** — legacy JSON 경로 제거 (의존성: S6)
- [ ] **D 그룹 C6** — 마이크로벤치
- [ ] **C1** — `tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs` 가 공허하게 통과한다. `:35` 의 `spawnSync` 가 `NODE_TEST_CONTEXT` 를 상속해 형제 9개를 0개 실행하고 exit 0. 형제인 `admission-gate` 는 `:63` 에서 그 변수를 걸러내며 **그 한 줄이 두 게이트의 유일한 차이**다 — 완료 조건: boundary-gate 가 형제를 실제로 실행하고, 형제 하나를 일부러 깨뜨렸을 때 red 가 된다
- [ ] **C2** — `server/src/ws/WsRouterSplitHandshake.test.ts` 의 todo 14건이 실제로는 깨진 단언인데 exit 0 — 완료 조건: todo 가 실제 상태를 반영하거나 단언이 통과한다
- [ ] **C3** — `TerminalAuthorityProductionRegression.test.ts` 가 `src/` 로는 green 이 될 수 없다(`readFileSync(new URL('./…Adapter.js'))` 가 `dist/` 를 전제). 광역 node:test 의 남은 15건 중 13건이 이것이다 — 완료 조건: 광역 실행에서 이 파일이 skip 되거나, `src/` 에서도 성립하도록 바뀐다
- [ ] **C4** — `frontend/tests/e2e/busy-agent-workspace-bounce.spec.ts` 가 codex 기동 타이밍에 취약(10회 중 1회 배너 미출력)
- [ ] **B3** — E2E wave1 2건. 실패 문구는 `authority recovery live websocket input seam is unavailable`. seam 은 스펙이 `frontend/tests/e2e/wave1-retained-state-characterization.spec.ts:862-863` 의 `addInitScript`/`evaluate` 로 주입하므로 **프로덕션에 seam 을 추가할 것이 아니라 주입이 왜 적용되지 않는지**를 찾아야 한다 — ⚠️ 미검증(이번 세션에서 재측정하지 않았다. 2026-09-01 시점 기록)
- [ ] **숨김 탭 스크롤백 유실** — 위 "6. 미결정·유예 항목" 참조. 사용자 확인 필요
- [ ] **`REL-BGSTAB-012` 구현** — `dataGapPending` 원장 + `finishHiddenOutputReplay` 시그니처 변경. 스크롤백 유실을 먼저 해결해야 검증 가능
- [ ] **E 그룹(문서)** — `CLAUDE.local.md` 규칙 1 에 따라 **사용자가 직접 지시할 때만** 손댄다

---

## 8. 다음 세션 지시서

사용자가 D 그룹 S5 를 택했을 때의 절차다. 다른 것을 택하면 이 절은 무시한다.

1. `C:\Work\git\_Snoworca\ProjectMaster\docs\plan\2026-09-01.remaining-work-backlog.plan.md` 의 D 그룹 절을 읽는다 → 검증: S5 의 완료 조건이 무엇인지 그 문서에서 확인된다
2. 현재 롤아웃 단계 기본값이 `json` 인지 확인한다 → 검증: 설정 스키마나 코드에서 그 기본값을 찾는다
3. 회계 재벤치를 돌린다 → 검증: 벤치 산출물이 생기고 수치가 기록된다
4. 기본값을 `binary-optin` 으로 올린다 → 검증: 서버 러너 531 유지, 광역 node:test 실패 이름 집합이 늘지 않는다

---

## 9. 거버넌스·게이트·함정

**규칙**

- dev 서버 포트는 항상 2222. `env -u BUILDERGATE_CONFIG_PATH -u BUILDERGATE_DAEMON_STATE_PATH -u NODE_ENV node dev.js --port 2222`
- `kill {pid}` 와 `taskkill /F /IM node.exe` 금지
- 스크린샷은 `.playwright-mcp/`
- 연구·계획은 서브에이전트에 위임(모델 opus5). 검증도 서브에이전트 — 자기가 쓴 것을 자기가 검증하지 않는다
- 커밋 메시지에 시그니처 금지, 제목에 `Phase N`·`Step N`·`TASK-XXX` 금지
- 코드 주석은 검증(리뷰) 범위에서 제외

**이번 세션에 실제로 밟은 함정**

- **뮤턴트 없는 green 은 채택하지 않는다.** ⚠️ 미검증 — 아래 세 사례는 뮤턴트 실행 결과이며 로그가 저장소에 남아 있지 않다. 규칙 자체는 지킬 것. (1) PowerShell 재그리기 블록을 고쳐 green 을 만들었으나 겨냥한 갈래를 `false` 로 죽여도 통과했다 — 러너 전체의 실패 이름 집합이 뮤턴트 전후 동일. (2) `headlessApplyInFlight` 가드를 겨냥한 테스트가 같은 조건이 post-fence 에 중복되어 있어 가드를 지워도 통과했다. (3) 재봉인 도구의 결정 축 분리가 없을 때 `--reseal` 한 번이 임의의 결정 변경을 승인해 검증기가 green 이 되었다
- **경계 대조군을 붙인다.** 뮤턴트가 죽는 것만으로는 부족하다. 같은 형태이되 겨냥한 조건만 다른 대조 케이스를 함께 두어, red 가 그 조건 때문임을 분리한다. PowerShell 건에서 대조군을 target 앞에 배치해 한 번의 뮤턴트 실행으로 "대조군은 살고 target 만 죽는다" 를 증명했다
- **광역 대조가 내 수정의 회귀를 잡았다.** 롤오버 수정 후 `TerminalAuthorityController` 가 147/0 → 146/1 이 되었는데, 조사 서브에이전트는 그 파일을 돌리지 않아 놓쳤다(모놀리식 러너는 `*.test.ts` 를 디스커버리하지 않는다). **수정 후에는 반드시 광역 실행 + 실패 이름 집합 `comm` 대조**
- **핀 파일 뮤턴트는 false kill 을 낸다.** fair-scheduler provenance 핀 6개(`terminalFairnessCharacterization.ts`, `fairSchedulerAuthorityLocator.ts`, `wsSendPolicy.ts`, `WsRouter.ts`, `TerminalResourcePolicy.ts`, `TerminalResourcePolicyCanary.ts`)를 건드리면 게이트가 닫혀 뮤턴트와 무관하게 스펙이 빨개진다. 뮤턴트가 필요하면 스크래치 사본에 만든다
- **`npx` 가 다른 체크아웃의 바이너리를 실행한다.** 이 저장소 `server/node_modules/.bin` 이 비어 있어 `npx tsx` 가 `C:/Work/agent-tools/builder-gate__/server/node_modules/tsx` 를 집는 것을 관측했다. 확실히 하려면 `node server/node_modules/tsx/dist/cli.mjs` 또는 `node node_modules/typescript/bin/tsc` 처럼 경로를 박는다
- **파일 줄바꿈이 섞여 있다.** `server/src/services/SessionManager.ts` 는 CRLF 와 LF 가 혼재해, `'\r\n' if '\r\n' in s` 로 eol 을 정하는 치환이 실패한다. 줄 단위(`readlines` + 인덱스)로 처리한다
- **Bash heredoc 이 `\\` 를 접는다.** Windows 경로나 이스케이프가 든 문자열은 `Write` 도구로 스크립트 파일을 만들어 실행한다

**복붙 가능한 테스트 명령**

```
cd C:\Work\git\_Snoworca\ProjectMaster\server && npx tsx src/test-runner.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && npx tsx --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node --test dist/services/TerminalAuthorityProductionRegression.test.js
cd C:\Work\git\_Snoworca\ProjectMaster\frontend && node --experimental-strip-types --test tests/unit/*.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster && node tools/wave3/terminal-resource-consumer-manifest.test.mjs
```

광역 node:test 는 **exit code 를 믿을 수 없다.** `ℹ fail N` 요약 줄과 `✖ failing tests:` 목록을 봐야 한다.

---

## 10. 리스크·잔존 이슈

- **숨김 탭 스크롤백 유실** — 영향: 탭을 숨긴 채 빌드나 테스트를 돌리면 그 로그가 남지 않는다. 대응: 위 "6. 미결정·유예 항목" 의 결정 대기
- **여러 세션이 이 워킹트리를 공유한다** — 영향: 실험 중 파일이 예고 없이 바뀌거나 되돌아간다. 대응: mutate → run → restore 마다 sha256 확인
- **`TerminalAuthorityController.test.ts` 는 부하에 민감하다** — ⚠️ 미검증 — 서브에이전트가 259초·412초로 보고했고 2026-08-19 기준선을 40초로 인용했으나, 그 실행의 산출물이 저장소에 없고 `CLAUDE.md` 에도 40초 기록은 없다. 실행마다 실패 건수가 흔들릴 수 있으므로 단독 재실행으로 확인한다
- **⚠️ 미검증 — `oldestRetainedStreamEpoch` 가 `streamEpoch` 와 달라질 수 있게 되었다.** 커밋 `26c498c` 이후 처음이다. 조사자가 `SessionManager.ts` 의 읽기 지점 4곳(`:5403`, `:5835`, `:7255`, `:7477`)과 어댑터를 확인했으나 **프론트엔드는 감사하지 않았다.** 다음 세션이 확인할 방법: `frontend/src` 에서 `oldestRetainedStreamEpoch` 와 `oldestRetainedSeq` 를 검색해 두 값이 같다고 가정하는 소비자가 있는지 본다
- **`server/config.json5` 는 gitignored 다** — 이 세션에서 `resourceLimits.terminal.scrollbackLines: 10000` 을 넣었고 이제 실제로 효력이 있다. 다른 설치본에는 반영되지 않으며, 각자의 설정을 따르되 서버·브라우저는 항상 일치한다
