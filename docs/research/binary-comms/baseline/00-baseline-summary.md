# S-1 회귀 기준선 — 종합

바이너리 데이터 평면 전환(S1 이후) **착수 직전**의 저장소 상태 기록. 목적은 하나다 — 나중에 red 가 나왔을 때 **"우리가 깬 것"과 "원래 깨져 있던 것"을 가르는 것**.

| 항목 | 값 |
|---|---|
| 측정일 | 2026-08-19 (00:07 ~ 01:10 KST) |
| HEAD | `eb2f4f89b7a40c0461d11866b0a36f5bc2b4b8a9` |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| **측정 대상** | **HEAD 가 아니라 워킹트리** — 추적 수정 121 / 삭제 1 / 미추적 227 엔트리 |
| 추적 파일 변경 | **0건** (측정 전용) |

> ⚠️ **이 기준선은 HEAD 의 상태가 아니다.** 워킹트리에 미커밋 작업이 대량으로 있고, 아래 실패의 **압도적 다수가 그것 때문**이다. 따라서 이 문서는 **같은 워킹트리에서만** 비교 기준으로 쓸 수 있다. 미커밋 작업이 커밋되거나 되돌려지면 **재측정이 필요하다.**

---

## 1. 전체 수치

| 갈래 | 문서 | tests | pass | fail | 비고 |
|---|---|---:|---:|---:|---|
| 백엔드 | [`backend-baseline.md`](./backend-baseline.md) | 1,305 | 1,239 | **52** | 2회 실행, 실패 집합 동일(flaky 아님) |
| 프론트 | [`frontend-baseline.md`](./frontend-baseline.md) | 612 | 605 | **7** | |
| wave3 | [`wave3-baseline.md`](./wave3-baseline.md) | 103 | 101 | **2** | + 증거 스크립트 4/4 실패 |
| E2E | [`e2e-baseline.md`](./e2e-baseline.md) | 155 | 55 | **84** | + flaky 9 / skip 7 |
| **합계** | | **2,175** | **2,000** | **145** | |

**실제 제품 결함으로 분류된 것은 0건이다.** 전부 미커밋 작업발 드리프트, 환경 의존, 또는 알려진 구조적 RED 다. 단 이는 "결함이 없다"는 뜻이 아니라 **"이번 측정에서 결함으로 귀속할 근거를 찾지 못했다"**는 뜻이다.

---

## 2. 한 곳이 24건을 쥐고 있다

`SessionManager.ts:4391` — `sessionData.nextTerminalAuthoritySourceSeq` 가 `undefined` 라 `TypeError: Cannot read properties of undefined (reading 'toString')`.

| 갈래 | 건수 |
|---|---:|
| 백엔드 그룹 A (`test-runner.ts`) | 14 |
| 백엔드 그룹 B (`server/src/**/*.test.ts`) | 5 |
| wave3 `retained-shadow-parity` | 5 |
| **합계** | **24** |

픽스처 두 곳에 `nextTerminalAuthoritySourceSeq: 0n` 을 넣으면 함께 해소된다. **바이너리 작업 중 이 시그니처가 보이면 우리 탓이 아니다.**

---

## 3. 신뢰할 수 없는 신호 — 착수 전에 반드시 알 것

측정 과정에서 **"통과하지만 아무것도 재지 않는" 사례가 다섯 건** 확인됐다. 회귀 판정에 그대로 쓰면 안 된다.

| # | 대상 | 증상 | 근거 |
|---|---|---|---|
| 1 | `WsRouterSplitHandshake.test.ts` | `fail 0 / **todo 14**` 로 **exit 0**, 그런데 todo 14개가 `✖ failing tests:` 에 assertion 실패로 찍힌다. 나중에 진짜 green 이 되어도 exit code 는 그대로 0 | 백엔드 측정 |
| 2 | `fair-readmission-closure-v3.boundary-gate.test.mjs` | 형제 9개를 **재실행하지 않는다.** `spawnSync` 에 `env` 미지정 → `NODE_TEST_CONTEXT` 상속 → node 재귀 가드가 `skipping running files` 로 **0개 실행 후 exit 0** → `assert.equal(status,0)` 공허 통과. 내부 84ms vs 셸 직접 실행 35,466ms | wave3 측정 + 최소 프로브 재현 |
| 3 | `--verify-existing` 플래그 | `fair-scheduler-decision.test.mjs` 는 이 플래그를 **파싱하지 않는다**(`--fixture-only` 뿐). 그런데 `fair-readmission-closure-v3.mjs:161` 이 이것을 **동결 명령 계약**으로 선언 — 존재하지 않는 플래그를 가리키는 계약 | 직접 grep |
| 4 | `FairTerminalDeliveryScheduler.test.ts:470` | 구현과 기대를 **같은 함수**에서 뽑는다 → 인코딩을 바꿔도 초록인데 아무것도 검증 안 함 | 연구 문서 `05` |
| 5 | Playwright exit code | 첫 시도에서 `PW_EXIT=1` 이었으나 배경 실행 래퍼는 **exit 0** 으로 보고(마지막 `echo`/`tee` 의 코드가 잡힘) | E2E 측정 |

**공통 규칙**: exit code 를 단독 신호로 쓰지 말고 **실행 건수·실패 목록과 항상 대조**한다.

---

## 4. E2E 기준선은 오염돼 있다 — 재측정 권고

E2E 실패 84건 중 **제품 로직에 대해 말해주는 것은 25건뿐**이다.

| 클러스터 | 건수 | 원인 |
|---|---:|---|
| **W-API** — precondition 단계에서 사망(500 ×32 / 409 ×8) | **39** | 고아 워크스페이스 잔재 + **워커 16 vs `maxWorkspaces` 10** |
| **OTHER** — 도메인 어서션 | 25 | 대부분 미커밋 작업 |
| **PANE** — `.pane-leaf` 미존재 | 10 | 구조적 RED (기존에 알려진 것, 그대로 재현) |
| **TUI** — 셸 프롬프트 대신 Claude Code TUI 렌더 | 7 | 환경 |
| **PS-EMPTY** — 시드 마커 소실 | 3 | 서버 노후 유력 |

**W-API 39건은 구조적으로 보장된 실패다.** 측정 시작 시점에 이미 **이전 세션이 흘린 고아 워크스페이스 2개**가 슬롯을 먹고 있었고, Playwright 가 **16 워커**로 도는데 `workspace.maxWorkspaces = 10` 이다. 한도 초과가 일어나지 않을 수 없다.

**권고**: `server/data/workspaces.json` 의 고아를 비운 뒤 `--workers=1` 또는 `--workers=2` 로 재측정하면 이 39건이 얼마나 줄어드는지 분리된다. 이번 측정에서는 **임의로 지우거나 죽이지 않았다.**

### 측정 후 남은 상태 (다음 실행자가 알아야 할 것)

- `start.bat` 이 띄운 **프로덕션 서버가 2222 에 살아 있다.** Playwright 가 회수하지 않았다
- **고아 워크스페이스가 7개로 늘었다** (측정 전 2개 → 후 7개)
- `reuseExistingServer: true` 때문에 **다음 사람이 E2E 를 돌리면 이 인스턴스를 그대로 재사용**한다 → 같은 오염을 물려받는다

---

## 5. 측정 자체의 함정 (기록)

- **`start.bat` 기동 실패**: Git Bash 가 `NoDefaultCurrentDirectoryInExePath=1` 을 설정해 `cmd.exe` 가 현재 디렉터리에서 배치 파일을 찾지 못한다. 파일 부재가 아니다
- **셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production`** 이 설정돼 있었고, 전부 **다른 런타임 루트**(`C:\Work\agent-tools\builder-gate__`)를 가리킨다. 그대로 두면 남의 config 로 서버가 뜬다 → **17개를 `env -u` 로 제거**하고 측정했다
- **Playwright 는 `wave1-characterization-artifacts.test.ts` 를 0건 수집하지만 부작용은 발생한다** — `testDir` 안에 있어 **수집 단계에서 import 되고 그때 `node:test` 의 `test()` 가 실제로 실행**된다
- **`authority-promotion-evidence.test.mjs` 는 이번엔 Playwright 를 돌리지 않았다** — `validateSourceIdentity()`(`:1676`)에서 E2E spawn **이전에** throw 한다. 미추적 `TerminalAuthorityController.test.ts` 의 테스트명 9개가 동결 목록에 없어서다. (코드상 spawn 은 실재하므로 위험 경고 자체는 유효하다)

---

## 6. 타입 검사 공백 — 계획의 전제 하나가 프론트에서 성립하지 않는다

작업 계획 §4.3 은 `WsTransportMessage.encoding` 을 **필수 필드**로 두어 *"모든 픽스처가 컴파일 에러로 드러나게"* 한다고 했다. **서버에서는 작동하지만 프론트엔드에서는 작동하지 않는다.**

- `frontend/tests/**` 는 `tsconfig.app.json` 의 `include: ["src"]` **밖**이라 `tsc -b` 대상이 아니다
- 테스트는 `node --experimental-strip-types` 로 도는데, 이것은 타입을 **제거만 하고 검사하지 않는다**

→ **프로토콜 타입이 바뀌어도 프론트 테스트는 침묵한다.** S4 에서 별도 장치가 필요하다.

---

## 7. 소스 텍스트를 대조하는 계약 테스트 — 오탐 위험 지점

대상 파일의 **서식·주석·식별자 변경만으로도 동작 회귀 없이 red** 가 되는 테스트가 최소 3건 있다(`terminalCheckpointRuntime`, `terminalContainerRecoveryContract`, `wsCheckpointProtocol`).

실제로 지금 `wsCheckpointProtocol.test.ts` 의 **유일한 실패가 순수 JSDoc 문구 차이**다 — 타입 선언은 완전히 동일하다. 프로젝트 규칙(CLAUDE.md)은 **주석을 검증 범위에서 제외**하는데 테스트가 주석 문구를 강제하고 있다.

S3·S4 가 `WebSocketContext.tsx` 와 `ws-protocol.ts` 를 반드시 건드리므로, **이 계열에서 red 가 나오면 먼저 서식 차이인지 확인**한다.

---

## 8. 재현 커맨드

각 갈래 문서의 §"실행 커맨드 전문" 참조. 공통 규칙:

- **`env -u NODE_ENV` 로 실행** (+ E2E 는 `BUILDERGATE_*` 15개와 `NoDefaultCurrentDirectoryInExePath` 도 제거)
- **`&&` 로 연쇄하며 stdout 을 버리지 말 것** — exit code 가 하나만 나와 어느 것이 실패했는지 알 수 없다
- **`kill` / `taskkill` 금지**
- wave3 는 **비-게이트 20개를 먼저** 파일별로 돌리고 게이트 2개를 나중에 (재귀 중복 실행 회피). 전체 약 7분
