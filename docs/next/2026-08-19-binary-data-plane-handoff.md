# 바이너리 WebSocket 데이터 평면 전환 — 세션 인계

| 항목 | 값 |
|---|---|
| 작성 | 2026-08-19 |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| 다음 작업 | **S4 (클라이언트 배선) — C0~C6** |
| 계획 SSOT | `docs/research/binary-comms/06-work-plan.md` |
| 프레임 사양 SSOT | `docs/research/binary-comms/01-frame-format-and-negotiation.md` |

---

## 1. 이 작업이 무엇인가

터미널 데이터 평면을 **JSON → versioned binary frame** 으로 전환한다. control 평면은 JSON 을 유지하고 **output/snapshot 평면만** 바꾼다.

**착수 배경에서 반드시 알아야 할 것**: 원래 계획(GitHub `Snoworca/BuilderGate#19`)은 *"측정 게이트 2개가 모두 참일 때만 착수"* 하는 조건부였다. 두 게이트 모두 **임계값이 숫자로 확정된 적이 없어** 판정 가능한 조건이 아니었고, **2026-08-16 오너 결정으로 폐기**됐다. 근거와 무효화 범위는 `docs/research/binary-comms/00-decision-record.md`.

⚠️ **"Orca IDE 처럼 바이너리로" 라는 동기는 사실이 아니다.** 저장소 자체 감사(`docs/research/2026-07-15.orca-buildergate-...fact-check-and-plan.ko.md:336`)가 Orca 공식 소스를 커밋 `e0edc8e` 로 고정해 확인한 결과 **Orca 는 control/stream 모두 UTF-8 NDJSON/JSON 문자열**이다. 이 전환의 근거는 *"Orca 가 그렇게 한다"* 가 아니라 **프로젝트 오너의 설계 결정**이다. 성능 개선 여부는 도입 후 측정으로 확인한다. 그 감사 결과는 삭제하지 않고 `00-decision-record.md` §5 에 보존돼 있다.

---

## 2. 확정 사양 (재론 금지)

### 프레임 헤더 — 28 B, big-endian

```
offset size field
0      1    frameVersion
1      1    opcode
2      2    flags
4      4    channelId
8      8    streamEpoch   (uint64)
16     8    sourceSeq     (uint64)
24     4    payloadLength (프롤로그 포함)
28     …    payload = 프롤로그 + 세그먼트 디스크립터 배열(16B×N) + 본문
```

- **`sessionId`·`deliverySeq` 는 헤더에 없다.** 2계층 식별 모델 — 전송 서수는 헤더, 애플리케이션 식별자는 **opcode 별 프롤로그**. `authorityEpoch` 는 UUID 라 8바이트에 안 들어가서 `authorityEpochIndex`(uint16)로 우회
- **최소 유효 OUTPUT 프레임 = 52 B** (헤더 28 + 프롤로그 24, `payloadLength=24`, `channelId=1`). `channelId=0` 은 예약 → `reserved-channel`
- 프롤로그: `0x01` 24B / `0x02` 24B / `0x03` 24B / `0x04` 160B / `0x05` 12B / `0x06` 88B / `0x07` 12B
- opcode 공간: `0x01`~`0x07` 사용 / `0x08`~`0x3F` 예약 / `0x40`~`0x7F` 벤더 / `0x80` `JSON_ENVELOPE` 예약 / `0x81`~`0xFE` 미할당 / `0x00`·`0xFF` 영구 예약

### 설정 키

`realtime.terminalWireFormat` — **`wsTransportMode` 와 직교**한다(enum 을 넓히지 않는다). 값은 4값 사다리 **`json | binary-shadow | binary-optin | binary`**.

### 결정 (D1~D15, Q1~Q6)

전부 `06-work-plan.md` **§3.5** 가 SSOT. 오너가 **"권장안을 따른다 + 나머지 모두 승인"** 으로 확정했다. 특히:

- **D3** — 바이너리는 **`unified` 에서만**. split 은 별도 판단
- **D5** — 롤백 트리거 4종이 **단일 롤백 함수**로 수렴
- **D10** — 협상 메시지는 **요청/응답 type 분리** (`terminal-binary:negotiate` C→S / `:capability` S→C / `:rejected` / `:channel-retired` / `:unknown-channel`)
- **D12** — 4값 사다리
- **D13/D14/D15** — 아래 §4 참조

---

## 3. 완료된 것

| 단계 | 내용 | 상태 |
|---|---|---|
| **S0** | wave-5 SRS 저작 — `IR-BGSTAB-001` · `FR-BGSTAB-024` · `PERF-BGSTAB-011` · `MIG-BGSTAB-004` (전부 `planned`/`evolving`) + Scope 패치 5건 + trace 21에지 + 노트 9건 | ✅ 검증 통과 |
| **S0.5** | provenance republish 리허설 (4단계) | ✅ **통과** |
| **S-1** | 회귀 기준선 — `docs/research/binary-comms/baseline/` | ✅ |
| **S1** | payload 재파싱 제거 (사이드카 승격) | ✅ 검증 통과 (C0/H0) |
| **S2** | 프레임 인코더/디코더 + 골든 벡터 | ✅ 78/78 |
| **D14** | bit3 프레임별 검사 | ✅ |
| **S4-0** | 프론트 타입검사 도입 | ✅ exit 0 |
| **연구 07·08·09** | 프롤로그 4종 / 클라이언트 배선 / 타입검사 공백 | ✅ |

### 신설·변경 파일

**코드**
- `server/src/ws/binaryFrameCodec.ts` (신규) — 인코더/디코더
- `server/src/ws/binaryFrameCodec.test.ts` (신규, 78 테스트)
- `server/src/ws/__fixtures__/binary-frame-vectors.json` (신규) — **골든 벡터 SSOT**
- `server/src/ws/wsTransportSidecar.test.ts` (신규, 13 테스트)
- `server/src/ws/wsSendPolicy.ts` · `WsRouter.ts` (수정) — **핀 파일**
- `frontend/tsconfig.test.json` (신규) + `frontend/package.json` `typecheck:tests`

**문서**
- `docs/research/binary-comms/00`~`09` + `baseline/` 5개

---

## 4. 다음 작업 — S4 (C0~C6)

정본: `06-work-plan.md` **§5 S4-b2**, 상세 설계는 `08-client-wiring-design.md`.

```
C0 P5 재고정 → C1 xterm 특성화(코드 0) → C2 enqueueBytes
→ C3 하류 시그니처 + restore 게이트 → C4 IR 도입(JSON 전용 순수 리팩터)
→ C5 수신 분기 + 프론트 코덱 → C6 마이크로벤치 + 동등성
```

### 핵심 지렛대

**`binary-shadow` 는 와이어가 JSON 이라 클라이언트 바이너리 경로가 S5 까지 프로덕션에서 한 번도 안 돈다.** 그래서 **C4(최대 위험 구간)를 "동작 불변 리팩터"로 격리**할 수 있다.

### 반드시 알아야 할 것

1. **`onOutput` 은 전체 재작성이 아니다.** `TerminalContainer.tsx:3192-3443` 을 책임 6개로 분해하면 **codec 의존은 세그먼트 분할 8줄뿐**이다. 나머지는 `data:string` 대신 `{data, byteLength}` 를 받으면 그대로 공유된다. → 중립 IR(`frontend/src/utils/terminalOutputDelivery.ts`) + 어댑터 2개
2. **바이너리는 control 소켓으로 온다.** `wsTransportMode` 기본이 `unified` 라 split output 소켓이 생성되지 않는다. `binaryType='arraybuffer'` 를 **`WebSocketContext.tsx:1201`(control)에 넣어야** 효과가 있다. `:1007` 도 필수. **`onmessage` 할당 전**에 설정
3. **`enqueue` 를 넓히지 말고 `enqueueBytes` 를 신설하라.** `TextEncoder.encode(Uint8Array)` 는 던지지 않고 **`"27,91,49"` 를 인코딩**한다 (조용한 손상)
4. **디코더는 처음부터 배치 루프.** 1:1 을 가정한 `byteLength !== 28 + payloadLength` 검사는 **전 트래픽을 폐기**한다
5. **restore 게이트** `terminalOutputScheduler.ts:454-462` 는 **live PTY 출력 경로**다. snapshot 범위로 오인해 미루면 *"restore 대기 중 보류된 live 출력이 전부 거부된다"*
6. **프론트 코덱은 서버 코덱을 import 하지 않는다.** 이중 구현이 의도다 — 차분 테스트가 성립하려면 그래야 한다. 공유는 **골든 벡터 1개뿐**. 경로 선례: `frontend/tests/unit/wsCheckpointProtocol.test.ts:184`
7. **`assertContiguousSegments` 를 공유 순수 함수로 추출하라.** `visibleOutputRecovery.ts:421`/`:434`/`:436` 의 세그먼트 연접성 검증이 **바이너리 경로에서 조용히 사라진다** — 코덱은 `byteStart`/`byteEnd` 를 읽기만 한다
8. **`viewportRows[]` 함정** — wire 에서 100% 중복이라 제거가 `0x03` 이득의 대부분인데, **라운드트립 계약을 "클라이언트 관측 투영"으로 재정의하지 않으면 차분 테스트가 구조적으로 실패**한다

### 착수 전 확인 (S4-0b, `07` 열린 항목 9건 중 필수 3)

1. `retainedTerminalStreamEpochCounter` 와 controller `streamEpoch` 가 같은가 → 같으면 `0x04` 프롤로그 8 B 중복
2. 체크포인트 트랜잭션 도중 lane 폴백이 가능한가 → 가능하면 소켓 경계 순서 역전으로 `non-monotonic-source-seq`
3. `responderLeaseId` 의 checkpoint wire 대입 경로 부재 — 현재 인코더가 loud reject

---

## 5. 함정 — 이것을 모르면 시간을 버린다

### 5.1 provenance 핀 (최대 위험)

`server/src/ws/wsSendPolicy.ts` 와 `WsRouter.ts` 는 **핀 대상**이고, 핀은 **워킹트리를 직접 읽는다**(`server/tools/write-fair-scheduler-source-provenance.mjs:28`, git 호출 0건).

**파일을 저장하는 순간** digest 가 어긋나고 `WsRouter.ts:1956-1966` 이 capability 를 `accepted:false` 로 돌려 **fair scheduler 가 모든 연결에서 오류 없이 조용히 꺼진다.**

**복구는 2단계다** (S0.5 리허설 + S1 실작업에서 재확인):
1. `publishFairSchedulerAuthorityGeneration` 재발행 (**~5초**) — `server/src/benchmarks/terminalFairnessCharacterization.ts`, 시드 `{clients:[1,2,8], wanLatencyMs:150, wanJitterMs:20, wanLossPercent:0, seed:20260723, repeats:5, samples:30}`, `authorityRoot=docs/analysis/terminal-fairness-authority`
2. **server 빌드** — 이걸 안 하면 dist 매니페스트가 stale 이라 여전히 red

⚠️ **매니페스트만 다시 쓰면 오히려 악화된다** (fail 1 → fail 2).
검증: `cd server && env -u NODE_ENV npx tsx --test src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts` 가 4/4.

**S4 클라이언트는 P2 핀 18개 중 6개를 건드린다** → `--regenerate-green` 재발행 필수. **P3 는 `06` 이 2개라 한 것과 달리 11개 파일**(그중 5개가 S4 대상). ⚠️ **워킹트리가 이미 P2 를 dirty 로 만들어 S4 착수 전부터 red** — 재고정 전 워킹트리 정리가 선행.

### 5.2 신뢰할 수 없는 green — 이 세션에서 **6가지 경로**로 확인됨

| # | 사례 | 증상 |
|---|---|---|
| 1 | `WsRouterSplitHandshake.test.ts` | `fail 0 / todo 14` 로 **exit 0**, 실제로는 `✖` 에 14건 |
| 2 | `boundary-gate.test.mjs` | `spawnSync` 에 `env` 미지정 → `NODE_TEST_CONTEXT` 상속 → **0개 실행 후 exit 0**. 내부 84ms vs 직접 35,466ms |
| 3 | `--verify-existing` 플래그 | **파싱조차 안 된다**(`--fixture-only` 뿐). 동결 계약이 존재하지 않는 플래그를 가리킴 |
| 4 | ACK credit 단정 | 구현과 기대를 **같은 함수**에서 뽑음 |
| 5 | S2 수용 대조군 16개 | 건수만 보고 내용을 안 봄 — 4 KiB 초과를 잘라먹는 디코더가 전 스위트 통과 |
| 6 | `settingsDraftHelpers.test.ts:63-68` | union 에 없는 리터럴 비교 → **정적으로 항상 false** (TS2367) |

**규칙: exit code 를 단독 신호로 쓰지 말고 실행 건수·`✖` 목록·`todo` 카운트를 항상 대조하라.**

### 5.3 도구

- **`npx speckiwi` 는 로컬 2.2.3 을 실행해 전역 2.12.0 을 가린다.** `speckiwi` 를 **이름으로** 호출하라. 2.12.0 에는 `edit-ac`·`replace-acceptance-criteria`·`edit-requirement`·`repair` 가 **있다** — "AC 편집 불가"·"repair 없음" 은 **거짓**
- **`mcp__speckiwi__add_trace_link` 는 `notes` 를 조용히 버린다**(스키마엔 있고 핸들러가 안 넘김). CLI 는 정상. **dryRun 도 없으니 `git diff` 가 유일한 관측 수단**
- **Git Bash MSYS 경로 변환** — `/api/...` 같은 인자가 `C:/Program Files/Git/api/...` 로 바뀐다. `MSYS_NO_PATHCONV=1`
- **`set_active_target` 만으로 `validate` 기준선이 바뀐다** — `SRS-W023` 이 active target 스코프. 전환 후 **재기준선** + `summarize_target` 보완 게이트 필수

### 5.4 문서 인용

**`06` 의 `wsSendPolicy.ts` 줄번호 인용 다수가 아직 틀렸다.** S1 이 `payloadFields` 3줄을 `FairTerminalDeliveryInput` **안쪽**에 넣어 **앞은 +5 / 뒤는 +8** 이다. **"전부 +8" 일괄 치환은 틀린다.** 특히 `FairTerminalDelivery.encodedBytes` 를 `:510` 으로 적은 인용이 여럿인데 실제는 **`:518`**. §4.2 와 부록은 정정됐고 나머지는 폭별 표로 등재만 돼 있다 — **S5-a0 착수 전 일괄 정정 대상**.

---

## 6. 회귀 기준선 (필수 참조)

`docs/research/binary-comms/baseline/00-baseline-summary.md`

| 갈래 | tests | fail |
|---|---:|---:|
| 백엔드 | 1,305 | **52** |
| 프론트 | 612 | 7 |
| wave3 | 103 | 2 (+증거 4/4) |
| E2E | 155 | 84 |

⚠️ **이 기준선은 HEAD 가 아니라 워킹트리 상태다.** 미커밋 작업이 대량(추적 수정 ~121)이고 실패의 압도적 다수가 그 때문이다. **같은 워킹트리에서만** 비교 기준으로 쓸 수 있다.

- **`SessionManager.ts:4391`(`nextTerminalAuthoritySourceSeq` undefined) 단일 지점이 최소 24건**을 쥐고 있다. 이 시그니처가 보이면 **우리 탓이 아니다**
- **E2E 84건 중 제품 로직을 말해주는 것은 25건뿐** — 39건이 precondition 에서 죽었다(고아 워크스페이스 + 워커 16 vs `maxWorkspaces` 10)
- 회귀 비교는 **숫자가 아니라 테스트명 집합**으로 하라. S1·S2 둘 다 A-1~A-21 과 완전 일치를 확인했다

### 검증 커맨드 (전부 `env -u NODE_ENV`)

```bash
cd server && npx tsx --test src/ws/binaryFrameCodec.test.ts        # 78/78
cd server && npx tsx --test src/ws/wsTransportSidecar.test.ts      # 13/13
cd server && npx tsx src/test-runner.ts                            # 21 fail = 기준선
cd server && npx tsc --noEmit -p tsconfig.json                     # exit 0
cd server && npx tsx --test src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts  # 4/4
cd frontend && npm run typecheck:tests                             # exit 0
```

⚠️ 신규 `*.test.ts` 는 **`test-runner.ts` 가 디스커버리하지 않는다.**

---

## 7. 환경

- **2222 에 프로덕션 서버가 살아 있을 수 있다** (Playwright 가 `start.bat` 으로 띄운 것, 회수 안 됨). **고아 워크스페이스 7개**가 남아 있고 `reuseExistingServer:true` 라 다음 E2E 가 그대로 물려받는다
- **`kill` / `taskkill` 절대 금지**
- 셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production` 이 설정돼 있고 **다른 런타임 루트**를 가리킨다. `env -u` 로 제거하고 실행하라
- **`git commit` 시 `git commit -- <경로>`** 로 범위를 못박아라 (공유 워크트리, 미커밋 1,200+ 파일)
- 커밋 메시지에 **어떤 시그니처도 넣지 마라** (CLAUDE.md §6)

---

## 8. 미해결 (사용자 결정 대기)

1. **`@xterm/headless` 를 frontend devDependency 로 추가**할지 — C1(xterm 이중 디코더 혼류 특성화)에 필요. 메커니즘은 번들에서 확인됐으나 **현행 결함 여부는 미확인**
2. **GitHub 이슈 9건 갱신** (Q5 승인됨, 미실행)
3. **P2 재발행** — 워킹트리 커밋 후로 보류 중
4. **`IR-BGSTAB-001` 상태** — `planned` 이고 Verification Evidence 가 비어 있다. S1·S2 가 코드와 테스트를 냈으므로 `in_progress` 전이 + 증거 첨부가 자연스럽다
