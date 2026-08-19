# 회귀 기준선 S-1 — wave3 부분 (그룹 D / 그룹 E)

바이너리 전환 코드 작업 **이전**의 "이미 깨져 있는 것" 기록. **측정 전용 — 아무것도 고치지 않았다.**

## 측정 메타

| 항목 | 값 |
|---|---|
| 측정 시각 | 2026-08-19T00:22:23+09:00 ~ 2026-08-19T00:35:20+09:00 (KST) |
| `git rev-parse HEAD` | `eb2f4f89b7a40c0461d11866b0a36f5bc2b4b8a9` |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| 워킹트리 | 추적 수정 121건 / 미추적 227건 (`git status --porcelain` 총 349행) |
| Node | v24.16.0 |
| 셸 환경 | `NODE_ENV=production` 이 셸에 설정되어 있음 → **모든 실행을 `env -u NODE_ENV` 로 감쌌다** |
| cwd | 모든 실행 `C:\Work\git\_Snoworca\ProjectMaster` (저장소 루트) |

**이번 측정에서 제외한 것**: Playwright E2E, `authority-promotion-evidence.test.mjs`, 백엔드/프론트 스위트.

---

## 1. 요약표

| 그룹 | 대상 수 | tests | pass | fail | todo | exit | 소요 |
|---|---|---|---|---|---|---|---|
| **D — closure 비-게이트** | 20 | 100 | 99 | 1 | 0 | 19×0 / 1×1 | 267.2s (합산, 직렬) |
| **D — `boundary-gate`** | 1 | 1 | 1 | 0 | 0 | 0 | 0.2s ⚠️ **vacuous** |
| **D — `admission-gate`** | 1 | 2 | 1 | 1 | 0 | 1 | 113s |
| **E — 증거 스크립트** | 4 | (아래 개별) | — | — | — | **4×1 (전부 실패)** | 35.2s (합산) |

**총 실패 건수**

- 그룹 D 고유 실패: **1건** (`lexical.test.mjs`). `admission-gate` 의 실패는 이 1건의 전파이지 독립 결함이 아니다.
- 그룹 E: **4개 스크립트 전부 exit 1**. 그 안에서 관측된 하위 테스트 실패 고유 건수는 **7건** (`canary` 1 + `retained-shadow-parity` 6) + 스크립트 자체 어서션 실패 2건 (`consumer-manifest`, `fair-scheduler-decision`).

### 그룹 D 비-게이트 20개 개별 결과

| 파일 (`tools/wave3/fair-readmission-closure-v3.` 접두 생략) | tests | pass | fail | todo | skip | cancelled | exit | ms |
|---|---|---|---|---|---|---|---|---|
| `admission.test.mjs` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 347 |
| `batch.test.mjs` | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 293 |
| `boundary.test.mjs` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 265 |
| `hardening.test.mjs` | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 254 |
| `ingress.test.mjs` | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 1,160 |
| `internal-core-race.test.mjs` | 15 | 15 | 0 | 0 | 0 | 0 | 0 | **110,224** |
| `internal-core.test.mjs` | 10 | 10 | 0 | 0 | 0 | 0 | 0 | 284 |
| `lexical-race.test.mjs` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 18,086 |
| **`lexical.test.mjs`** | 4 | 3 | **1** | 0 | 0 | 0 | **1** | 15,168 |
| `manifest-race.test.mjs` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 223 |
| `remediation.test.mjs` | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 28,847 |
| `reparse.test.mjs` | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 262 |
| `seal-race.test.mjs` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 18,461 |
| `seal.test.mjs` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 16,361 |
| `snapshot.test.mjs` | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 13,910 |
| `strict.test.mjs` | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 245 |
| `test.mjs` (베이스) | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 215 |
| `trust-race.test.mjs` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 14,679 |
| `trust.test.mjs` | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 14,760 |
| `wave.test.mjs` | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 13,159 |
| **합계** | **100** | **99** | **1** | **0** | 0 | 0 | — | **267,203** |

**교차검증 (exit code 만 믿지 말 것 규칙 적용)**: 22개 로그 전부에 대해 `todo` 카운트와 `✖` 목록을 대조했다. `todo>0` 인 파일 0건, `fail=0` 인데 `✖` 라인이 존재하는 파일 0건. 즉 `WsRouterSplitHandshake.test.ts` 류의 "exit 0 인데 실제로는 실패" 패턴은 그룹 D 에서 관측되지 않았다.

**독립 검산**: `admission-gate` 가 내부에서 21개 형제를 한 프로세스로 돌렸을 때 `tests 101 / pass 100 / fail 1` 이 나왔다. 위 표의 비-게이트 20개 합계 100 tests + `boundary-gate` 1 test = 101 로 정확히 일치한다. 파일별 개별 실행과 통합 실행의 수치가 어긋나지 않음을 확인했다.

### 그룹 E 4개 개별 결과

| 스크립트 (`tools/wave3/`) | 형태 | exit | ms | 내부 node:test 결과 |
|---|---|---|---|---|
| `canary-admission-evidence.test.mjs` | 하위 `npx tsx --test` 4파일 실행 | **1** | 18,127 | tests 74 / pass 73 / **fail 1** / todo 0 |
| `retained-shadow-parity.test.mjs` | 하위 `npx tsx --test` 4파일 실행 | **1** | 11,726 | tests 68 / pass 62 / **fail 6** / todo 0 |
| `terminal-resource-consumer-manifest.test.mjs` | 자체 어서션 (node:test 아님) | **1** | 177 | 해당 없음 — 최상위 `AssertionError` 로 즉시 중단 |
| `fair-scheduler-decision.test.mjs` | 벤치마크 재실행 후 대조 (node:test 아님) | **1** | 5,000 | 해당 없음 — 최상위 `AssertionError` 로 즉시 중단 |

---

## 2. 실패 목록

| # | 파일 | 테스트명 / 지점 | 실패 메시지 요지 | 추정 원인 분류 |
|---|---|---|---|---|
| D-1 | `tools/wave3/fair-readmission-closure-v3.lexical.test.mjs:61` | `SDS-AC-2 admits all sixteen frozen runtime import(identifier) edges without source rewrite` | `server/src/services/TerminalResourcePolicyCanary.test.ts must retain every literal static and proved dynamic occurrence of ./TerminalResourcePolicyCanary.js` — `15 !== 14` | **미커밋 작업** (근거 아래) |
| D-2 | `tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs:74` | `SDS-AC-3 runs the fixed nonrecursive closure gate with boundary and admission suites under 118 seconds` | `combined closure gate exited 1` — `1 !== 0` | **D-1 의 전파** (독립 결함 아님) |
| E-1 | `canary-admission-evidence` → `server/src/services/TerminalResourcePolicyCanary.test.ts:1:122715` | `PERF-BGSTAB-010 source canonical resolver rejects noncanonical authority` | `Error: authority resolver root option is unsupported` at `server/src/benchmarks/terminalFairnessCharacterization.ts:507:11` | **미커밋 작업** |
| E-2 | `retained-shadow-parity` → `server/src/services/RetainedTerminalAuthority.test.ts:814` | `RED reviewer — populated Ordinal64 rollover keeps oldest retained marker epoch-qualified` | `REL-BGSTAB-011 AC-1/AC-2 populated rollover mislabeled old-epoch retained markers`. actual `{oldestRetainedSeq:'0', oldestRetainedStreamEpoch:'8'}` vs expected `{'6','7'}` | **불명** (아래 주석) |
| E-3~E-7 | `retained-shadow-parity` → `server/src/services/SessionManagerPartialEscapeTail.test.ts` (5건) | `server RED — atomic authority revision race` / `unstable pending-write authority` / `split terminal escape ingest` / `split C1 CSI OSC and DCS stay incomplete until final ST CAN or SUB` / `pending tail sequence attachment` | 5건 전부 동일: `TypeError: Cannot read properties of undefined (reading 'toString')` at `SessionManager.queueAcceptedHeadlessOutput (server/src/services/SessionManager.ts:4391:61)` | **미커밋 작업** — 백엔드 기준선의 `nextTerminalAuthoritySourceSeq` undefined 19건 클러스터와 **동일 시그니처·동일 라인** |
| E-8 | `terminal-resource-consumer-manifest.test.mjs:461` | (최상위 어서션) | `consumer signature drift: frontend/src/components/Terminal/TerminalView.tsx#TerminalView#$callback:useEffect:0@121057` — 매니페스트에 동결된 `evidenceSignature` 문자열이 해당 소스에 더 이상 존재하지 않음 | **미커밋 작업** |
| E-9 | `fair-scheduler-decision.test.mjs` | (최상위 어서션) | `PERF-BGSTAB-010 artifact must match a fresh execution of the fixed benchmark contract`. 차이 필드: `sourceDigest`(`d995e30c…`→`fa991dd6…`), `digest`(`786c774a…`→`4f6a827e…`), publication 경로 해시 15쌍. `configHash`·`workloadSchemaHash`·`validatorVerdict:'accept'`·workload 파라미터는 **일치** | **미커밋 작업** |

### 원인 분류 근거 (관측 사실만)

`git status --porcelain` 으로 관련 파일의 추적 상태를 직접 조회한 결과:

```
 M frontend/src/components/Terminal/TerminalView.tsx
 M server/src/services/SessionManager.ts
?? server/src/benchmarks/terminalFairnessCharacterization.ts
?? server/src/services/RetainedTerminalAuthority.test.ts
?? server/src/services/SessionManagerPartialEscapeTail.test.ts
?? server/src/services/TerminalResourcePolicyCanary.test.ts
```

**실패에 연루된 소스 6개가 전부 미커밋이다** (수정 2 / 미추적 4). 개별 확증:

- **D-1**: `server/src/services/TerminalResourcePolicyCanary.test.ts` 는 HEAD 에 **존재하지 않는다** (`git ls-files --error-unmatch` → `did not match any file(s) known to git`). 파일 전체가 미커밋 작업물이다. 그 안의 `import(CANARY_MODULE_PATH)` 출현 횟수를 직접 세면 **15**, 반면 `lexical.test.mjs:77-80` 이 동결한 기대값은 `occurrences: 14 / dynamicOccurrences: 14`. 미커밋 작업이 15번째 동적 import 엣지를 추가했고 wave3 lexical 동결 계약이 갱신되지 않았다.
- **E-8**: `TerminalView.tsx` 는 워킹트리 **182,391 바이트** vs HEAD **90,686 바이트** — 미커밋 작업으로 2배 이상 커졌다. 테스트는 매니페스트의 `evidenceSignature` 를 소스 부분문자열로 `source.includes(...)` 검사하므로, 서명이 걸려 있던 `useEffect` 콜백이 재작성되면 즉시 drift 로 떨어진다.
- **E-9**: 차이나는 필드가 `sourceDigest` 와 그로부터 파생된 `digest`·publication 경로 해시뿐이고, `configHash`/`workloadSchemaHash`/workload 파라미터/`validatorVerdict:'accept'` 는 모두 일치한다. 즉 **벤치마크 결과(수치·판정)가 회귀한 것이 아니라 벤치마크 소스 바이트가 달라진 것**이다. 그 소스 `server/src/benchmarks/terminalFairnessCharacterization.ts` 는 미추적(`??`)이므로 아티팩트가 발행된 시점의 버전과 워킹트리 버전이 다를 수밖에 없다.
- **E-1**: 던져진 곳이 위와 같은 미추적 `terminalFairnessCharacterization.ts:507` 이다.
- **E-3~E-7**: 스택 최상단이 `SessionManager.ts:4391:61` 로, 지시받은 백엔드 기준선의 최대 클러스터(19건, `nextTerminalAuthoritySourceSeq` undefined)와 **같은 파일·같은 라인·같은 `TypeError` 문구**다. 지침대로 동일 원인으로 분류한다. `SessionManager.ts` 는 `M`(미커밋 수정)이고 호출자 `SessionManagerPartialEscapeTail.test.ts` 는 미추적이다.
- **E-2 (불명)**: 유일하게 미커밋 여부만으로 설명되지 않는 건. `RetainedTerminalAuthority.test.ts` 자체가 미추적이라 "테스트가 아직 RED 인 미완성 작업"일 가능성이 크지만(테스트명이 `RED reviewer —` 로 시작한다), 이번 측정만으로는 **의도된 RED 인지 실제 결함인지 판별할 근거가 없다.** 추측하지 않고 `불명` 으로 남긴다.

**실제 결함으로 분류된 건 0건이다.** 단, 아래 §3 의 vacuous 게이트는 실패로 집계되지 않는 별개의 구조적 발견이다.

### fair-scheduler provenance 핀 관련

사전 정보대로 provenance 게이트가 green 인 것과 별개로, **핀/동결 계약 때문에 red 인 것이 3건 관측됐다** (D-1 lexical 동결 카운트, E-8 consumer 매니페스트 서명, E-9 벤치마크 sourceDigest). 셋 다 "핀이 워킹트리를 읽는데 워킹트리가 미커밋 작업으로 앞서 나가 있다" 는 같은 구조다.

---

## 3. 재귀 게이트 처리 방식과 실제 소요

### 채택한 절차

지시받은 순서대로 (1) 게이트 2개를 제외한 20개를 파일별 직렬 실행(합 267.2s), (2) 그 다음 게이트 2개를 각각 실행하되 게이트의 최종 판정만 기록하고 형제 결과는 (1)을 정본으로 삼음. 10분 초과로 중단한 게이트는 없다.

| 게이트 | exit | 소요 | 게이트가 보고한 내부 `elapsed_ms` | 내부 실행 결과 |
|---|---|---|---|---|
| `boundary-gate.test.mjs` | 0 | **0.2s** | 84 | ⚠️ **아무것도 실행되지 않음** |
| `admission-gate.test.mjs` | 1 | **113s** | 112,208 | tests 101 / pass 100 / fail 1 |

### 발견: `boundary-gate` 는 vacuous pass 다

`boundary-gate` 는 형제 9개를 `spawnSync(node, ['--test', ...9files])` 로 돌리고 `result.status === 0` 을 어서션한다. 그런데 **84ms 만에 status 0 으로 끝났다.** 같은 명령을 셸에서 직접 돌리면 **35,466ms / exit 0 / 출력 6,438 바이트**가 나온다 (아래 §4 에 커맨드 전문). 즉 게이트 안에서는 형제가 실행되지 않았다.

스크래치패드에 동일 패턴의 최소 프로브를 만들어 원인을 확정했다:

```
NODE_TEST_CONTEXT=child-v8
elapsed=96 status=0 signal=null
STDOUT_LEN=0 STDERR_LEN=182
STDERR="(node:64244) Warning: node:test run() is being called recursively within a test file. skipping running files.\n"
```

`node --test` 로 실행 중인 프로세스는 `NODE_TEST_CONTEXT` 를 자식에게 상속시킨다. 자식 러너는 재귀 호출을 감지해 **파일 실행을 건너뛰고 경고만 남긴 뒤 exit 0** 한다. `boundary-gate` 는 `stdout` 을 status≠0 일 때만 출력하므로 이 경고가 보이지 않고, `assert.equal(result.status, 0)` 이 **공허하게 통과**한다.

대조군: `admission-gate` 는 spawn 시 env 를 명시적으로 세탁한다.

```js
env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))),
```

그래서 형제 21개가 실제로 돌았고(101 tests) D-1 을 정직하게 잡아냈다. `boundary-gate` 에는 이 필터가 **없다**.

부수 관측: `admission-gate` 의 중첩 실행 안에서도 `boundary-gate` 가 형제로 포함되어 돌았고, 거기서도 `fixed nine-file gate elapsed_ms=157` 로 똑같이 vacuous 통과했다.

### CLAUDE.md 의 재귀 게이트 경고와의 차이

CLAUDE.md 는 "`boundary-gate.test.mjs` 가 9개를 `node --test` 로 재실행한다 → 중첩 2단계 중복 실행" 이라고 기술한다. **Node v24.16.0 실측으로는 그렇지 않다** — `boundary-gate` 의 재실행은 런타임 재귀 가드에 막혀 일어나지 않는다. 중복 실행이 실제로 발생하는 것은 env 를 세탁하는 `admission-gate` 쪽뿐이다. (사실 기록일 뿐, 이번 작업에서 문서를 고치지는 않았다.)

---

## 4. 실행 커맨드 전문

모든 명령의 cwd 는 `C:\Work\git\_Snoworca\ProjectMaster`. 셸은 Git Bash. `&&` 연쇄를 쓰지 않았고 파일별 exit code 를 개별 기록했다.

### 그룹 D — 비-게이트 20개 (루프, 파일별 exit code 개별 수집)

```bash
for f in tools/wave3/fair-readmission-closure-v3*.test.mjs; do
  b=$(basename "$f")
  case "$b" in *admission-gate*|*boundary-gate*) continue;; esac
  S=$(date +%s%N)
  env -u NODE_ENV node --test "$f" > "$SP/D/$b.log" 2>&1
  EC=$?                      # 파일별로 즉시 캡처
  E=$(date +%s%N)
  echo "$b|exit=$EC|ms=$(( (E-S)/1000000 ))"
done
```

### 그룹 D — 게이트 2개 (각각 독립 호출)

```bash
env -u NODE_ENV node --test tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs
env -u NODE_ENV node --test tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs
```

### `boundary-gate` vacuous 검증용 대조 실행 (게이트 내부 spawn 의 재현)

```bash
env -u NODE_ENV node --test \
  tools/wave3/fair-readmission-closure-v3.test.mjs \
  tools/wave3/fair-readmission-closure-v3.remediation.test.mjs \
  tools/wave3/fair-readmission-closure-v3.reparse.test.mjs \
  tools/wave3/fair-readmission-closure-v3.batch.test.mjs \
  tools/wave3/fair-readmission-closure-v3.hardening.test.mjs \
  tools/wave3/fair-readmission-closure-v3.strict.test.mjs \
  tools/wave3/fair-readmission-closure-v3.ingress.test.mjs \
  tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs \
  tools/wave3/fair-readmission-closure-v3.wave.test.mjs
# → exit 0, 35,466ms, stdout 6,438 bytes  (게이트 내부에서는 84ms / stdout 0 bytes)
```

프로브 파일은 스크래치패드(`.../scratchpad/probe.test.mjs`)에만 생성했고 저장소에는 쓰지 않았다.

### 그룹 E — 증거 스크립트 3개 (직렬 루프)

```bash
for b in canary-admission-evidence retained-shadow-parity terminal-resource-consumer-manifest; do
  S=$(date +%s%N)
  env -u NODE_ENV node "tools/wave3/$b.test.mjs" > "$SP/E/$b.log" 2>&1
  EC=$?
  E=$(date +%s%N)
  echo "=== $b | exit=$EC | ms=$(( (E-S)/1000000 ))"
done
```

### 그룹 E — `fair-scheduler-decision` (CPU 벤치마크, 단독 실행)

```bash
env -u NODE_ENV node tools/wave3/fair-scheduler-decision.test.mjs
# 플래그 없음 — --regenerate-green 류는 일절 주지 않았다
```

**동시 실행 없음.** 모든 측정은 처음부터 끝까지 직렬이며, `fair-scheduler-decision` 실행 중에 다른 wave3 프로세스를 띄우지 않았다.

### `--verify-existing` 관련 사실 정정

지시문에는 `fair-scheduler-decision.test.mjs` 가 `--verify-existing` 를 받는다고 되어 있었으나, **HEAD `eb2f4f8` 시점의 해당 파일은 그 플래그를 파싱하지 않는다.** 이 파일이 읽는 argv 는 `--fixture-only` 하나뿐이다 (`process.argv.includes` 호출 1건). 벤치마크 소스 `server/src/benchmarks/terminalFairnessCharacterization.ts` 에도 `verify-existing` 문자열은 **0건**이다.

저장소에서 `--verify-existing` 이 등장하는 유일한 곳은 closure 수집기 `tools/wave3/fair-readmission-closure-v3.mjs:161` 인데, 거기서 **동결된 외부 명령 계약**으로 아래를 선언하고 있다:

```js
commandFamily('decision-validator', '.', [
  'node', 'tools/wave3/fair-scheduler-decision.test.mjs', '--verify-existing',
]),
```

즉 동결 계약이 **대상이 구현하지 않는 플래그**를 지정하고 있다. 이 플래그를 붙여도 무시되고 스크립트는 항상 벤치마크를 새로 돌려 대조하며, 현재 그 결과는 exit 1 이다.

따라서 "`--verify-existing` 모드는 번들을 자기 자신과 대조하므로 핀 건강성의 증거가 되지 않는다" 는 우려는 **이 파일에는 적용되지 않는다** (모드 자체가 없다). 어느 쪽이든 이번 측정에서 플래그는 하나도 주지 않았다.

---

## 5. 증거 스크립트의 파일 재생성 여부

**재생성 없음.** 측정 전/후 `git status --porcelain` 전문을 파일로 떠서 `diff` 한 결과 **완전히 동일**하다.

| 시점 | 총 행 수 | 비고 |
|---|---|---|
| 그룹 D 실행 전 (기준) | 349 | — |
| 그룹 D 종료 직후 | 349 | 기준과 `diff` 차이 0 |
| 그룹 E 전부 종료 후 | 349 | 기준과 `diff` 차이 0 |

보조 확인: 벤치마크 대조 대상 아티팩트 `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json` 의 mtime 은 측정 후에도 **2026-07-27 03:48:48 +0900** 그대로다 — 이번 실행이 덮어쓰지 않았다.

`retained-shadow-parity` 는 하위 테스트 실행(`runFocused`, 스크립트 580행)에서 어서션 실패로 즉시 중단되어, 산출물 기록 단계(648행 `phaseId: 'PH-004'` 이후)에 **도달조차 하지 못했다.**

한계: `git status` 는 gitignore 대상 산출물(예: `server/dist/**`, Playwright output)의 변화를 보여주지 않는다. 추적 대상 파일 기준으로는 변경 0건이다.

---

## 6. 주목할 것

1. **`boundary-gate` 는 형제를 검증하지 않는다 (vacuous pass).** `NODE_TEST_CONTEXT` 상속 → node 재귀 가드 → 0개 파일 실행 → exit 0. 이 게이트의 green 은 어떤 회귀에 대해서도 증거가 되지 않는다. `admission-gate` 는 `NODE_TEST_*` 를 필터링해서 정상 동작하며, 그 한 줄이 두 게이트의 유일한 차이다.
2. **wave3 closure 실패는 실질 1건뿐이고 그것도 동결 카운트 어긋남이다.** `lexical` 의 `15 !== 14`. 미커밋·미추적 테스트 파일이 15번째 동적 import 엣지를 얻었고 동결값이 14 에 머물러 있다.
3. **그룹 E 는 4개 전부 red 이며, 실패 원인이 하나같이 "미커밋 소스 vs 동결 핀"이다.** 연루된 소스 6개가 전부 `M` 또는 `??`. 바이너리 전환 작업이 `SessionManager.ts`·`TerminalView.tsx`·`wsSendPolicy` 계열을 건드리면 이 핀들은 **추가로** 깨진다 — 지금 이미 깨져 있다는 사실을 전환 후 red 와 혼동하지 말 것.
4. **`SessionManager.ts:4391` 클러스터가 wave3 까지 번져 있다.** `retained-shadow-parity` 실패 6건 중 5건이 백엔드 기준선 19건과 동일 지점이다. 이 한 곳을 고치면 백엔드 19 + wave3 5 = **최소 24건**이 함께 움직인다.
5. **동결 계약이 존재하지 않는 플래그를 가리키고 있다.** closure 수집기가 `fair-scheduler-decision.test.mjs --verify-existing` 를 동결 명령으로 선언하지만 대상은 그 플래그를 파싱하지 않는다(§4). 검증 명령이 의도한 모드로 돌고 있다는 가정은 성립하지 않는다.
6. **시간 예산 참고**: 비-게이트 20개 직렬 267s 중 `internal-core-race` 하나가 110s(41%)다. `admission-gate` 는 단독 113s. wave3 전체 재측정은 대략 **7분**이면 충분하다.
