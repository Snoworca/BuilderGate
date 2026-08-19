# 회귀 기준선 S-1 — 프론트엔드(node:test 계열) 측정 기록

> 목적: 바이너리 전환 코드 작업 **이전**에 이미 red 인 항목을 확정해 둔다.
> 나중에 red 가 났을 때 *우리가 깬 것* 과 *원래 깨져 있던 것* 을 가르기 위한 기준선이다.
> **이 측정에서는 아무것도 고치지 않았다.** 파일 수정·커밋 없음.

## 0. 측정 컨텍스트

| 항목 | 값 |
|---|---|
| 측정 시각 | 2026-08-19T00:07:26+09:00 ~ 2026-08-19T00:10:54+09:00 (KST) |
| `git rev-parse HEAD` | `eb2f4f89b7a40c0461d11866b0a36f5bc2b4b8a9` |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| 워킹트리 | 추적 수정(` M`) 121건 / 미추적(`??`) 226 엔트리 (git 이 디렉터리를 접어서 세므로 실제 파일 수는 더 많다) |
| node | v24.16.0 |
| 실행 cwd | `C:\Work\git\_Snoworca\ProjectMaster\frontend` |
| 환경 | `env -u NODE_ENV` (파이프/서브셸 안 `unset` 은 효과 없음) |

**범위**: 브라우저·서버가 필요 없는 `node:test` 계열만. Playwright E2E(`npx playwright test`), 백엔드 스위트, `tools/wave3/` 는 이 문서의 범위 밖이다(다른 측정에서 다룬다). 이 측정 중 dev 서버를 띄우지 않았다.

## 1. 요약표

| 그룹 | 대상 | 파일 수 | 테스트 수 | pass | fail | 실패 파일 | 소요(합계, 프로세스 스폰 포함) |
|---|---|---:|---:|---:|---:|---:|---:|
| U | `frontend/tests/unit/*.test.ts` | 56 | 606 | 600 | **6** | 4 | 약 20.5s |
| K | `frontend/tests/benchmarks/*.test.ts` | 2 | 3 | 2 | **1** | 1 | 약 6.6s |
| W | `frontend/tests/e2e/wave1-characterization-artifacts.test.ts` | 1 | 3 | 3 | 0 | 0 | 약 0.3s |
| **합계** | | **59** | **612** | **605** | **7** | **5** | 약 27.4s |

파일 단위 exit code 기준: 59개 중 **54개 rc=0 / 5개 rc=1**.

### 그룹 K 내역 (2개 파일이 성격이 다르므로 분리 기재)

| 파일 | 테스트 | pass | fail | rc |
|---|---:|---:|---:|---:|
| `tests/benchmarks/terminalNoRenderFixture.test.ts` | 2 | 2 | 0 | 0 |
| `tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` | 1 | 0 | 1 | 1 |

## 2. 실패 목록 (총 7건 / 5개 파일)

| # | 파일 | 테스트명 | 실패 메시지 요지 | 추정 원인 분류 |
|---|---|---|---|---|
| 1 | `frontend/tests/unit/terminalCheckpointRuntime.test.ts:1234` | `capability withdrawal atomically rolls recovery into a clean legacy generation` | `deepStrictEqual` 불일치. actual 에만 `ready: false` 키가 더 있음 (나머지 8개 필드는 일치, `viewGeneration`/`registrationViewGeneration` 모두 8) | **미커밋 작업** |
| 2 | `frontend/tests/unit/terminalCheckpointRuntime.test.ts:1700` | `MIG-BGSTAB-002 drained ordered rollback consumes passive capability without rotating the view` | 동일 패턴. actual 에만 `ready: false` 키가 더 있음 (`viewGeneration` 7) | **미커밋 작업** |
| 3 | `frontend/tests/unit/terminalCheckpointRuntime.test.ts:1875` | `REL-BGSTAB-007/012 ordered rollback fences local restore until legacy responder enable` | 소스 텍스트 정규식 스캔 실패. `restoreStoredSnapshot` 본문이 `checkpointState?.active \|\| checkpointState?.recoveryPending \|\| checkpointState?.orderedRollbackPending` 패턴과 매치되지 않음 (assert msg: "the passive ordered rollback must return before reading or writing a local snapshot") | **미커밋 작업** |
| 4 | `frontend/tests/unit/terminalContainerRecoveryContract.test.ts:33` | `PERF-BGSTAB-010 browser ACK is emitted only after an accepted visible terminal write` | 소스 텍스트 정규식 스캔 실패. `WebSocketContext.tsx` 안에서 `type: 'terminal-delivery:capability' … supportsHiddenDataGapRecovery: false` 패턴을 찾지 못함 (assert msg: "PERF-BGSTAB-010 accepted delivery ACK boundary 계약 부재 때문에 실패") | **미커밋 작업** |
| 5 | `frontend/tests/unit/terminalHiddenOutput.test.ts:154` | `REL-BGSTAB-012 settles ledger and holds stale view through drain` | `strictEqual(undefined, true)` — "hidden delivery needs a pending dataGap ledger and cannot clear its restore barrier before checkpoint drain acknowledgement" | **미커밋 작업** |
| 6 | `frontend/tests/unit/wsCheckpointProtocol.test.ts:182` | `frontend and server expose the exact same checkpoint wire declarations` | `frontend/src/types/ws-protocol.ts` 와 `server/src/types/ws-protocol.ts` 의 체크포인트 선언 텍스트 비교. **차이는 `TerminalCheckpointContinuityRecord` 위의 JSDoc 주석 문구 한 블록뿐**이다 (frontend: "The server compares it with its issued retained-state record before permitting a stream rebind." / server: "WsRouter compares it with the server-issued record supplied by terminal authority before it can rebind a delivery stream."). 타입 선언 자체는 동일 | **미커밋 작업** |
| 7 | `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts:138` (assert 위치 `:79`) | `NO_RENDER paired benchmark RED 계약 — AC-9` | `assertFrozenImplementationSources()` 의 **candidate** 다이제스트 불일치. expected `sha256:75716d66…` / actual `sha256:eb5a13be…` | **알려진 RED** (사전 고지 항목, 재현됨) |

### 분류 근거 (관측 사실만)

- **#1~#3**: 테스트 파일 `frontend/tests/unit/terminalCheckpointRuntime.test.ts` 와 그 대상 구현 `frontend/src/utils/terminalCheckpointRuntime.ts` 가 **둘 다 미추적(`??`)** 이다. 즉 HEAD 에 존재하지 않는 미커밋 산출물끼리의 불일치다.
- **#4**: 테스트 파일 `terminalContainerRecoveryContract.test.ts` 와 스캔 대상 `frontend/src/contexts/WebSocketContext.tsx` 가 **둘 다 ` M`(추적 수정, 미커밋)** 이다.
- **#5**: 테스트 파일 `terminalHiddenOutput.test.ts` 가 ` M`(미커밋)이다.
- **#6**: 테스트 파일 `wsCheckpointProtocol.test.ts` 는 미추적(`??`), 비교 대상 `frontend/src/types/ws-protocol.ts` 와 `server/src/types/ws-protocol.ts` 는 **둘 다 ` M`(미커밋)** 이다. 그리고 두 파일의 실제 차이는 주석 한 블록이다. (CLAUDE.md Rules 상 주석은 검증 범위 제외이나, 이 테스트는 소스 텍스트를 문자열로 대조하므로 주석 차이가 그대로 red 로 나타난다 — 사실만 기록하며 여기서 수정하지 않는다.)
- **#7**: 이 테스트가 고정(freeze)한 candidate 는
  `sourcePath = frontend/src/utils/terminalOutputScheduler.ts`,
  `sourceRevision = 'T-PH003-04@ca111fef3b5a5a25d3aa488415c929e90ade46fd-worktree'`,
  `sourceDigest = 'sha256:75716d66fa60885eb90d602c6473fdcd2ceb4d34d30aae113c3ccf04f6452a76'` 이다 (`frontend/tests/benchmarks/terminalNoRenderFixture.ts` L20-23).
  즉 candidate 는 **커밋이 아니라 어느 워크트리 스냅샷** 을 다이제스트로 핀했다. 현재 워킹트리의 같은 경로 파일(` M`, 미커밋)은 `sha256:eb5a13be…` 로 해시된다. 파일 자체는 존재하므로 `readFileSync` 는 성공하고, 핀된 **내용** 이 HEAD 에도 워킹트리에도 없어 다이제스트 단계에서 red 가 된다. 사전 고지된 RED 가 그대로 재현되었다.
  참고: 같은 함수의 바로 앞 줄(L78) **baseline** 다이제스트 검사는 통과했다. baseline 은 `git show ca111fef…:frontend/src/utils/terminalOutputScheduler.ts` 로 커밋에서 읽으므로 워킹트리 상태와 무관하다.

### 분류 요약

| 분류 | 건수 |
|---|---:|
| 미커밋 작업 | 6 |
| 알려진 RED | 1 |
| 환경 | 0 |
| 실제 결함 | 0 |
| 불명 | 0 |

**"실제 결함" 0건은 "결함이 없다" 는 뜻이 아니다.** 이 측정은 각 실패에 대해 (a) 관련 파일의 git 추적 상태와 (b) assert 메시지만 확인했고, 근본 원인 진단은 지시에 따라 수행하지 않았다. 미커밋 작업이 그 자체로 결함일 수도 있으나 이 기준선은 그것을 판정하지 않는다.

## 3. 실행 커맨드 전문 (재현용)

모두 **cwd = `C:\Work\git\_Snoworca\ProjectMaster\frontend`** 에서 실행했다. 셸은 Git Bash.

### 3.1 단일 파일 (기본형)

```bash
cd /c/Work/git/_Snoworca/ProjectMaster/frontend
env -u NODE_ENV node --experimental-strip-types --test <파일경로>
echo "EXIT=$?"
```

### 3.2 실제로 사용한 러너 스크립트

파일별 exit code / 소요시간을 개별 기록하고, 한 파일이 실패해도 나머지를 계속 돌린다 (`&&` 연쇄 금지 규칙 준수). 파일당 180초 타임아웃.

```bash
#!/bin/bash
# usage: run-group.sh <outdir> <file...>
OUT="$1"; shift
mkdir -p "$OUT"
cd /c/Work/git/_Snoworca/ProjectMaster/frontend || exit 1
for f in "$@"; do
  key=$(echo "$f" | tr '/' '_')
  start=$(date +%s%3N)
  timeout 180 env -u NODE_ENV node --experimental-strip-types --test "$f" > "$OUT/$key.log" 2>&1
  rc=$?
  end=$(date +%s%3N)
  echo "$f|rc=$rc|ms=$((end-start))"
done
```

### 3.3 그룹별 호출

```bash
# 그룹 U (56개) — 3배치로 분할 실행
bash run-group.sh <logdir> $(ls tests/unit/*.test.ts | sed -n '1,14p')
bash run-group.sh <logdir> $(ls tests/unit/*.test.ts | sed -n '15,32p')
bash run-group.sh <logdir> $(ls tests/unit/*.test.ts | sed -n '33,56p')

# 그룹 K + W
bash run-group.sh <logdir> \
  tests/benchmarks/terminalNoRenderFixture.test.ts \
  tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts \
  tests/e2e/wave1-characterization-artifacts.test.ts
```

### 3.4 대상 파일 목록 확정 방법

```bash
ls tests/unit/*.test.ts        # 56개
ls tests/benchmarks/*.test.ts  # 2개 (terminalNoRenderFixture.test.ts, terminalOutputSchedulerBenchmark.test.ts)
                               # 같은 디렉터리의 terminalNoRenderFixture.ts / terminalNoRenderFixtureEvidence.ts 는
                               # *.test.ts 가 아니므로 대상 아님 (헬퍼)
```

## 4. 이 기준선이 **커버하지 않는 것** (중요)

### 4.1 타입 검사 공백

이 측정은 **타입 오류를 전혀 검출하지 못한다.** 두 가지 이유가 겹친다.

1. `frontend/tests/**` 는 `tsconfig.app.json` 의 `include: ["src"]` **밖**이다 → `tsc -b` 의 검사 대상이 아니다.
2. `node --experimental-strip-types` 는 타입 어노테이션을 **제거만 하고 검사하지 않는다**.

즉 `frontend/tests/**` 의 타입 오류는 **어느 경로로도 red 가 되지 않는다.** 바이너리 전환으로 프로토콜 타입이 바뀌어도 테스트 코드의 타입 불일치는 이 기준선에서 침묵한다. 타입 회귀를 보려면 별도 수단이 필요하다.

또한 위 실패 중 #3·#4·#6 은 **소스를 문자열/정규식으로 대조**하는 계약 테스트다. 이런 테스트는 타입 검사와 무관하게, 대상 파일의 서식·주석·식별자 이름 변경만으로도 red 가 된다. 바이너리 전환 중 해당 파일을 건드리면 동작 회귀가 없어도 색이 바뀔 수 있다.

### 4.2 실행 범위 밖

- Playwright E2E (`npx playwright test`, `frontend/tests/e2e/*.spec.ts`) — 브라우저·서버 필요, 미측정
- 백엔드 스위트 (`server/src/test-runner.ts`, `server/src/**/*.test.ts`, `server/tools/*.test.*`) — 미측정
- `tools/wave3/`, `tools/wave1/`, `tools/daemon/` — 미측정

### 4.3 격리에 대한 주의

이 그룹(U/K/W)은 파일마다 독립 node 프로세스로 실행했고, 서로를 spawn 하는 것을 관측하지 못했다. 다만 `tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` 는 `execFileSync('git', ['show', …])` 로 **git 을 호출**하므로 저장소 상태(HEAD/워킹트리)에 의존한다 — 순수 인메모리 테스트가 아니다.
