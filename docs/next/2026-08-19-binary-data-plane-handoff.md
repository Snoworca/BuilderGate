# 바이너리 WebSocket 데이터 평면 전환 — 세션 인계

| 항목 | 값 |
|---|---|
| 작성 | 2026-08-19 · **4차 세션(2026-08-21)까지 반영** |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| HEAD | `dfca40c` — **이 세션의 작업은 전부 미커밋** |
| 진행 | **S4-C0 ~ C4 완료 + `0x04` 구현·검증 완료 + 문서 부채 청산.** 다음은 **C5** — 착수 실측(§7.1)부터 |
| 계획 SSOT | `docs/research/binary-comms/06-work-plan.md` |
| 프레임 사양 SSOT | `docs/research/binary-comms/01-frame-format-and-negotiation.md` |

---

## 0. 다음 세션 — 여기부터 읽어라

### 0.1 지금 위치

S4 의 클라이언트 배선 6단계 중 **C0~C4 와 C5 착수 전 필수 항목 3건이 끝났고, `0x01`·`0x05`·`0x04` 차단이 전부 해소됐다.** `0x04` 프롤로그는 **설계에서 그치지 않고 구현·손계산 벡터·핀 갱신까지 완료**했다(§8 항목 5). **C5(수신 분기 + 프론트 코덱)에 바로 진입할 수 있다.**

**4차 세션이 추가로 닫은 것**: §8 항목 **11**(앵커 인용 정정, 49개 기계 대조 통과) · §8 항목 **8 의 내용 오류**(3건이 아니라 **§1.4 표 5행 전부** — 재파싱 지점의 정답은 **0곳**) · **`0x04` 독립 검증 REJECT 전건 수정** · **C5 착수 실측**(§7.1) · **C5-a 프론트 코덱 구현**. 남은 문서 부채는 `06`·`02`·`05` 의 미등록 stale 앵커(S5-a0 몫)와 `07:69` 미해결 1건뿐이다.

**🔵 지금 남은 것은 C5 의 나머지(배선)와 C6 다.** 프론트 코덱은 끝났다 — `frontend/src/utils/binaryFrameCodec.ts`(디코드 전용, 서버 코덱 미import) + `frontend/tests/unit/binaryFrameCodec.test.ts` **66건**. 골든 벡터 11개와 fault 44개를 전건 소비하고, layout 자가검증을 프론트에서 다시 수행하며, 뮤턴트 **28/28 KILLED**(생존 0, 복원 sha256 동일). 프론트 전수 **66파일 / 745 tests / fail 6 = 기준선 테스트명 집합 일치**, `tsc -p tsconfig.app.json`·`typecheck:tests` 둘 다 exit 0.

| 검증 축 | 현재 |
|---|---|
| `npx tsc -p tsconfig.app.json --noEmit` | **exit 0** |
| `npm run typecheck:tests` | **exit 0** |
| 프론트 단위 전수 (65파일) | **tests 671 / pass 665 / fail 6** |
| 실패 내역 | **기준선 6건과 테스트명 집합 일치** — 회귀 0. EOL 2건은 해소됨 |
| S4 신규 테스트 | **79건** (C1 8 · C2 8 · C3 12 · C4 16 · previewText 14 · byte-seam 5 · 앵커 단일매치 1 · 그 외 15) |
| P5 스케줄러 벤치 | C4 트리로 재고정 완료, **3/3 green** |

⚠️ 전수 수치가 2차 세션 기록(`pass 487`)과 크게 다른 것은 **작업이 늘어서가 아니라 그때 요약줄 파싱이 틀렸기 때문**이다(멀티바이트 `ℹ`, §6 참조). 신뢰할 수치는 **fail 6 과 그 테스트명 집합**이다.

#### 검증 상태 — 무엇이 독립 검증을 받았고 무엇이 안 받았는가

CLAUDE.md §5 는 모든 검증을 서브에이전트에 위임할 것을 요구한다. 3~4차 세션 산출물의 현재 상태:

| 산출물 | 검증 | 결과 |
|---|---|---|
| EOL 앵커 수정 | ✅ 독립 서브에이전트 | **ACCEPT WITH FINDINGS** — MEDIUM 1건(끝 앵커가 죽어도 하류 3건이 통과)은 경계 단언 추가로 종결, LOW 1건(`\s*` 로 들여쓰기 핀 해제)은 단일매치 핀 테스트로 종결. 나머지 LOW 2건은 **기존 결함**이지 이 수정이 도입한 것이 아님 |
| `previewText` 지연 평가 + byte-seam 특성화 | ✅ 독립 서브에이전트 | **ACCEPT WITH FINDINGS** — HIGH 1건은 **실제로 통과하는 잘못된 구현이 제시됐고**, MEDIUM 2건과 함께 전부 수정·재검증 완료. 아래 참조 |
| `0x01` 처분 | ✅ 독립 서브에이전트 | **SOUND WITH CAVEATS** — 공격 전부 통과. 단 coalescing 방증은 single-flight 펌프 때문에 사실상 도달 불가이므로, **무조건 발화하는 근거**(`WsRouter.createFairDeliveryWireMessage:5820-5845` 등이 세 필드 없는 closed list 로 재구성)로 교체할 것 |
| `0x05` 상속안 | ⚠️ 독립 검증 → **뒤집힘 → 재설계로 해소** | 1차 기록은 **CRITICAL 1 · HIGH 3** 으로 뒤집혔다(F1·F2·F3 전부 틀렸거나 오도). 그 CRITICAL(=`0x04` 에 자리 없음)을 **`0x04` 프롤로그 재설계로 닫았다**(§4). 재설계안 자체의 오류 1건(§3.3 상속 목록 주장)은 내가 직접 확인해 정정 |
| `0x04` 프롤로그 설계·구현 | ✅ **독립 서브에이전트 (4차)** → **REJECT** → **전건 수정 완료** | 검증자가 뮤턴트 20개를 돌려 **6개 생존**을 냈고 판정은 **REJECT**. CRITICAL 1(SSOT 모순) · HIGH 3 · MEDIUM 4 · LOW 3. **CRITICAL·HIGH 전건 + MEDIUM 3건을 수정**했고, 그 과정에서 **검증자도 놓친 결함(골든 벡터 2개가 flags2 presence 규칙 위반)**을 추가로 잡았다. 재뮤테이션 **9/9 KILLED**. 아래 §8 항목 5 |
| `06` 줄번호 정정 23줄 | ✅ 내가 직접 대조 | 동결 구역 hunk 0, 실제 소스와 전건 일치 |
| `IR-BGSTAB-001` 전이 | ✅ 실행으로 확인 | 78/78 · 13/13 을 직접 돌린 뒤 증거 첨부 |
| **앵커 인용 정정 28건** (4차) | 🔄 독립 검증 발주됨 | 기계 대조 **46/46 통과**(각 인용줄이 실제 그 내용을 담는지 스크립트로 확인). 검증자에게는 diff 와 원본만 주고 내 판단은 전달하지 않았다. §8 항목 11 |
| **`06` 내용 오류 정정** (4차) | 🔄 독립 검증 발주됨 | 3차 기록(§1.4 표 1행 오류)이 **과소평가**였음을 실측으로 확인 — **5행 전부** 오류이고 정답은 "0곳". 동결 구역 hunk 0. §8 항목 8 |

### 0.2 권장 착수 순서

**(1) ~~EOL 테스트 수정~~ — 완료.** §8 항목 7 참조.

**(2) ✅ `0x05`/`0x04` — 해소됐다. 이번엔 독립 검증까지 통과했다 (4차 세션).**
`0x04` 프롤로그 200 B 구현이 **REJECT 를 받고 전건 수정**됐다 — §8 항목 5 의 표가 검증자 지적 10건과 처리 결과를 담는다. 코덱 **89/89**, 뮤턴트 **10/10 KILLED**. SSOT 모순(CRITICAL)은 `01 §1.8` **개정조항 R1** 로 닫았다.

⚠️ **이 항목은 3차 세션에서 한 번 "✅ 해소" 로 기록됐다가 독립 검증에서 뒤집혔다.** 근거 3가지(F1·F2·F3)가 전부 틀렸거나 오도했고, 특히 **F3("클라이언트가 이미 상속한다")은 거짓**이다 — 클라이언트는 상속 전에 **비교**한다. §4 에 원 주장과 실측을 나란히 남겼으니 **같은 논증을 다시 세우지 말 것.**

🔴 **그리고 4차에서도 "해소" 기록이 한 번 더 뒤집혔다.** 3차가 84/84 로 green 이라 기록한 그 구현에 **생존 뮤턴트가 6개** 있었고, 골든 벡터 2개는 **스스로 사양을 위반**하고 있었다(§5.2 26). ⇒ **이 문서의 ✅ 는 "검증받았다" 는 뜻이지 "옳다" 는 뜻이 아니다.** 어느 항목이든 손대기 전에 뮤턴트를 한 번 걸어 보라.

**(2') ✅ `0x01` OUTPUT 은 해소됐다.** 모든 프레임에 `responderLeaseId`·`sourceSeq`·`streamEpoch` 를 싣는데(핫패스, 호출부 5곳, 벡터 blast radius 약 10배) **셋 다 와이어에서 제거 가능**하다 — 클라이언트 소비자 0, 서버는 인코딩 이전 단계에서만 읽는다. 독립 검증도 통과했다 (§8 항목 10).

**(3) 🔵 C5 → C6 — 여기가 다음 작업이다. 선행 부채는 남아 있지 않다.**
C5 착수 전 필수 3건(EOL · `previewText` 지연 · 무보호 시임)은 **전부 처리됐고**(§3), 4차 세션이 문서 부채(§8 항목 8·11)와 `0x04` 검증(§8 항목 5)까지 닫았다.

C5 안에서 `0x05` 에 의존하지 **않는** 부분은 수신 분기(`binaryType='arraybuffer'` 를 **`onmessage` 할당 전**에, text/binary 프레임 구분)이고, 의존하는 부분은 프론트 코덱의 `0x05` 프롤로그다. **분리 착수는 권하지 않는다** — 소비자 없는 `binaryType` 변경은 관측 불가라 §2(Simplicity First)의 speculative code 가 된다.

🔴 **착수 전 반드시: `08` 이 지정한 삽입 지점 앵커를 재측정하라.** `08` 은 `WebSocketContext.tsx:687`·`:1007`·`:1009`·`:1201`·`:1206` 을 지목하는데, **같은 문서의 코덱 인용 11건이 오늘 +200 줄까지 어긋나 있었다**(§8 항목 11). 없는 자리에 코드를 넣게 된다. 4차 세션이 이 실측을 발주했으나 **결과를 받지 못한 채 끝났다** — 조사 에이전트 3개가 유휴로 들어가고도 보고 텍스트를 반환하지 않았다. ⇒ **다음 세션의 첫 작업은 이 실측이다.** 필요한 항목 목록은 §7 하단.

미루기를 권한 것: **P2 재발행**(§8 항목 3 — 워킹트리 정리가 선행), **C6 단독 선행**(candidate arm 이 없어 JSON arm 만 재게 된다), **`06` 미등록 인용 정정**(§8 항목 8 — S5-a0 몫), **`07` 본문의 stale `160` 9곳**(동결 부속서라 의도적으로 미편집, R1 이 고지).

### 0.3 즉시 물릴 함정 4가지

1. **`terminalOutputScheduler.ts` 를 건드리면 P5 가 red 가 된다.** 문서가 지정한 env var 로는 재고정되지 않는다 — **손편집 3곳**이 정답이다(§3 "S4-C0 정정"). C2·C3·C4 에서 각각 한 번씩 돌았다.
2. **소스 텍스트 계약 테스트가 식별자·시그니처를 핀한다.** 이름 하나만 바꿔도 동작 변화 없이 red 가 되고, 반대로 **음성 단언은 조용히 공허해진다**(§3 "소스 텍스트 계약 테스트").
3. **red 인 테스트는 그 뒤 어서션을 전부 가린다.** 이미 실패 중인 테스트 파일을 건드리면 실행 결과만으로는 자기가 심은 결함을 볼 수 없다 — 정규식을 소스에 직접 실행해 확인할 것.
4. 🔴 **커밋하지 마라.** 이 워킹트리는 공유 상태이고, 당신이 만질 파일 다수가 **남의 미커밋 작업 수천 줄**을 함께 담고 있다. `git commit -- <경로>` 로도 막히지 않는다 — 상세와 실측 수치는 §8 항목 9.

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
- 프롤로그 — ⚠️ **이 줄은 "확정 사양" 이 아니었다 (3차 세션 정정).** 7종 크기(`0x01` 24B / `0x02` 24B / `0x03` 24B / `0x04` 160B / `0x05` 12B / `0x06` 88B / `0x07` 12B)는 **적용 후 목표값**이다. **구현은 3종뿐** — `prologueBytes()`(`binaryFrameCodec.ts:108-118`)가 `0x01`→24 / `0x02`→24 / `0x05`→12 를 주고 **나머지 넷은 0**("v1 스키마 없음")을 준다. `binaryFrameCodec.test.ts:747` 이 `[0x03,0x04,0x06,0x07] → 0` 을 **핀한다**. `01 §1.8` 도 세 개만 절로 정의했고(`0x01`·`0x02`·`0x05`), 나머지 넷은 `07`(증분 부속서, 아직 `01` 로 병합 안 됨)에 있다. 따라서 `0x04`/`0x06`/`0x07` 은 **오늘 인코딩 자체가 불가**하고 opaque 로 디코드된다
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
| **S4-0b** | 열린 항목 필수 3건 판정 (§4 참조) | ✅ 3/3 |
| **S4-C0** | P5 재고정 — ⚠️ **계획서 처방이 틀렸다**, 아래 참조 | ✅ green |
| **S4-C1** | xterm 혼류 특성화 Arm A 5/5 · Arm C 3/3 (Arm B 미실행) | ✅ |
| **S4-C2** | `enqueueBytes` 신설 6/6 + 스케줄러 회귀 60/60 + P5 재고정 | ✅ |
| **S4-C3** | restore 게이트 + 바이트 회계 + 하류 시그니처 (28건) + 회귀 95/95 + P5 재고정 | ✅ |
| **S4-C4** | 연접성 공유 함수 추출 + IR 도입 + 배선 (15건) + P5 재고정 | ✅ |
| **C5 선행 (a)** | EOL needle 3곳 → EOL 무관 헬퍼. 전수 fail 8→6 (= 기준선) | ✅ |
| **C5 선행 (b)** | `previewText` 지연 평가 — 콜리 2곳 파라미터 확대 (8건) | ✅ |
| **C5 선행 (c)** | 무보호 restore 시임 특성화 — **사실 정정 포함** (4건) | ✅ |
| **S4-C5a** | **프론트 코덱 (디코드 전용) 신설** — `frontend/src/utils/binaryFrameCodec.ts` + 테스트 66건. 골든 벡터 11개 + fault 44개 전건 소비, 뮤턴트 **28/28 KILLED**, 서버 코덱과 **교차 차분 9,074건 발산 0** | ✅ |
| **S4-C5e** | **`fromBinaryOutputFrame` 어댑터** — `terminalOutputDelivery.ts` 에 추가 + 테스트 15건. 뮤턴트 **14/15 KILLED**(생존 1은 등가 확인). ⚠️ **`01:544` 의 규칙이 틀렸음을 발견해 개정 R2 로 닫았다** — 아래 | ✅ |

**다음은 S4-C5** — 단 위 §4 항목 3(`0x05` 재설계)이 **하드 선행조건**이다. C5 비의존 작업으로는 C6 마이크로벤치 일부와 P2 재발행 결정이 남아 있다.

### S4-C4 실행 메모

두 부분으로 나눴다. 전반부(`assertContiguousSegments` 추출 + `terminalOutputDelivery.ts` 신설)는 **호출부를 하나도 바꾸지 않는 순수 추가**라 프로덕션 동작 변화가 0이고, 후반부만 배선이다.

**타입 검사가 또 작업 목록을 만들었다.** restore 게이트 → `writeOutput` → `submitOutput`/`writeRecoveryTailAndWait` → `bufferOutputWhileRestorePending` → `TerminalRestoreHeldOutputEntry.data` 순으로 한 번에 하나씩 나왔다. §1.4 의 #1·#2·#4 는 C3 때 타입 검사가 요구하지 않아 미뤘던 것인데 여기서 자연히 걸려 나왔다.

**세 갈래 fallback 이 서로 달랐다** — R1 `{data, screenSeq, chunkId}` / R2 `{+authorityEpoch, +authorityRevision}` / R5 `{chunkId 없음}`. 하나의 `delivery.chunks` 로 합치기 전에 소비처(`advanceTerminalCompatibilityPostAckConvergence` · `classifyVisibleResyncOutputBatch` · `restoreAdapter.handle` · `submitOutput`)를 전수 확인했고, 추가되는 필드는 어느 곳도 읽지 않는다. 그리고 IR 은 부재 키를 **생략**하는데 기존 fallback 은 `undefined` 로 **설정**했다 — `visibleOutputRecovery.ts` 에 `in`·`Object.keys`·`hasOwnProperty` 가 **0건**이라 동치다.

⚠️ **`BoundTerminalRestoreAdapter.handle` 은 `event: Record<string, unknown> & {type: string}` 을 받는다**(`visibleOutputRecovery.ts:873-875`). **R2 경로는 타입 보호가 전혀 없다** — `06` §4.3 의 "필수 필드로 만들어 컴파일 에러로 드러나게" 메커니즘이 여기만 통하지 않는다.

**정정 (3차 세션 실측)**: 이 절은 원래 *"C5 가 이 경로로 바이트를 흘리면 아무 신호 없이 **들어간다**"* 고 적었는데 **틀렸다. 조용히 버려진다.** `acceptOutput`(`visibleOutputRecovery.ts:1427-1428`)이 `typeof chunk.data !== 'string'` 을 이미 검사해 `ignored` 로 반환한다. 4건으로 특성화했다(`tests/unit/visibleOutputRecoveryByteSeam.test.ts`, 4/4):

| 관측 | 값 |
|---|---|
| `Uint8Array` chunk | `ignored:true` · heldChunks **0** · heldOutputBytes **0** · scheduled write **0** · outcome **0** |
| 같은 입력의 문자열 대조군 | `ignored:false` · heldChunks 1 · heldOutputBytes 5 |
| 손상 여부 | `"104,101,108,108,111"`(19B)로 **재인코딩되지 않는다** — `:1427` 가드가 `:1444` 앞이라 도달 불가 |
| 버려진 chunkId | **소진되지 않는다** — 검증이 dedup(`:1432`) 앞이라 같은 id 로 문자열 재시도가 admit 된다 |

즉 C5 의 실패 양상은 손상이 아니라 **live 출력 무성 유실**이다. 위 테스트가 그 지점을 고정하므로, C5 가 바이트를 admit 하도록 바꾸면 이 테스트를 **의식적으로** 고쳐야 한다.

**`assertContiguousSegments` 는 기대값을 픽스처 리터럴로 두고 두 구현이 각각 대조**한다(18케이스, 수용 5 / 거부 13). 서로를 대조하면 둘 다 틀려도 일치하므로 그렇게 하지 않았다. 수용·거부가 실제로 양쪽 다 존재하는지 세는 가드도 넣었다.

### ⚠️ 소스 텍스트 계약 테스트 — 앵커가 서명에 묶여 있다

`onOutput` 시그니처를 바꾸자 계약 테스트 3건이 red 가 됐다. 전부 앵커 staleness 였고 처리했지만, 이 계열의 성질을 기록해 둔다.

- `terminalViewRecoveryContract.test.ts` 는 `submitOutput: (data: string, …)` 를 앵커로 쓰면서 **`notEqual(-1)` 가드가 없었다** → 앵커가 죽으면 `slice(-1, …)` 가 `''` 를 주고 `assert.match` 가 빈 문자열에 실패하며 **원인을 가리는 메시지**를 낸다. 가드를 추가했다.
- `terminalContainerRecoveryContract.test.ts` 의 한 건은 `slice(outputIndex, +2600)` 창을 쓰는데, IR 도입으로 값 전달 지점이 뒤로 밀려 **창 밖으로 나갔다**. 9000 으로 넓히고 두 경로(fallback·per-chunk)를 모두 단언하도록 강화했다. 음성 단언도 `screenSeq:\s*[\w.]*screenSeq\s*\?\?` 로 바꿔 **수신자 이름이 바뀌어도 반증 가능**하게 유지했다 — 옛 이름을 겨눈 채 두면 그 단언은 영원히 참이 된다.

### ✅ red 2건 — C4 탓이 아니었음 (근거, 3차 세션에 해소)

`terminalContainerRecoveryContract.test.ts` 의 다음 2건이 남아 있다:
`TerminalContainer keeps restore-buffer failure non-ACKable …`(`:1104`) · `TerminalContainer defers a rollback-era authoritative snapshot …`(`:1142`)

둘 다 **같은 검색 문자열**에서 -1 이 난다:

```js
'if (\n                terminalRef.current?.isCheckpointAuthorityActive() === true'
```

| 사실 | 근거 |
|---|---|
| 그 `if (` 형태는 파일에 **실재한다** | `TerminalContainer.tsx:2706-2707` |
| 그런데 파일은 **전부 CRLF** (3717줄, LF-only **0줄**) 이고 리터럴은 `\n` 이다 → 매치 불가 | 바이트 계수 |
| **HEAD 에는 이 구문이 0건** — 이 영역 전체가 남의 미커밋 작업 | `git show HEAD:… \| grep` |
| C4 의 `TerminalContainer.tsx` 편집은 import 2줄과 **line 3191+** 뿐 | 앵커는 2425·2706 |
| 편집한 줄도 전부 CRLF — 줄바꿈을 바꾸지 않았다 | 핸들러 내부 CRLF 6 / LF 0 |

즉 이 리터럴은 **이 CRLF 파일에서 애초에 매치된 적이 없다.**

**독립 검증(서브에이전트)이 위 판정을 확인했고, EOL 정규화 사본에서 해당 어서션 체인을 실행해 결정적 증거를 냈다.** 추가로 EOL 이 리팩터 탓이 아니라는 근거 하나를 더 세웠다: **이 도구는 LF 로 쓴다** — 같은 세션이 만진 `terminalOutputDelivery.ts`(신규)·`visibleOutputRecovery.ts`·`WebSocketContext.tsx`·`terminalContainerRecoveryContract.test.ts` 는 **전부 LF 100%** 인데 `TerminalContainer.tsx` 만 CRLF 100% 다. 통째로 다시 썼다면 나머지처럼 LF 가 됐을 것이므로, 이는 *이미 CRLF 인 파일에 in-place 편집이 파일 관례를 상속한* 서명이다.

**적용한 수정 (3차 세션)**: needle 이 3곳(`:1096`·`:1117`·`:1155`)에 동일하게 있었고, EOL 무관 헬퍼 하나로 통합했다.

```ts
const CHECKPOINT_AUTHORITY_ACTIVE_GUARD =
  /if \(\r?\n\s*terminalRef\.current\?\.isCheckpointAuthorityActive\(\) === true/u;
function indexOfCheckpointAuthorityGuard(haystack: string, from = 0): number { … }
```

**일괄 정규화(`source.replace(/\r\n/g,'\n')`)는 택하지 않았다** — 그러면 문자열이 짧아져 이 파일의 다른 고정폭 `slice(start, start+N)` 창이 함께 넓어지고, 무관한 테스트(특히 음성 단언)의 결과가 바뀔 수 있다. 착수 전 이 파일에 `\r` 의존 어서션이 **0건**임을 확인했고, 새 패턴이 `TerminalContainer.tsx` 에서 **단일 지점(line 2706 @112547)** 에만 매치함을 실측했다(느슨한 후보 3종 모두 1히트).

⚠️ **경계 대조군에서 나온 사실**: `checkpointTakeoverEnd` 가 -1 이었어도 하류 어서션은 **그대로 통과**한다(청크가 920자 대신 2944자가 될 뿐). 즉 이 테스트에서 스코핑을 지키는 것은 **`notEqual(-1)` 가드 단 하나**다. 가드가 없던 앵커 1곳(`:1117`)에 이번에 추가했다.

### 🔴 검증이 잡아낸 것 — 리팩터가 심은 잠복 실패 (수정 완료)

**`terminalContainerRecoveryContract.test.ts:1136` 의 정규식이 `replayToken: output\.replayToken` 을 요구하는데, 리팩터가 바인딩을 `output` → `delivery` 로 바꿔 소스에 `output.replayToken` 이 0회가 됐다.** 같은 파일의 `:788`/`:796`/`:805` 는 새 시그니처로 갱신했으면서 `:1136` 만 놓쳤다.

**이 실패는 보이지 않았다** — 같은 테스트의 앞선 `:1104`(위 EOL 문제)가 먼저 throw 해서 가려져 있었고, EOL 을 고치는 순간 드러났을 것이다. `delivery\.replayToken` 으로 정정했고, 여전히 가려져 있으므로 정규식을 소스에 직접 실행해 확인했다: 신규 형태 `true` / 옛 형태 `false`.

> **교훈**: red 인 테스트는 그 뒤의 어서션을 전부 가린다. 이미 실패 중인 테스트 파일에 손을 대면, 실행 결과만으로는 자기가 심은 결함을 볼 수 없다.

### ✅ `previewText()` 지연 평가 — 해소됨 (3차 세션)

IR 의 `previewText` 는 "필요할 때만 디코드"가 존재 이유인데 호출부 두 곳이 모두 무조건 평가하고 있었다. **바이너리 어댑터가 붙는 순간 모든 live 프레임마다 전체 UTF-8 디코드가 강제되어 이 IR 의 목적이 무력화**되는 상태였다.

**호출부 게이팅 대신 콜리로 지연을 내렸다.** 원래 계획은 두 호출부를 `hiddenOutputPolicy === 'debug-tail'` · `isTerminalDebugCaptureEnabled(sessionId)` 로 게이트하는 것이었으나, 그러면 **같은 판정 규칙이 콜리와 호출부 두 곳에 살게 된다**(§10.2 "같은 책임을 두 곳이 나눠 갖지 않는다"). 게다가 그 게이트는 정확하지도 않다 — `resolveHiddenOutput` 이 `data` 를 실제로 읽는 조건은 `debug-tail` **이면서 `hiddenOutputTailBytes > 0`** 이고, visible write·`write-hidden` 은 그 앞에서 반환한다.

대신 두 콜리의 파라미터를 **넓혔다**(`string` → `string | (() => string)`). 넓히기라 기존 호출부(`recordTerminalDebugEvent` 232곳, `resolveHiddenOutput` 13곳)에 변경이 0 이다.

| 파일 | 변경 |
|---|---|
| `terminalHiddenOutput.ts` | `data` 유니온 확대. `appendDebugTail` 이 `next` 를 받아 **`maxBytes <= 0` 가드 뒤에서** 해소 — 판정이 한 곳뿐 |
| `terminalDebugCapture.ts` | `rawPreview` 유니온 확대. `isEnabled` 조기반환(`:403`) **뒤에서** 해소 |
| `TerminalContainer.tsx` | `delivery.previewText()` → `delivery.previewText` (2곳) |

검증 9건(`tests/unit/terminalOutputPreviewLaziness.test.ts`, 9/9). 음성 4건은 **구 코드에서도 통과**하므로(구 코드는 `data` 가 string 타입이라 함수가 애초에 호출되지 않는다) 소비하는 경계 대조군을 함께 넣었다 — 검증자가 구 코드 미러에서 실행해 **8건 중 5건이 구 코드에서도 통과**하고 나머지 3건만 진짜 판별력이 있음을 실측했다.

### 🔴 검증이 잡아낸 것 — **통과하는 잘못된 구현이 실재했다** (수정 완료)

`terminalDebugCapture.ts:409` 를 한 글자 바꾼 뮤턴트:

```ts
const preview = typeof rawPreview === 'function' ? rawPreview() : undefined;   // ← Break A
```

이것은 **string 프리뷰를 전부 조용히 버린다**(src 의 ~24개 호출부: `debugInput.preview` 16 · `*.debugTail` 3 · `snapshot.data` 3 · `repair.ansiPatch` 2 등). 그런데 **원래 테스트 8건을 전부 통과**했고, 프리뷰 관련 단위 파일 5개가 전부 기준선과 비트 동일했다. 잡는 것은 Playwright E2E 뿐이라 node:test 게이트 밖이었다.

**원인은 대조군 비대칭**이었다 — `resolveHiddenOutput` 에는 string 대조군을 넣었는데(`data: 'literal-text'`) `recordTerminalDebugEvent` 에는 안 넣었다. 저장소 전체에서 기록된 `.preview` 를 단정하는 곳이 2군데뿐이고 하나는 `undefined` 단정, 다른 하나는 함수형 전용이었다.

**대조군 1건을 추가하고 뮤턴트로 검증했다**: Break A 적용 시 **pass 8 / fail 1**, 죽인 것이 정확히 그 신규 테스트. 원본은 해시 일치로 복원 확인.

> **교훈**: 유니온으로 넓힌 파라미터는 **양쪽 갈래에 각각 대조군이 필요하다.** 새 갈래(함수)만 테스트하면 옛 갈래(string)가 조용히 죽는 구현이 통과한다.

### 🔴 2라운드에서 **또 하나** 살아남았다 — 기본값 경로 (수정 완료)

검증자가 첫 수정 후 재공격해 두 번째 생존 뮤턴트를 냈다. `terminalHiddenOutput.ts:53` 뒤에 삽입:

```ts
const eagerData = input.hiddenOutputPolicy === undefined
  ? (typeof input.data === 'function' ? input.data() : input.data)   // ← 즉시 디코드 후 버림
  : input.data;
```

**이것이 이 변경이 막으려던 바로 그 결함**(바이트 어댑터가 프레임을 디코드해 놓고 결과를 버림)인데 **9/9 를 통과**했다. 이유: **음성 5건이 전부 `hiddenOutputPolicy` 를 명시로 넘긴다.** 함수 자신의 기본값(`?? 'snapshot-restore'`)을 타는 경로는 저장소 어디에서도 laziness 로 검사되지 않았다 — 정책을 생략하는 유일한 호출(`terminalHiddenOutput.test.ts:15`)은 `data` 를 아예 안 준다.

대조군 1건(`hiddenOutputPolicy` 생략)을 추가하고 다시 뮤턴트로 검증했다: **pass 9 / fail 1**, 죽인 것이 정확히 그 신규 테스트. 복원 해시 일치.

> **교훈 2**: **기본값은 그 자체로 검사되지 않은 분기다.** 모든 테스트가 옵션을 명시로 넘기면, 함수가 선언한 기본값 경로는 한 번도 실행되지 않는다. 옵셔널 파라미터를 가진 함수의 계약을 핀할 때는 **생략한 케이스를 반드시 하나 둘 것.**

### 🔴 3라운드 — 교차검증이 **또 5개**를 냈다 (전부 수정 완료)

두 번째 검증 에이전트를 교차로 붙였더니, 10건을 전부 통과하는 생존 뮤턴트가 **4개 더** 나왔고 byte-seam 쪽에서 1개가 더 나왔다. **같은 구멍의 서로 다른 축들**이다 — laziness 를 한 축(정책)에서만 검사하고 있었다.

| 뮤턴트 | 왜 통과했나 | 추가한 대조군 |
|---|---|---|
| **W** `write-hidden` + **visible** 일 때만 즉시 해소 | `write-hidden` 을 쓰는 유일한 테스트가 `isVisible:false` 로만 부른다. **그런데 `write-hidden` 정책에서 *보이는* 터미널은 예외가 아니라 통상 경로다** → 라이브 프레임마다 디코드. **가장 뜨거운 분기** | `isVisible` 2값 루프 |
| **S** `isVisible && state.skipped` 에서만 즉시 해소 | 모든 음성이 `createHiddenOutputState()`(=`skipped:false`)로만 시작 → **상태 축이 통째로 미커버**. hidden→visible 전환 후 recovery 가 상태를 지우기 전 구간이 여기다 | `skipped:true` + `isVisible:true` |
| **A** `appendDebugTail` **truncation 분기**에서 재해소 | 기존 positive 는 9바이트 payload / 64바이트 budget 이라 조기 반환으로 빠진다 → 트림 루프 미진입. tail 이 budget 을 넘긴 뒤부터 프레임당 2회 디코드 | budget 초과 payload |
| **N** `isEnabled` → `enabledSessions.has` (전역 캡처 무시) | 두 테스트 다 세션별 `enable(sessionId)` 만 쓴다 | 무인자 `store.enable()` |
| **X** `dispatchFrom` 의 spread 순서 반전 | `{...event, ...identity, ...scope}` → `{...identity, ...scope, ...event}` 로 뒤집으면 **호출자의 stale identity 가 이긴다.** 학술적이지 않다 — `TerminalContainer.tsx:1634-1635`·`:1649-1650`·`:2258-2259` 가 실제로 `repairToken`/`replayToken` 을 겹쳐 넘긴다 | stale `transactionId` 를 실어 보내고 **무시되는지** 단언 |

**5개 전부 뮤턴트로 검증했다** — 각각 정확히 의도한 신규 테스트 하나에만 잡혔고(`pass 13 / fail 1`, `pass 4 / fail 1`), 전 파일 해시 복원 확인.

**또 하나 — 소스 계약의 음성 단언이 alias 로 우회됐다.** `assert.doesNotMatch(containerSource, /delivery\.previewText\(\)/)` 는 다음을 못 잡는다:

```ts
const previewText = delivery.previewText;
const eagerText = previewText();   // 매 라이브 프레임 디코드
```

수신자에 묶지 않은 `/\.previewText\(\)/` 로 바꿨다. §5.2 항목 9(음성 단언이 rename 으로 공허해진다)와 같은 부류이며, **이번엔 rename 이 아니라 alias 였다.**

> **교훈 3**: laziness 처럼 "조건이 맞을 때만 하라" 는 계약은 **조건의 축이 여럿이다**(정책 × visibility × 시작 상태 × budget × 캡처 범위). 한 축만 파라미터화하면 나머지 축에 뮤턴트가 산다. 그리고 **검증자를 하나 더 붙이는 것이 가장 값싼 발견 수단이었다** — 첫 검증자가 놓친 4개를 두 번째가 냈다.

### 🔴 4라운드 — **CRITICAL 이 여기서 나왔다** (수정 완료)

같은 교차검증자에게 3라운드 수정본을 다시 공격하게 했더니 **또 4개**가 나왔고, 그중 하나가 이 세션 전체에서 가장 위험했다.

**U8ONLY (CRITICAL)** — `visibleOutputRecovery.ts:1427` 의 `typeof chunk.data !== 'string'` 를 **`chunk.data instanceof Uint8Array` 로 좁히면 byte-seam 5건이 전부 통과**한다. 즉 그 테스트들이 고정하던 것은 *"비-string 은 거부된다"* 가 아니라 **"Uint8Array 는 거부된다" 하나뿐**이었다.

| payload | baseline | U8ONLY |
|---|---|---|
| `Uint8Array` | 거부 | 거부 ← **옛 테스트가 고정한 유일한 shape** |
| `ArrayBuffer` | 거부 | **admit, 20 B** (`"[object ArrayBuffer]"`) |
| `DataView` | 거부 | **admit, 17 B** |
| `Int8Array` | 거부 | **admit, 7 B** |
| `number` / plain object | 거부 | **admit, 5 B** |

**왜 그럴듯한 편집인가 두 가지**:
1. **이 저장소 자신의 관용구가 이미 `instanceof Uint8Array` 다** — `terminalOutputScheduler.ts:427`. recovery 가드를 write-side 와 "정렬" 시키는 편집이 정확히 U8ONLY 다.
2. 🔴 **그리고 실제로 날것으로 도착할 shape 는 `Uint8Array` 가 아니다.** `binaryType='arraybuffer'` 의 `WebSocket.onmessage` 는 **`ArrayBuffer`** 를 준다. **테스트가 고정한 그 한 shape 가 하필 가장 오지 않을 shape 였다.**

payload shape **7종 루프**로 바꿨고 뮤턴트로 확인했다 — U8ONLY 가 **7건 중 6건에 잡힌다**(생존자는 `Uint8Array` 하나, 즉 옛 커버리지 그 자체).

**함께 닫은 3건** (전부 뮤턴트 검증, 각각 `pass 15 / fail 1`):
- **P** — `input.hiddenOutputTailBytes ?? 0` 을 `?? 64` 로 바꿔도 통과했다. `debug-tail` + **tailBytes 생략** 조합을 부르는 테스트가 없었다(기존은 명시적 `0` 이거나 policy 만 생략) → 생략 케이스 추가
- **S2** — 3라운드에 넣은 S 대조군 자체가 불완전했다. visible-after-skip 상태를 `snapshot-restore` 로만 봤는데, **`debug-tail` corner 에서는 정당한 1회 해소가 일어나므로 이중 해소가 그 뒤에 숨는다** → 같은 상태 + `debug-tail` 로 `calls()===1` 단언 추가
- **CACHE** — `recordTerminalDebugEvent` 에 세션별 메모이제이션을 넣으면 통과했다. capture 테스트가 **세션당 프레임 1개씩만** 기록했기 때문. *"더 게을러 보이면서 내용이 틀리는"* 방향이라 호출 수 단언으로는 안 잡힌다 → 같은 세션 두 번째 프레임 추가

**3라운드에 넣은 X 대조군도 정정했다** — `repairToken: 'repair-STALE'` 은 `output-arrived` 에서 **완전히 무력**하다. `acceptOutput` 이 `matchesCurrentTransaction` 을 옵션 없이 부르고 repairToken 비교는 `requireRepairToken` 일 때만 일어난다(`:1030`). 그 줄을 지워도 테스트가 통과했다 — **더 강해 보이면서 아무것도 단정하지 않는 필드**였다. 제거하고 실제로 load-bearing 한 `transactionId` 만 남겼다.

> **교훈 4**: **커버한 shape 가 실제로 도착할 shape 인지 따로 물어라.** 타입 가드를 테스트할 때 자연스럽게 떠오르는 대표값(`Uint8Array`)이 런타임에 실제로 오는 값(`ArrayBuffer`)과 다를 수 있고, 그러면 가드의 일반성이 통째로 미고정인 채 green 이 된다.
> **교훈 5**: **대조군 자체가 결함일 수 있다.** 3라운드에 추가한 5개 중 2개(S·X)가 4라운드에서 불완전·무력으로 판정됐다. 수정본은 원본과 같은 기준으로 다시 공격받아야 한다.

**함께 닫은 MEDIUM 2건**:
- **`previewText` 를 떼어 넘기면 `this` 의존 어댑터가 런타임에 깨진다** — `readonly previewText: () => string` 는 프로퍼티라 메서드 축약형(`previewText() { return this.decode(); }`)이 타입 검사를 통과하지만, 호출부가 참조를 분리하므로 `this` 를 잃는다. **컴파일 에러가 없다.** 게다가 소스 계약 테스트가 분리 형태를 *강제*한다. `terminalOutputDelivery.test.ts` 에 분리 호출·재호스팅 테스트를 넣어 **`this`-free 계약을 핀**했다
- **byte-seam 테스트가 이름만 걸고 실제 시임을 호출하지 않았다** — 헤더는 `BoundTerminalRestoreAdapter.handle` 을 지목하면서 본문은 `coordinator.dispatch` 를 직접 불렀다. `createTerminalContainerRestoreAdapter` 경유로 바꿔 **진짜 시임을 통과**시켰다(타입 경계를 넘는 캐스트라 런타임 shape 단언 3건 동반 — 메모리 `unchecked_private_field_casts_go_vacuous` 대응)

⚠️ **byte-seam 4건은 이 변경의 검증이 아니다** — 구 코드 미러에서도 4/4 통과한다. 바이너리 수신 경로에 대한 **전방 특성화**로만 셈할 것.

### C6 에서 측정할 것 — 핫패스 인코딩이 늘었다 (동작 회귀 아님)

1. **세그먼트 있는 live 배달에서 페이로드가 약 3회 인코딩된다**: `whole.byteLength`(어댑터) + `splitVisibleOutputSourceSegments` 내부 `new TextEncoder().encode(data)` + chunk 별 `getOutputUtf8ByteLength`. 그런데 **live·resync 경로는 chunk 별 byteLength 를 읽지 않는다** — post-ack 경로만 쓴다. 지연 계산이나 조건부 계산 여지가 있다.
2. **조기 return 앞으로 작업이 당겨졌다.** 어댑터가 호출 시점에 split + 전체 byteLength 를 무조건 계산하므로, 옛 코드가 split *전에* return 하던 경로(post-ack `stale-runtime-identity`·`replay-token-mismatch`, resync `stale-generation`, hidden `skip`)에서도 이제 비용을 지불한다.

`delivery.codec` 과 `delivery.hasSourceSegments` 는 현재 어느 소비자도 읽지 않는다 — 바이너리용 전방 API 다.

### S4-C0 정정 — 재고정 지렛대

**`BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 로는 재고정되지 않는다.** `03:667`·`06:200`·`06:261`·`06:1704`·`08` §6.2 가 모두 이것을 처방하지만 두 가지 이유로 불가능하다:

1. 그 env var 는 `terminalOutputSchedulerBenchmark.test.ts:372` 에서 읽힌다. digest 단정은 `:79`(호출부 `:166`)에서 throw 한다 → **`:372` 에 도달하지 못한다.**
2. 도달해도 그것이 쓰는 것은 **아티팩트 JSON** 뿐이다. `terminalNoRenderFixtureEvidence.ts` 를 쓰는 코드는 저장소에 **0건** — `Object.freeze` 된 TS 리터럴이고 20곳 이상에서 읽히지만 writer 가 없다.

**진짜 지렛대는 손편집 3곳이다** (같은 값이 세 벌, 서로 교차단정):

| 위치 | 역할 |
|---|---|
| `frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts` | export 상수 |
| `frontend/tests/benchmarks/terminalNoRenderFixture.ts` | 모듈 private 중복본 (`result.provenance.candidate` 에 박힌다) |
| `terminalOutputSchedulerBenchmark.test.ts` 의 `assert.deepEqual(…, {리터럴})` | 독립 출처 가드 |

`:190` 이 2번을 1번과, `:158` 이 3번을 대조하므로 조용히 갈라지지는 않지만 **하나만 고치면 red 가 옮겨갈 뿐**이다. 절차: `cat <스케줄러> | tr -d '\r' | sha256sum`(테스트의 정규화와 정확히 일치, 2회 검증) → 3곳 손편집 → `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 1회(아티팩트 재측정) → env 없이 1회(green + 아티팩트 무변경 단정). 약 3초/회.

⚠️ **핀이 가리키던 값은 저장소 어디에도 없었다.** S4 착수 시 `sha256:75716d66…` 는 HEAD 도 워킹트리도 아닌 **사라진 워크트리 스냅샷**이었다 — git 으로 복원 불가. 재고정이 유일한 경로였고, 피연산자가 설계상 워킹트리(`sourceRevision` 이 `-worktree` 로 끝난다)이므로 **재발한다.** 스케줄러를 만지는 단계마다(C3 포함) 이 사이클을 예산에 넣을 것.

⚠️ **red 인 P5 는 약한 신호가 아니라 신호 0 이다.** green 이 되어야 하류 단정 ~15개(`outputDigestParity`·인코더 호출수·아티팩트 digest 왕복)가 비로소 실행된다.

### S4-C1 실측 결과 — 순서 뒤집힘 **확정**

`08` §4.1 의 번들 독해가 맞았다. `HAN_HEAD(2B) → 'X' → HAN_TAIL(1B)` 이 화면에 **`'X한'`** 으로 나온다(`'한X'` 로 단정해 red 를 본 뒤 뒤집어 green). 경계 대조군 3개(통짜 write / 빈 문자열 / 아무것도 안 끼움)가 전부 통과 → **원인이 "끼어든 비어있지 않은 string write" 로 특정**된다. `03:359` 의 `[추정]` 은 이제 실측이다.

Arm C 는 private `findUtf8SliceEnd` 대신 **스케줄러의 `write` 시임**을 통해 잡았다 — 프로덕션 코드 변경 0 이고, "헬퍼가 옳다"가 아니라 "**라이브 경로가 옳다**"를 재므로 §4.2(a) 판정에 직결된다. 시드 고정 200케이스 전부 코드포인트 정렬 + 무손실, 공허성 가드 2개(순진한 분할이면 어긋났을 케이스가 실재했는가 / 스케줄러가 실제로 쪼갰는가) 포함.

⚠️ `08` §6.2 C1 의 *"`frontend/package.json` 은 어느 핀에도 없다(전수 확인)"* 는 **틀렸다.** P3 `authority-promotion-evidence.test.mjs:87`(`configPaths` → `hashesFor` `:713`)와 wave3 closure `fair-readmission-closure-v3.mjs:44`(`CONFIG_LOCK_PATHS`) 두 곳에 있다. 다만 둘 다 frozen 리터럴 대조가 아니라 실행 중 스냅샷 성격이고 P3 는 그보다 앞선 `validateSourceIdentity()` 에서 이미 실패 중이라 실질 추가 피해는 없었다.

### S4-C2 설계 메모

`enqueueBytes` 를 **본 구현**으로, `enqueue` 를 얇은 가드 래퍼로 뒤집었다 — 본문 약 90줄이 제자리에 남아 코드 이동·중복·재인덴트가 0 이다(`this` 의존이 empty 가드 한 줄뿐이라 성립).
가드는 `assertTextIngress(data: unknown, entryPoint)` 로 분리했다. 파라미터를 `string` 으로 두면 `instanceof` 가 컴파일 에러가 되고 `string | Uint8Array` 로 두면 **정적으로 좁혀져 검사가 사라진다** — §5.2 의 6번 함정과 같은 형태다.
계획서가 지시한 retry queue 확장(`:810` 등)은 C2 에서는 넣지 않았다. `createTerminalOutputIngressRetryQueue` 는 별도 factory 라 `enqueueBytes` 가 직접 닿지 않는다 — **C3 에서 `writeOutput` 을 넓히자 그것이 조인 지점으로 드러나 그때 처리했다.**

### S4-C3 실행 메모

**타입 검사가 작업 목록을 만들어 줬다.** restore 게이트를 `TerminalOutputWriteData` 로 넓히자 `tsc` 가 전파 지점을 한 번에 하나씩 내놨다: `TerminalView.tsx:2104` → (바이트 회계 수정 후) `:1600`·`:1605`·`:2104` → 전부 `writeOutput` 으로 수렴. `06` §4.3 이 의도한 메커니즘이 실제로 작동한다.

건드린 것:
- **restore 게이트** (`flushNextTerminalRestoreBufferedOutput`) — `typeof data !== 'string'` → `isTerminalOutputWriteData(data)`. ⚠️ **두 번째 절은 손대지 않았다** — `TerminalView` 가 항상 `getData` 를 주므로 이미 도달 불가이고, 건드리면 `getData` 없는 호출자의 계약이 바뀐다. 그 절을 고정하는 대조군 테스트를 넣었다
- **`getOutputUtf8ByteLength`** — 바이트는 `byteLength` 반환. 유니온을 `TerminalOutputWriteData` 로 import 하지 않고 인라인으로 쓴 것은 hot-path 모듈이 스케줄러에 의존하지 않게 하기 위함
- **retry queue** — `defer`/`attempt`/`attemptLegacy`/`PendingTerminalOutputIngressRetry` 를 넓히고 `:830` 의 `textEncoder.encode(entry.data).byteLength` 를 조건부로. 주입된 인코더를 존중해야 하므로 hotPath 헬퍼를 부르지 않고 인라인으로 처리
- **`enqueueBytesLegacy` 신설** — `attemptLegacy` 가 바이트를 못 나르면 **canary 롤백 중에 바이트 출력이 유실된다.** 이미 degrade 중인 순간이라 조용한 유실이 가장 나쁘다. `enqueue`/`enqueueBytes` 와 동일한 역전 패턴
- **`writeOutput` + `attempt`/`attemptLegacy` 디스패치** — `typeof data === 'string'` 3곳

**바이트 회계 테스트는 십진 표기 길이가 다른 값으로 짰다.** `Uint8Array([200,201])` 은 2바이트지만 `"200,201"` 은 7바이트다 — ASCII 범위 바이트로 짰다면 stringify 하는 구현도 통과했을 것이다. RED 가 실제로 `actual: 7 / expected: 2` 를 냈다.

⚠️ **테스트 두 개가 공허했다가 잡혔다** (기록):
1. `let ready = null` 을 콜백 안에서만 대입하면 TS 가 `never` 로 좁혀 **호출이 정적으로 죽는다**. `typecheck:tests` 가 잡았다 — 런타임에서는 통과하던 테스트다. 배열 수집으로 교체
2. 그 수정 후 드러난 사실: `isIdle: () => true` 면 `defer` 가 **배리어를 팔지 않고 즉시 attempt** 한다. 원래 테스트는 죽은 호출 덕에 우연히 통과하고 있었다. 실제 동작에 맞추고 busy 대조군을 추가

⚠️ **테스트 픽스처에 raw 제어문자를 넣지 말 것.** 원래 C2 대조군이 소스에 **리터럴 ESC 바이트**(`od -c` 로 `033`)를 갖고 있었고, 같은 리터럴을 Edit 로 재입력했을 때 ESC 가 빠져 실패했다. `'\x1b[1'` 이스케이프 + 이름 붙인 상수로 통일했고 파일에 raw 제어문자는 0개다. 지난 세션 `wsTransportSidecar.test.ts:18` 의 NUL 과 같은 부류다.

### 신설·변경 파일

**1차 세션 (커밋 `dfca40c` 에 포함됨)**
- `server/src/ws/binaryFrameCodec.ts` (신규) — 인코더/디코더
- `server/src/ws/binaryFrameCodec.test.ts` (신규, 78 테스트)
- `server/src/ws/__fixtures__/binary-frame-vectors.json` (신규) — **골든 벡터 SSOT**
- `server/src/ws/wsTransportSidecar.test.ts` (신규, 13 테스트) — ⚠️ `:18` 에 **리터럴 NUL 바이트**가 있어 git 이 binary 로 분류한다. `\u0000` 이스케이프로 바꿔야 diff 가 보인다 (미처리)
- `server/src/ws/wsSendPolicy.ts` · `WsRouter.ts` (수정) — **핀 파일**
- `frontend/tsconfig.test.json` (신규) + `frontend/package.json` `typecheck:tests`
- `docs/research/binary-comms/00`~`09` + `baseline/` 5개

**2차 세션 (C0~C4) — 전부 미커밋**

프로덕션 (4파일):
- `frontend/src/utils/terminalOutputDelivery.ts` — **신규.** IR + `fromJsonOutputMessage`
- `frontend/src/utils/terminalOutputScheduler.ts` — `enqueueBytes` · `enqueueBytesLegacy` 신설, `assertTextIngress` 가드, restore 게이트 확대, retry queue 바이트 회계, `TerminalRestoreHeldOutputEntry.data` 확대. **P2·P5 핀**
- `frontend/src/utils/visibleOutputRecovery.ts` — `assertContiguousSegments` 추출. **P2 핀**
- `frontend/src/utils/terminalOutputHotPath.ts` — `getOutputUtf8ByteLength` 바이트 수용
- `frontend/src/components/Terminal/TerminalView.tsx` — `submitOutput`/`writeRecoveryTailAndWait`/`writeOutput`/`bufferOutputWhileRestorePending` 확대 + enqueue 디스패치. **P2·P3 핀**
- `frontend/src/components/Terminal/TerminalContainer.tsx` — `onOutput` 을 IR 소비로. **P2·P3 핀**
- `frontend/src/contexts/WebSocketContext.tsx` — `onOutput` 시그니처 + 호출부 2곳. **P2·P3 핀**

테스트 (신규 6파일):
`xtermDecoderInterleaving` · `terminalOutputSliceAlignment` · `terminalOutputSchedulerBytesIngress` · `terminalRestoreBufferBytes` · `terminalOutputBytesAccounting` · `terminalOutputDelivery` · `visibleOutputSegmentContiguity`

테스트 (앵커 정정): `terminalViewRecoveryContract` · `terminalContainerRecoveryContract`

기타: `frontend/package.json` + `package-lock.json`(`@xterm/headless` devDep), `frontend/tsconfig.test.json`(allowlist 7건 추가), `frontend/tests/benchmarks/` 3파일(P5 재고정 ×3)

**3차 세션 (C5 선행 a·b·c) — 전부 미커밋**

프로덕션 (4파일, 전부 소폭):
- `frontend/src/utils/terminalHiddenOutput.ts` — `data` 를 `string | (() => string)` 로 확대, `appendDebugTail` 이 `maxBytes` 가드 뒤에서 해소
- `frontend/src/utils/terminalDebugCapture.ts` — `rawPreview` 동일 확대, `isEnabled` 조기반환 뒤에서 해소
- `frontend/src/components/Terminal/TerminalContainer.tsx` — `delivery.previewText()` → `delivery.previewText` (2곳). **P2·P3 핀**
- `frontend/src/utils/terminalOutputDelivery.ts` — 해소된 경고 주석 갱신. **P2 핀**

테스트 (신규 2파일): `terminalOutputPreviewLaziness`(8) · `visibleOutputRecoveryByteSeam`(4)
테스트 (수정 1파일): `terminalContainerRecoveryContract` — EOL 헬퍼 + 앵커 가드 + 경계 단언 + 단일매치 핀(1건 추가)
기타: `frontend/tsconfig.test.json` (allowlist +2)
문서: `docs/research/binary-comms/06-work-plan.md` (**23줄, 줄번호 정정만**. 이 파일은 HEAD 대비 23/23 이므로 남의 헝크가 없다 — **단독 커밋 가능**) · `docs/next/2026-08-19-binary-data-plane-handoff.md`
SRS: `docs/spec/30.buildergate-stability.srs.md` (`IR-BGSTAB-001` status + 증거 2건, MCP mutation)

**⚠️ `git status` 의 `M`/`??` 대부분은 이 작업이 아니다** — 이전부터 있던 미커밋 wave-3 작업(추적 수정 117 / 미추적 222)이 섞여 있다. 위 목록이 이 작업의 전부다.

---

## 4. S4 단계 지도 — C0~C6 (C0~C4 완료)

정본: `06-work-plan.md` **§5 S4-b2**, 상세 설계는 `08-client-wiring-design.md`.

```
✅ C0 P5 재고정 → ✅ C1 xterm 특성화(코드 0) → ✅ C2 enqueueBytes
→ ✅ C3 하류 시그니처 + restore 게이트 → ✅ C4 IR 도입(JSON 전용 순수 리팩터)
→ 🔴 C5 수신 분기 + 프론트 코덱  ← `0x05` 재설계 대기
→ ⬜ C6 마이크로벤치 + 동등성
```

아래 §4 의 나머지는 **C5·C6 에 대해 여전히 유효한 설계 정보**다. C0~C4 의 실제 실행 결과와 계획서 정정은 §3 을 볼 것.

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

### 착수 전 확인 (S4-0b) — **3건 전부 판정 완료 (2026-08-19)**

| # | 질문 | 판정 | 귀결 |
|---|---|---|---|
| 1 | `retainedTerminalStreamEpochCounter`(`SessionManager.ts:1076`) 와 controller `getState().streamEpoch` 가 같은가 | **DIFFERENT** | `0x04` 프롤로그 **160 B 유지**, 골든 벡터 재계산 불필요 |
| 2 | 체크포인트 트랜잭션 도중 lane 폴백이 가능한가 | **반증 — 폴백 자체가 없다** | `07` §6.4 폐기 대상 |
| 3 | `responderLeaseId` / `boundarySourceSeq` 가 checkpoint wire 에 실리는가 | **🔴 ON-WIRE** | `07` §2.6 의 loud reject 결정 **폐기**. `0x05` 재설계 필요 |

**항목 1 상세** — 카운터는 세션당 epoch 이 아니라 **매니저 스코프 seed 할당기**다. `SessionManager.ts:7127-7128` 이 유일한 증감이자 유일한 read 이고, 세션당 한 번만 읽힌다. 이후 각 세션의 값은 `SessionData.retainedTerminal.streamEpoch` 에 살며 카운터는 다시 관여하지 않는다. controller 는 promotion(`TerminalAuthorityController.ts:1077`)·rollback(`:1532`)·rekey(`:606`)로, retained 는 세션 생성·Ordinal64 rollover 로 움직인다 — **트리거 집합이 서로소**. 둘은 controller 생성 시점(`SessionManager.ts:4952` → `Adapter.ts:2205`)에만 같다.
⚠️ **headless 재초기화에서 controller epoch 이 뒤로 간다** — `SessionManager.ts:7471` 이 세대를 올리면 `:4952` 가 retained 값으로 controller 를 재시드하므로, N+1 로 승격됐던 controller 가 N 인 것으로 교체된다. **헤더 `streamEpoch` 를 controller 에서 뽑으면 단조성이 깨진다.** 헤더의 정본은 `01:466` 이 지정한 retained 쪽이다. `checkpointStreamEpoch` 라는 별도 필드명(§8.1)은 장식이 아니라 이 비대칭을 담는 자리다.

**항목 2 상세** — `07` §6.4 의 전제("output 소켓이 죽으면 terminal payload 를 control 로 옮긴다")는 **소스로 반증**됐다. `WsRouter.ts:1106-1111` 가드가 split 계열에서 output 소켓이 OPEN 이 아니면 `sent:false` 로 **거부**한다(재라우팅이 아니다). `: control` 분기는 `unified` 에서만 도달하고 거기서 control 은 유일한 소켓이다. §6.4 가 근거로 인용한 `01:330-334` 는 live-output 식별자 표이며 폴백을 언급하지 않는다 — **상위 근거가 없는 주장**이었다.
실재하는 `?? control` 폴백은 `WsRouter.ts:5862`(`createFairDeliveryScheduler`)지만 `message.type === 'output'` 게이트(`:6394-6399`) 뒤라 체크포인트 프레임은 지나가지 않는다. §6.4 를 다시 쓸 경우 **대상은 `0x04`/`0x06`/`0x07` 이 아니라 `0x01`** 이다.
부수 확인: 체크포인트 평면 `sourceSeq` 는 트랜잭션 스코프 상수(`Adapter.ts:1758-1784` 가 같은 `identity`/`metadata` 를 start·chunk·commit 에 전개)이므로 소켓 교체와 무관하다. `non-monotonic-source-seq`(`terminalWriteCoordinator.ts:1140-1142`)는 `command.type === 'live'|'repair'` 게이트 뒤라 **체크포인트 경로에 아예 없다** — §6.4 의 인용도 틀렸다.

### 🔴 항목 3 — 신규 차단 사유 (S2 산출물 무효화)

`07` §2.6 은 *"어떤 경로도 checkpoint wire 에 `responderLeaseId` 를 대입하지 않는다"* 에 근거해 **인코더 loud reject** 를 채택했다. **그 관찰이 틀렸다.**

```ts
// server/src/services/TerminalAuthorityController.ts:1588-1594  (rollback 경로)
for (const message of recovery.checkpointMessages) {
  const checkpointAccepted = await queueTerminalDelivery(
    () => enqueue({ ...message, responderLeaseId: request.nextCompatibilityResponderLeaseId, boundarySourceSeq }),
```

§2.6 이 검사한 것은 `createCheckpoint` 의 `identity`(`Adapter.ts:1670-1685`)였고 **필드는 controller 가 그 뒤에 주입한다.** 대조군: promotion 경로(`Controller.ts:761-763`)는 `enqueue(message)` 맨몸 — 그래서 두 필드는 promotion 에서 부재, rollback 에서 항상 존재다. 값 출처는 `Adapter.ts:4435`/`:4442`(`responder-browser-${nextStreamEpoch}`, 항상 비어있지 않음)와 `Controller.ts:1477`.

전송 도달 체인 확인: `Controller.ts:492-493` → `Adapter.ts:2259` → `:1369-1370` → `:1469-1474`/`:1597` `enqueueSettledViewFrame(…, 'terminal')`.

**귀결 3가지:**

1. **`0x05` CHECKPOINT_CHUNK 가 깨진다.** `:1588` 의 루프는 `checkpointMessages` **전 원소**에 붙으므로 start·chunk·commit 전부가 두 필드를 싣는다. `0x05` 는 12 B 로 **이미 S2 에 구현**(`binaryFrameCodec.ts:113-114`)돼 있고 자리가 없다 → `01 §1.8` 까지 재검토 대상. **문서 수정으로 끝나지 않는다.**
2. **loud reject 는 compatibility-recovery 체크포인트마다 throw** 한다.
3. **조용히 드롭해도 §2.6 의 예측과 다른 곳에서 터진다.** 클라이언트 `matchesTransactionIdentity`(`terminalCheckpointRuntime.ts:522-523`)는 `undefined === undefined` 로 통과하고 프론트 검증기(`ws-protocol.ts:977-989`)는 이 필드를 보지 않는다. **서버**가 인코딩 이전 record 를 기대값으로 보관하므로(`Adapter.ts:1598-1608`) ACK 대조(`:790-791`)가 실패 → `terminal-checkpoint:rejected / invalid-message`(`:3779-3793`) → apply/drain 정지.

**fixture-only 가 아니다** — `frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts:7702-7713`,`:8038` 이 **실제 routed 서버 프레임**을 캡처해 `fullTransactionIdentityExact: true` 를 단언한다.

**S4 에 대한 영향 범위**: C2·C3·C4 는 **막히지 않는다**(스케줄러·IR 계층, codec 무관).

### 🔴 `0x05` 판정 — **상속안의 방향은 옳으나 차단은 해소되지 않았다. 차단이 `0x05` → `0x04` 로 옮겨갔을 뿐이다** (3차 세션, 검증 후 정정)

> ⚠️ **이 절은 한 번 "✅ 해소" 로 기록됐다가 독립 검증에서 뒤집혔다.** 그때 근거로 삼았던 F1·F2·F3 이 **셋 다 틀렸거나 오도한다.** 아래에 원래 주장과 실측을 나란히 남긴다 — 같은 논증이 재발하지 않도록.

**여전히 옳은 것**: `0x05` 자신의 12 B 프롤로그는 그대로 두고 두 필드를 싣지 않는다. 그 자체로는 골든 벡터 재계산 0.

🔴 **틀린 것: 상속할 원본이 없다.** 상속안은 `0x04` START 가 두 필드를 싣는다고 전제하는데,

| 필드 | `0x04` 프롤로그(`07` §2.9, 160 B) |
|---|---|
| `boundarySourceSeq` | ✅ off 56, `flags2` bit2 presence |
| **`responderLeaseId`** | 🔴 **자리가 없다.** 오프셋 0~159 가 전부 할당돼 있다(직접 확인: 0·8·12·16·24·32·40·48·56·64·68·70·72·74·76·77·78·79·80·84·88·92·96(32B)·128(32B) = 정확히 160). `07:269` 이 이 필드를 "인코더가 거부(§2.6)" 로 두었고 **§2.6 은 폐기됐으며 후속 설계가 없다** |

⇒ **차단 요소는 `0x05` 가 아니라 `0x04` 설계다.** 결정은 문제를 옮겼을 뿐이고, 그 사실이 기록되지 않았다.

✅ **그런데 이 차단은 보이는 것보다 싸다 (3차 세션 실측).** 160 B 레이아웃은 **구현된 적이 없는 제안**이다:

| 사실 | 근거 |
|---|---|
| `prologueBytes(0x04)` 는 **0** 을 반환한다 | `binaryFrameCodec.ts:108-118`, 핀: `binaryFrameCodec.test.ts:747` |
| `assertEncodableHead` 가 `0x04` 인코딩을 **아예 거부**한다 | `binaryFrameCodec.ts:431-436` |
| **`0x04` 골든 벡터가 0개다** | 벡터 9개 = `0x01` 6 · `0x02` 1 · `0x05` 1 · batch 1. `$rules.prologueBytes` = `{1:24, 2:24, 5:12}` — `0x04` 없음 (직접 파싱 확인) |

⇒ **160 B 는 우리가 바꿀 수 있는 제안이고, 늘려도 재계산할 기존 벡터가 없다.** "자리가 없다" 는 고정된 제약이 아니라 **미구현 제안에 대한 상대적 사실**이다. 설계 착수를 이 이유로 미룰 근거가 없다.

**설계에 필요한 수치 2개 (3차 세션 도출)**:

1. **`responderLeaseId` 의 최대 길이 = 38 바이트 (ASCII).** `Adapter.ts:4435` 가 `` `responder-browser-${nextStreamEpoch}` `` 로 만든다 — 접두사 **18자** + `nextStreamEpoch` 는 Ordinal64 라 십진 최대 **20자**(`18446744073709551615`). ⇒ **고정폭 40 B 슬롯 + `flags2` presence bit** 이면 충분하고, 프롤로그는 160 → 200 B 가 된다. (참고: `driverLeaseId` 는 `driver-browser-` 15자 + 20 = 35 B 지만 checkpoint wire 에 실리지 않는다)
2. **지켜야 할 불변식: `prologueBytes` 는 opcode 만의 함수** — `01:108` 이 *"프롤로그 크기는 **opcode 만의 함수**다(§1.8, `prologueBytes()`)"* 라 못박았고 **D14 안전성 논증 전체가 이 성질에 기댄다**(그래서 "bit3 만 지우면 디코더가 프롤로그를 본문으로 오독한다" 가 이 설계에서는 성립하지 않는다). ⇒ **길이 접두 방식의 가변 인코딩은 채택 불가.** 고정폭 슬롯이 이 제약을 자동으로 만족한다.

⚠️ **하지 말 것**: `responder-browser-${nextStreamEpoch}` 이므로 클라이언트가 헤더 `streamEpoch` 에서 **파생**하는 것이 산술적으로 가능하다. **금지** — 내부 명명 관례를 가드 없이 와이어 계약으로 승격시키고, rename 시 실패 모드가 조용한 identity 불일치가 된다. "공짜 최적화" 로 제안되지 않도록 못박아 둔다.
🔴 **게다가 전제가 이미 거짓이다** — `Adapter.ts:2152-2155` 가 같은 `responder-browser-` 접두사에 `-runtime-${runtimeInstanceGeneration}` 접미사를 붙인다. 오늘 checkpoint 와이어로 가지는 않지만, *"접두사 + epoch 이 유일한 shape"* 라는 파생의 전제가 **저장소 안에서 이미 깨져 있다.**

### ✅ `0x04` 설계안 — **160 → 200 B, 고정폭 슬롯** (3차 세션)

| 항목 | 값 |
|---|---|
| off **160** | `responderLeaseIdLength` **uint8**, 도메인 `0..38` (단위: 바이트) |
| off **161** | `responderLeaseIdBytes` **raw 39 B** — `[0,length)` UTF-8 원시, `[length,39)` **0 고정** |
| `flags2` **bit4** | `RESPONDER_LEASE_ID_PRESENT` 신설. 예약 마스크 `0xFFF0` → **`0xFFE0`** |
| 총 프롤로그 | **200 B** (8×25 정렬). off 0..159 는 `07` §2.9 와 완전 동일 |

**순수성 만족**: `prologueBytes(0x04)` 가 **상수 200** 을 반환한다. `responderLeaseIdLength` 는 프롤로그 **안**에 있고 39 B 영역을 `[값 | 0-패딩]` 으로 분할할 뿐, 39 는 `length` 와 무관하게 항상 소비된다. 본문 시작은 `28+200` 고정. ⇒ **가변 길이 인코딩(varint 접두, packed)은 기각** — `prologueBytes` 가 페이로드를 읽어야 해 `01:518`·`01:108` 을 정면 위반한다.

**부재는 반드시 "키 부재" 이지 빈 문자열이 아니다.** 디코더가 부재를 `''` 로 복원하면 `matchesTransactionIdentity:522` 는 `'' === ''` 로 **통과하지만** ACK 에코가 `Adapter.ts:790` 에서 `'' === undefined` → false → `terminal-checkpoint:rejected`. **클라이언트 검사를 통과한 뒤 서버에서 죽는 최악의 진단 경로**다. presence bit 이 `bit4=1 && length===0` 모순을 그 자리에서 거부한다.

**골든 벡터**: 기존 9개 **재계산 0**(`$rules` = `{1:24,2:24,5:12}`, `0x04` 벡터 없음). 신규 **2개** — rollback 경로(bit2·bit4 set)와 promotion 경로(둘 다 clear). presence 가 실제로 두 값을 갖는 유일한 필드 쌍이라 한쪽만 두면 부재 경로가 미검증으로 남는다. **손계산할 것 — 인코더 출력을 덤프하면 라운드트립 단언의 두 피연산자가 같은 출처가 된다**(`07:156`).

**의도적으로 깨지는 핀 1개**: `binaryFrameCodec.test.ts:747` 의 `[0x03,0x04,0x06,0x07] → 0`. `0x04` 를 빼고 `assert.equal(prologueBytes(0x04), 200)` 으로 갱신.

🔴 **`prologueBytes(0x04)` 만 먼저 바꾸지 마라 (3차 세션 확인).** 가장 작아 보이는 착수 단위이고 가장 나쁘다. `assertEncodableHead:432` 가 **`prologueBytes(opcode) === 0` 을 미구현 opcode 거부 게이트로 쓴다.** 크기만 200 으로 바꾸면 그 게이트가 열리는데 `writePrologue` 에 `0x04` 분기가 없어 **200 바이트가 0으로 채워진 채 인코딩되고 디코더가 오독한다** — 지금의 시끄러운 거부(`RangeError`)보다 명백히 나쁘다.

⇒ **한 단위로 함께 착수해야 하는 것**: `prologueBytes` + `CheckpointStartPrologue` 타입 + `BinaryWireMessage` union(`:365`) + `writePrologue` 분기 + `parseFrameMessage` 분기 + 거부 규칙(§1.4 상당) + **손계산 골든 벡터 2개**. 비싼 것은 마지막이며, `07:156` 이 **인코더 출력 덤프를 금지**한다(두 피연산자가 같은 출처가 되므로).

#### 🔴 설계안의 오류 1건 — 직접 확인해 정정했다

설계는 *"`07` §3.3 이 `responderLeaseId` 를 이미 상속 목록에 올려 두었으므로 `terminalCheckpointRuntime.ts:507-524` 는 한 줄도 안 바꾼다"* 고 했다. **§3.3 의 상속 목록에 `responderLeaseId` 는 없다** (직접 확인). 목록은 `protocolVersion`/`sessionId`/`retentionPolicyId`/`connectionId`/`authorityEpoch`/`transitionEpoch`/`boundarySourceSeq`/`streamEpoch`/`checkpointEpoch`/`snapshotSeq`/`oldestRetainedSeq` **11개**다.

**왜 없는가**: §2.6 이 *"인코더가 거부"* 로 결정하면서 이 필드를 분류 대상에서 아예 뺐다. §2.6 을 폐기하자 **분류가 비어 있는 구멍**이 남았다.

⇒ **§3.3 에 `responderLeaseId` 를 상속 필드로 추가하는 것이 필수 작업이다.** 문서 변경이지 설계 결함은 아니지만, 빠뜨리면 chunk/commit 디코드가 필드를 비운 채 `matchesTransactionIdentity` 에 도달해 **모든 rollback chunk 가 fail-closed** 된다.

#### 이것이 두 검증자의 상반된 결론을 화해시킨다

`design-verdict-check` 는 *"클라이언트는 상속이 아니라 **비교**한다 → 클라이언트 수정 필수"* 라 했고, `prologue-0x04-design` 은 *"수정 불필요"* 라 했다. **둘 다 부분적으로 맞다:**

- 비교(`:522`)가 상속(`:1218`)보다 앞이라는 관찰은 **옳다.**
- 그러나 상속을 수행하는 주체는 그 코드가 아니라 **디코더**다 — chunk/commit 프롤로그에 슬롯이 없으므로 디코더가 열린 트랜잭션에서 값을 채워 넣은 **뒤** 메시지가 `:522` 에 도달한다.
- ⇒ **`terminalCheckpointRuntime.ts:507-524` 자체는 바꿀 필요가 없다.** 대신 **§3.3 상속 규칙에 `responderLeaseId` 를 등재하고 디코더가 그것을 구현**해야 한다. 빠뜨리면 `design-verdict-check` 가 예측한 fail-closed 가 정확히 일어난다.

#### 별개로 남은 미해결 1건

`07:313` 이 *"`boundarySourceSeq` 를 §3.3/§3.4 의 상속 목록에서 **빼야 한다**"* 고 지시했는데, `0x06` 의 88 B 레이아웃(`07:517-527`)에 그 슬롯이 없다 — 문자 그대로 따르면 `0x06` 이 **+8 B(+presence bit) = 96 B** 가 되어야 한다. 반대로 `:523` 통과에는 상속으로 충분하다(`Controller.ts:1592-1593` 이 start·chunk·commit 전부에 같은 값을 주입하므로 두 피연산자가 애초에 같은 출처). **`07:313` 은 과잉 정정일 가능성이 높다. `0x06` 레이아웃 확정 전에 별도로 닫을 것.**

**실패 사슬** (구현하면 이렇게 된다): 서버는 인코딩 이전 record 를 기대값으로 보관(`Adapter.ts:1598-1608`) → 클라이언트 ACK 는 `wireIdentity(activeIdentity)` 로 생성 → 서버가 `checkpointWireIdentityMatches`(`:773-792`)로 대조 → 불일치 → `terminal-checkpoint:rejected / invalid-message`(`:3779-3793`) → **apply/drain 영구 정지**.

**아래 F1·F2·F3 은 원래의 근거이며, 각각 무엇이 틀렸는지 함께 적는다.**

| # | 사실 | 검증 |
|---|---|---|
| **F1** | 두 필드는 `checkpointMessages` 배열 **전체에 걸쳐 상수**다 | **결론은 성립하나 근거가 틀렸다.** `boundarySourceSeq` 는 "루프 진입 전 1회 대입된 지역변수" 가 **아니라** `Controller.ts:467` 의 **장수 클로저 `let`** 이고 `:1073`·`:1477` 두 곳에서 재대입된다. 루프(`:1593`)는 스냅샷이 아니라 살아있는 변수를 읽고 매 반복 await 한다. 불변성이 성립하는 진짜 이유는 **두 재대입이 각각 await 없는 동기 구간에서 트랜잭션 가드도 함께 무효화**하고(`:1073`→`:1074`, `:1477`→`:1527-1532`), `queueTerminalDelivery:674` 가 같은 동기 블록에서 `isTransactionCurrent()` 를 재확인하기 때문이다. ⚠️ **즉 불변성이 아니라 가드의 결과다 — 그 사이에 await 가 하나 삽입되면 조용히 깨진다** |
| **F2** | 클라이언트는 체크포인트 프레임보다 **먼저** 두 값을 JSON 으로 받는다 — `terminal-authority:rollback-start` 가 `responderLeaseId`(`:1572`)·`boundarySourceSeq`(`:1574`)를 싣는다 | ✅ 직접 확인. `SERVER_TO_CLIENT_OPCODE_BY_TYPE`(`binaryFrameCodec.ts:72-80`)에 `terminal-authority:*` 가 **없어** JSON 평면에 남는다. **순서 보장 기전은 아래에 따로 검증했다** |

#### F2 의 순서 보장 — 기전은 견고하다. 그런데 **엉뚱한 메시지를 지키고 있었다**

🔴 **먼저 결론부터**: 클라이언트는 `terminal-authority:rollback-start` 로부터 checkpoint identity 를 만들지 **않는다.** `TerminalView.tsx:3624` 는 그것을 `pendingCompatibilityRollbackRef` 에 **보관만** 한다. 실제 identity 출처는 **`terminal-checkpoint:start` 하나뿐**이다 — `identityFromStart`(`terminalCheckpointRuntime.ts:463-486`)가 `responderLeaseId`(`:477`)·`boundarySourceSeq`(`:478`)를 거기서 읽는다.

⇒ **상속 사슬은 `0x04` → `0x05` 이고 전부 바이너리 평면 내부다.** "`terminal-authority:*` 가 opcode 표에 없어 JSON 으로 남는다" 는 관찰은 **사실이지만 설계가 의존하는 그 무엇도 보호하지 않는다.** 그래서 위 CRITICAL 이 성립한다 — `0x04` 가 못 실으면 대안이 없다.

아래는 그럼에도 확인해 둔 순서 기전이다. `0x04`/`0x05` 가 같은 lane 을 타는 것도 같은 규율의 적용을 받으므로 버리지 않는다.

전송 큐는 **둘**이다 — `controlItems` 와 `terminalItems`(`wsSendPolicy.ts:50-59`). 그리고 `getTransportMessagesInPriorityOrder`(`:446-451`)가 **control 을 먼저** 낸다. 따라서 두 메시지가 다른 큐에 들어가면 순서가 뒤집힌다.

배정 규칙(`getControlMessageKind` `:467-481` → `pushTransportMessage` `:397-403`):

| 메시지 | kind | 큐 |
|---|---|---|
| `terminal-checkpoint:{start,chunk,commit,output}` | `terminal-bulk` | `terminalItems` |
| `terminal-authority:rollback-start` | **`terminal-control`** — `isTerminalOrderedControlMessage`(`:483-491`)가 *"`input:rejected` 가 아니고 `sessionId` 가 string 이면 true"* 이고, 이 메시지는 `sessionId` 를 싣는다(`Controller.ts:1567`) | `terminalItems` |

`pushTransportMessage` 는 **`kind === 'control'` 만** `controlItems` 로 보낸다. 둘 다 그게 아니므로 **같은 배열에 FIFO** 로 쌓인다. ✅

새치기 경로도 확인했다: `prependTransportMessage` 의 유일한 호출부는 `WsRouter.ts:6413` 의 **전송 실패 재시도**이고, 방금 실패한 head 메시지를 제자리로 되돌릴 뿐 뒤엣것이 앞지르게 하지 않는다.

그리고 *"클라이언트가 `rollback-start` 를 놓쳤는데 체크포인트는 받는"* 시나리오는 **enqueue 단계에서 막힌다** — `rollbackStartAccepted` 가 false 면 `Controller.ts:1584-1586` 이 즉시 반환하고 체크포인트 루프에 도달하지 않는다.

⚠️ **깨지는 조건 — 이것을 기록해 두는 것이 이 절의 목적이다.** 순서 보장은 **`rollback-start` 가 `sessionId` 를 싣는다는 사실 하나에 걸려 있다.** `sessionId` 를 빼거나, 타입을 `input:rejected` 로 바꾸거나, `sessionId` 없는 새 authority 메시지를 상속 경로에 넣으면 그 메시지는 **`control` 로 분류되어 `controlItems` 로 가고 체크포인트보다 먼저 나간다** — 이 경우엔 오히려 안전하지만, 반대로 체크포인트 쪽이 control 이 되면 **상속할 값보다 먼저 도착**한다. 상속안을 구현할 때 **이 배정을 단정하는 테스트를 하나 둘 것.**
| **F3** | 클라이언트는 **이미** 나머지 identity 전부를 start 로부터 상속한다 | 🔴 **거짓, 두 번 틀렸다.** ① 인용한 `checkpointIdentityFrom` 은 **존재하지 않는 함수**다 — 실제는 `identityFromStart`(`terminalCheckpointRuntime.ts:463`). 연구 보고의 오기를 확인 없이 옮겼다. ② **클라이언트는 상속이 아니라 먼저 *비교* 한다** — `matchesTransactionIdentity`(`:507-524`)가 `responderLeaseId`(`:522`)·`boundarySourceSeq`(`:523`)를 **동등 비교**하고, `...activeIdentity` 상속(`:1218`)은 그 게이트(`:1205-1212`)를 통과한 **뒤에야** 일어난다 |

🔴 **F3 이 무너지므로 "클라이언트 무변경" 이 성립하지 않는다.** 두 필드 없이 디코드된 `0x05` 는 `undefined` 를 낳고, rollback 경로의 START 는 비어있지 않은 문자열을 준다 → 비교 실패 → **모든 rollback chunk 가 `failClosed('checkpoint-identity-mismatch')`**. `terminalCheckpointRuntime.ts:507-524` 를 **반드시 함께 고쳐야 한다.**

🔴 **영향 범위도 과소평가했다** — 두 필드를 chunk 에 **이름으로** 핀한 단언이 4건 있다:
`TerminalAuthorityController.test.ts:8260`(*"compatibility checkpoint frames must retain the rollback responder lease identity"*)·`:8265`(*"…source boundary identity"*) — `checkpointPartsFor()` 전체(= chunk 포함) 대상. 그리고 E2E 3건(`wave3-terminal-authority-promotion.spec.ts:7625-7632`·`:7694-7698`·`:7702-7713`)이 chunk 마다 `hasFullRollbackIdentity` 를 요구한다.
⚠️ **`:8300-8307` 은 `` `${rollbackStart.responderLeaseId}-stale` `` 로 apply-ack 을 보내 거부되는 것을 단언한다** — 두 필드를 `undefined` 로 collapse 하면 이 stale-lease 펜스가 **공허해진다.**

**비용 (여전히 유효)**: `0x05` 쪽 골든 벡터 **0개 재계산**(`checkpoint-chunk-44` 무변경, `$rules` 무변경, 파생 fault 0건). 그러나 **`0x04` 설계 비용이 미산정**이다 — uint16 인덱스안(벡터 + `$rules` + 채널 스코프 테이블 2벌 + 신규 control 메시지 + 수명/회전 규칙)이 그리로 옮겨간다.

**기각된 것**: 프롤로그 확대안은 `responderLeaseId` 가 **가변 길이 string** 이라 `prologueBytes` 를 opcode 순수함수가 아니게 만들고, **`01 §1.8` 불변식 1과 D14 안전성 논증이 바로 그 성질에 기대고 있다.** 게다가 불일치 시 본문 오프셋이 밀려 digest 불일치 → **거부가 아니라 복구 루프**(가장 나쁜 진단 경로).

**잔여 비용 — 연구 보고의 R3 은 과장이다 (3차 세션 정정).** 보고는 *"`Adapter.ts:790-791` 의 두 비교가 **자기비교**가 되어 절대 실패할 수 없다"* 고 했으나, `checkpointWireIdentityMatches`(`Adapter.ts:773-792`)를 직접 읽으면 그렇지 않다.

그 함수는 **클라이언트 ACK 의 `message`** 를 **서버가 보관한 `checkpoint` 레코드**와 대조한다. 상속안에서도 클라이언트의 값은 **수신한 메시지**(`rollback-start` JSON / `0x04` START)에서 오므로 여전히 서버→클라이언트→서버 왕복이고, **출처가 갈린 두 피연산자**다. 오늘과 비교해 실제로 잃는 것은 좁다:

> **chunk·commit 프레임 *자체*의 손상은 더 이상 이 비교로 잡히지 않는다** — 그 프레임이 필드를 싣지 않으므로. START/`rollback-start` 경로의 손상만 잡힌다.

⚠️ **진짜로 공허해지는 조건은 따로 있다 (R4)**: 클라이언트가 값을 **수신하지 않고 파생**하면 그때 자기비교가 된다. `responderLeaseId` 는 `responder-browser-${nextStreamEpoch}`(`Adapter.ts:4435`)이라 헤더 `streamEpoch` 에서 재구성이 **가능하다**. **하지 말 것** — 내부 명명 관례를 가드 없이 와이어 계약으로 승격시키고, rename 시 실패 모드가 조용한 identity 불일치가 된다. "공짜 최적화" 로 제안될 수 있으므로 못박아 둔다. 메모리 `check_operands_must_have_independent_origins` 가 정확히 이 판별을 다룬다 — **이름이 아니라 무엇을 비교하는지 볼 것.**

### 🔴 그 과정에서 드러난 **더 큰** 차단 사유 — `0x01` OUTPUT 이 `responderLeaseId` 를 싣는다

**`0x05` 보다 심각하다.** `emitOutput`(`TerminalAuthorityController.ts:497-509`)이 **모든** `type:'output'` 메시지에 `responderLeaseId`·`sourceSeq`·`streamEpoch` 를 넣는다(`:508`). 직접 확인했다.

- **핫패스다.** `queueOutputDelivery` 호출부가 **5곳**(`:784`·`:982`·`:1012`·`:1035`·`:1621`) — 승격·롤백 양쪽. (연구 보고는 2곳이라 했으나 실측은 5곳)
- **`0x01` 프롤로그 24B 에 자리가 없다.**
- **타입이 못 잡는다** — `ws-protocol.ts:712-733` 의 `output` variant 에 세 필드 **선언이 아예 없고**, `enqueue(message: object)`(`Controller.ts:492`)가 타입을 지운다.
- **blast radius 약 10배** — `0x01` 파생 골든 벡터가 `output-minimal-52`(fault 29) + `batch-two-output-frames-106`(6) + `output-utf8-body-60`(3). `0x05` 는 파생 0건이다.

✅ **처분 판정 완료 (3차 세션): 셋 다 `0x01` 와이어에서 제거 가능.** 클라이언트 소비자 0, 서버는 인코딩 이전 단계에서만 읽는다. 상세 근거표는 §8 항목 10. ⇒ **파생 골든 벡터 38건의 blast radius 가 통째로 사라진다.**

부수 발견: **`0x07` CHECKPOINT_OUTPUT 도 두 필드를 싣는다**(`Adapter.ts:1563-1570` 이 저장된 active checkpoint 를 그대로 전개). `07` §2.6 폐기 배너는 `0x05` 만 지목했다. 상속안 하에서는 프레임에서 빠지므로 무해하다.

### ✅ `01 §1.8` 앵커 인용 (R5) — **정정 완료 (4차 세션)**

`0x05` 작업이 손댈 바로 그 절이다. 재측정 확정 참값: **§1.8 = `01:514`**, OUTPUT 제목 `:520` / 표 `:522-528`, 세그먼트 도입문 `:530` / 표 `:532-538`, `0x02` `:548-552`, **`0x05` = `:554-558`**.

`07`·`08`·픽스처의 **28건을 정정하고 46개 앵커를 기계 대조**했다 — 상세·참값표·잔여 1건은 §8 항목 11. ⚠️ **3차 세션이 기록한 인용 위치(`07`:507/848/991, `06`:2237/2587)는 그 자체가 stale 이었다** — `07` 이 그 뒤 수정되어 줄이 밀렸고, `06` 의 두 곳은 `01:524` 가 아니라 `01:522` 를 인용하고 있었다. **인계 문서에 적힌 줄번호도 재측정 대상이다.**

가드는 살아 있다 — `binaryFrameCodec.test.ts` 의 layout 자가검증이 fixture 손상을 red 로 만든다.

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

### 5.2 신뢰할 수 없는 green — **27가지 경로**로 확인됨 (1~6 1차 · 7~12 2차 · 13~24 3차 · 25~27 4차)

| # | 사례 | 증상 |
|---|---|---|
| 1 | `WsRouterSplitHandshake.test.ts` | `fail 0 / todo 14` 로 **exit 0**, 실제로는 `✖` 에 14건 |
| 2 | `boundary-gate.test.mjs` | `spawnSync` 에 `env` 미지정 → `NODE_TEST_CONTEXT` 상속 → **0개 실행 후 exit 0**. 내부 84ms vs 직접 35,466ms |
| 3 | `--verify-existing` 플래그 | **파싱조차 안 된다**(`--fixture-only` 뿐). 동결 계약이 존재하지 않는 플래그를 가리킴 |
| 4 | ACK credit 단정 | 구현과 기대를 **같은 함수**에서 뽑음 |
| 5 | S2 수용 대조군 16개 | 건수만 보고 내용을 안 봄 — 4 KiB 초과를 잘라먹는 디코더가 전 스위트 통과 |
| 6 | `settingsDraftHelpers.test.ts:63-68` | union 에 없는 리터럴 비교 → **정적으로 항상 false** (TS2367) |
| **7** | `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK` | 문서 5곳이 처방하는 재고정 레버가 **도달 불가**(`:79` 에서 throw, 읽는 곳은 `:372`). 게다가 도달해도 대상이 아닌 파일을 쓴다 |
| **8** | 콜백 안에서만 대입되는 `let` | TS 가 `never` 로 좁혀 **호출이 정적으로 죽는다.** 런타임에선 통과하던 테스트를 `typecheck:tests` 가 잡았다. 배열 수집으로 회피 |
| **9** | 소스 텍스트 테스트의 **음성 단언** | `doesNotMatch(/output\.screenSeq \?\?/)` 는 코드가 `output.` 을 안 쓰게 되는 순간 **영원히 참**이 된다. 수신자를 `[\w.]*` 로 열어 둘 것 |
| **10** | `\n` 리터럴 needle | CRLF 파일에서 **영구히 -1**. 실패는 나지만 원인이 코드가 아니라 개행이다 |
| **11** | 앵커에 `notEqual(-1)` 가드 부재 | `slice(-1, end)` 가 `''` 를 주고 `assert.match` 가 빈 문자열에 실패 → **원인을 가리는 메시지** |
| **12** | **red 인 테스트가 뒤 어서션을 가린다** | 이미 실패 중인 파일에 손대면 실행 결과로는 자기 결함이 안 보인다. C4 에서 실제로 발생했다 |
| **13** | `slice(start, -1)` | 끝 앵커가 -1 이면 `slice` 가 그것을 **`length-1`** 로 해석해 청크가 조용히 **3배로 부푼다**(920→2944자). 실측: 하류 어서션 3건이 **전부 그대로 통과**했다 → `notEqual(-1)` 가드 하나가 유일한 방어선이었다. 경계 자체를 단언해야 한다(`doesNotMatch(chunk, 끝앵커)`) |
| **14** | 기준선에 **없는** 테스트 | 문제의 EOL 2건은 기준선(HEAD `eb2f4f8`) 당시 **존재하지 않았다** — 미커밋 작업이 추가한 것이다. 따라서 *"기준선과 일치"* 만으로는 이 부류의 회귀를 못 잡는다. 기준선은 **하한**이지 완전한 그물이 아니다 |
| **15** | **유니온으로 넓힌 파라미터의 한쪽 갈래만 테스트** | `string \| (() => string)` 로 넓히고 **함수 갈래만** 대조군을 두면, string 갈래를 조용히 버리는 구현(`… : undefined`)이 **전 스위트를 통과**한다. 실증됐다 — 신규 8건 + 프리뷰 관련 5파일이 전부 green 인 채로 ~24개 호출부의 프리뷰가 사라졌다. **양쪽 갈래에 각각 대조군을 둘 것** |
| **16** | 새 테스트가 **이름만** 대상을 가리킴 | byte-seam 테스트가 `BoundTerminalRestoreAdapter.handle` 을 지목하면서 `coordinator.dispatch` 를 직접 불렀다. 오늘은 동치라 통과하지만, 그 시임에 정규화가 추가되면 **지킨다고 주장한 테스트가 놓친다** |
| **17** | 함수를 **떼어 넘기기** | `previewText()` → `previewText` 로 바꾸면 `this` 결속이 끊긴다. 프로퍼티 타입 `() => string` 은 메서드 축약형도 허용하므로 **컴파일 에러 없이** 런타임에 깨진다. 분리 호출 테스트로 `this`-free 계약을 핀할 것 |
| **18** | **기본값 경로가 검사되지 않는다** | 모든 테스트가 옵셔널 파라미터를 **명시**로 넘기면 함수가 선언한 기본값(`?? 'snapshot-restore'`) 분기는 한 번도 실행되지 않는다. 실증됐다 — 그 분기에서만 즉시 디코드하는 뮤턴트가 9/9 를 통과했다. **생략 케이스를 하나 둘 것** |
| **19** | **조건부 계약의 축을 하나만 파라미터화** | "조건이 맞을 때만 하라" 는 계약은 축이 여럿이다(정책 × visibility × 시작 상태 × budget × 캡처 범위). 한 축만 훑으면 나머지에 뮤턴트가 산다 — 실증 **4개**. 특히 **정상 경로가 테스트되지 않는 경우**: `write-hidden` 에서 *보이는* 터미널이 통상 경로인데 유일한 테스트가 `isVisible:false` 였다 |
| **20** | 음성 단언이 **alias** 로 우회됨 | `doesNotMatch(/delivery\.previewText\(\)/)` 는 `const p = delivery.previewText; p();` 를 못 잡는다. 항목 9(rename)와 같은 부류의 다른 형태. **수신자에 묶지 말 것** (`/\.previewText\(\)/`) |
| **21** | spread 순서를 아무도 단정하지 않음 | `{...event, ...identity, ...scope}` 를 뒤집으면 호출자의 stale identity 가 이기는데 4건이 전부 통과했다. 프로덕션 호출자가 실제로 겹치는 키를 넘기므로(`TerminalContainer.tsx:1634-1635` 등) 실재 위험. **stale 값을 넣고 무시되는지 단언할 것** |
| **22** | 🔴 **커버한 shape ≠ 실제로 오는 shape** | 타입 가드를 `Uint8Array` 하나로만 테스트하면 가드를 `instanceof Uint8Array` 로 좁혀도 통과한다 — ArrayBuffer·DataView·Int8Array·number·plain object 가 전부 admit 되는데도. **그리고 `binaryType='arraybuffer'` 가 실제로 주는 것은 `ArrayBuffer` 다.** 대표값이 아니라 **런타임에 오는 값**으로 테스트할 것 |
| **23** | 단정에 **기여하지 않는 필드**를 넣어 강해 보이게 함 | `repairToken: 'repair-STALE'` 은 `output-arrived` 경로에서 비교되지 않는다(`requireRepairToken` 일 때만). 지워도 테스트가 통과했다. **각 필드가 실제로 비교되는지 확인할 것** |
| **24** | **대조군 자체의 결함** | 3라운드에 추가한 대조군 5개 중 2개가 4라운드에서 불완전(S)·무력(X)으로 판정됐다. 정당한 1회 해소가 일어나는 corner 뒤에 이중 해소가 숨는다. **수정본을 원본과 같은 기준으로 다시 공격할 것** |

| **25** | 🔴 **뮤테이션 하네스 자체가 침묵 실패** | Windows 에서 `execFileSync('npx', […])` 가 셸 없이 `npx` 를 못 띄워 stdout 이 비었고, `out.match(/fail (\d+)/)` 가 `undefined` 를 줬다. `Number(undefined) > 0` 은 `false` → **뮤턴트 9개 전부 "SURVIVED"** 로 출력됐다. 뮤테이션 테스트는 *"살아남았다"* 가 나쁜 소식이므로 **고장난 하네스가 최악의 결론을 자신 있게 보고한다.** 회피: (a) 파싱 실패를 생존과 **다른 라벨**로 분기, (b) **뮤턴트를 걸기 전에 baseline 을 먼저 파싱**해 하네스를 자가검증. 실측으로 확인 — 수정 후 같은 9개가 전부 KILLED |
| **27** | 🔴 **모놀리식 러너가 실패를 안고 exit 0 을 낸다** | `cd server && npx tsx src/test-runner.ts` 가 마지막 줄에 **`21 test(s) failed`** 를 찍고 **exit code 0** 으로 끝난다(4차 세션 실측). §5.2 항목 1(`WsRouterSplitHandshake`)과 **다른 파일에서 같은 형태**가 반복된다. 이 러너를 CI·스크립트에서 exit code 로 판정하면 회귀가 통째로 조용히 지나간다. **마지막 줄의 `N test(s) failed` 를 파싱할 것** |
| **26** | **레이아웃 일치 ≠ 벡터 유효** | 손계산 골든 벡터를 오프셋·폭·엔디안에 대해 전건 대조해도, **flags2 presence 의미론**(어느 오프셋이 유의미한가)은 검사되지 않는다. 실증: `0x04` 벡터 2개가 bit0 clear 인데 off 128 에 32×0x22 를 싣고 **독립 검증까지 통과**했다. 도메인 검사를 구현하자 즉시 red. **표는 "어디"를, 플래그는 "언제"를 규정한다 — 따로 검사할 것** |

**규칙: 대조군을 추가했으면 뮤턴트로 확인하라.** 이번 세션에서 대조군 2건이 각각 실제 생존 뮤턴트를 죽였음을 실행으로 확인했다(적용 → 실행 → 원본 복원 → 해시 대조). "이제 잡힐 것" 이라는 추론만으로 넘어가면 §5.2 에 19번째 항목이 생긴다.

**규칙: exit code 를 단독 신호로 쓰지 말고 실행 건수·`✖` 목록·`todo` 카운트를 항상 대조하라.**
**규칙: 이미 red 인 테스트 파일을 수정했다면, 고친 어서션을 소스에 직접 실행해 확인하라 — 스위트 실행은 증거가 되지 못한다.**

### 5.3 도구

- **`npx speckiwi` 는 로컬 2.2.3 을 실행해 전역 2.12.0 을 가린다.** `speckiwi` 를 **이름으로** 호출하라. 2.12.0 에는 `edit-ac`·`replace-acceptance-criteria`·`edit-requirement`·`repair` 가 **있다** — "AC 편집 불가"·"repair 없음" 은 **거짓**
- **`mcp__speckiwi__add_trace_link` 는 `notes` 를 조용히 버린다**(스키마엔 있고 핸들러가 안 넘김). CLI 는 정상. **dryRun 도 없으니 `git diff` 가 유일한 관측 수단**
- **Git Bash MSYS 경로 변환** — `/api/...` 같은 인자가 `C:/Program Files/Git/api/...` 로 바뀐다. `MSYS_NO_PATHCONV=1`
- **`set_active_target` 만으로 `validate` 기준선이 바뀐다** — `SRS-W023` 이 active target 스코프. 전환 후 **재기준선** + `summarize_target` 보완 게이트 필수

### 5.4 문서 인용

**S1 이 `payloadFields` 3줄을 `FairTerminalDeliveryInput` 안쪽에 넣어 `06` 의 `wsSendPolicy.ts` 인용이 밀렸다 — 그런데 폭이 하나가 아니다: 삽입 지점 앞은 +5, 뒤는 +8.** "전부 +8" 일괄 치환은 앞쪽 4개를 3줄씩 어긋나게 만든다.

**등록 표 몫은 3차 세션에 정정 완료**(23줄, 동결 구역 침범 0). 남은 것은 §8 항목 8 참조 — **미등록 줄번호 다수 + 내용 오류 2건**(둘 다 S1 사이드카 승격 이후 서술 미갱신).

⚠️ **이 계열에서 가장 위험한 형태**: `:518` 은 *오늘의 정답*(`encodedBytes`)이면서 동시에 *어제의 stale*(`FairTerminalDeliveryPolicy`, 실제 `:526`)이다. 같은 숫자가 한 문서 안에서 정답과 오답을 겸하므로 **일괄 치환이 조용히 옳은 인용을 망가뜨린다.** 반드시 앵커 문맥과 함께 판정할 것.

4차 세션이 같은 형태를 **`01` 쪽에서도** 확인했다: **`01:518`** 은 `07:342`(D14 순수성 불변식)에서 **정확**하고 `07`:73·75·114·884(`0x02` 필드 폭)에서 **틀렸다**. **`01:556`** 도 마찬가지 — `0x05` 프롤로그로는 맞고 `07:865`(ESC 6B, 참값 `01:628`)로는 틀렸다. **줄번호 단위로 주소 지정해 정정하는 것 외에 안전한 방법이 없다.**

🔴 **널리 인용되는 문서의 본문은 줄 수를 바꾸지 말고 고쳐라 (4차 세션 실측).** `01` §3.6 을 자연스럽게 고쳤더니 1622→1632 줄이 되면서 **하류 앵커 23개(`01:1128`~`:1448`)가 +10 밀렸다.** 그중에는 이미 stale 인 것과 정확한 것이 섞여 있어 **일괄 +10 은 정확한 것을 망가뜨린다.** 되돌리고 정확히 같은 10줄에 다시 넣어 해결했다. 검증: `wc -l` 이 원래 값 유지 + `git diff -U0` 의 전 hunk 가 `-N +N` 1:1 치환.

🔴 **정정 작업 자체가 새 오인용을 만든다 — 고친 인용은 기계로 되짚어라.** 4차 세션이 도입한 인용 49개를 *"그 줄이 주장한 토큰을 담는가"* 로 스크립트 대조했더니 **1건이 틀렸다**(내가 방금 쓴 `wsSendPolicy.ts:91`, 참값 `:96`). 눈으로 훑는 검토는 이것을 통과시킨다. 스크립트는 `scratchpad/verify-session-anchors.mjs` 형태 — `[소스, 줄, 기대 토큰, 그 인용의 주장]` 배열 하나면 된다.

⚠️ **인계 문서(이 파일)에 적힌 줄번호도 예외가 아니다.** 3차 세션이 기록한 인용 위치 `07`:507/848/991 · `06`:2237/2587 · `01:748` 이 전부 틀렸다(각각 파일 수정으로 밀림 / 실제로는 `01:522` 인용 / `:748` 은 거부코드 리터럴이고 참값은 **`01:823`**). **읽은 즉시 재측정할 것.**

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
# --- 서버 (1차 세션 산출물)
cd server && npx tsx --test src/ws/binaryFrameCodec.test.ts        # 78/78
cd server && npx tsx --test src/ws/wsTransportSidecar.test.ts      # 13/13
cd server && npx tsx src/test-runner.ts                            # 21 fail = 기준선
cd server && npx tsc --noEmit -p tsconfig.json                     # exit 0
cd server && npx tsx --test src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts  # 4/4

# --- 프론트 타입 (두 축 모두 봐야 한다)
cd frontend && npx tsc -p tsconfig.app.json --noEmit               # exit 0  ← npm run build 가 쓰는 것
cd frontend && npm run typecheck:tests                             # exit 0  ← 테스트 전용, allowlist 방식

# --- S4 신규 (cwd=frontend, node --experimental-strip-types --test)
tests/unit/xtermDecoderInterleaving.test.ts          # 5/5   C1 Arm A
tests/unit/terminalOutputSliceAlignment.test.ts      # 3/3   C1 Arm C
tests/unit/terminalOutputSchedulerBytesIngress.test.ts # 8/8 C2
tests/unit/terminalRestoreBufferBytes.test.ts        # 6/6   C3
tests/unit/terminalOutputBytesAccounting.test.ts     # 7/7   C3
tests/unit/terminalOutputDelivery.test.ts            # 11/11 C4
tests/unit/visibleOutputSegmentContiguity.test.ts    # 5/5   C4
tests/unit/terminalOutputPreviewLaziness.test.ts     # 16/16 C5 선행 b
tests/unit/visibleOutputRecoveryByteSeam.test.ts     # 11/11 C5 선행 c

# --- P5 (스케줄러를 건드렸다면 반드시)
cd frontend && node --experimental-strip-types --test \
  tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts \
  tests/benchmarks/terminalNoRenderFixture.test.ts           # 3/3

# --- 프론트 단위 전수 (파일별 루프. 디렉터리 인자는 동작하지 않는다)
cd frontend && for f in tests/unit/*.test.ts; do \
  env -u NODE_ENV timeout 180 node --experimental-strip-types --test "$f"; done
# 기대: 65파일 / tests 671 / pass 665 / fail 6  (= 기준선 6, 테스트명까지 일치)
#   capability withdrawal atomically rolls recovery into a clean legacy generation
#   MIG-BGSTAB-002 drained ordered rollback consumes passive capability without rotating the view
#   REL-BGSTAB-007/012 ordered rollback fences local restore until legacy responder enable
#   PERF-BGSTAB-010 browser ACK is emitted only after an accepted visible terminal write
#   REL-BGSTAB-012 settles ledger and holds stale view through drain
#   frontend and server expose the exact same checkpoint wire declarations
```

⚠️ 신규 `*.test.ts` 는 **`test-runner.ts` 가 디스커버리하지 않는다.**
⚠️ **요약줄 파싱 주의** — node 의 `ℹ pass N` 은 `ℹ` 가 멀티바이트라 `grep "^. pass"` 로 잡히지 않는다. `grep -oE "pass [0-9]+"` 를 쓸 것. 실패가 많은 파일은 요약이 `tail -12` 밖으로 밀려나므로 exit code 와 대조할 것.
⚠️ **실패 *이름* 수집은 카운트만큼 믿을 수 없다** — 위 루프의 `sed -n '/^✖ failing tests:/,$p'` 가 `wsCheckpointProtocol.test.ts` 의 1건을 놓쳐 **6건 중 5건만** 찍었다(3차 세션에 **2회 관측**, 원인 미확인. 같은 파일을 단독 실행하면 정상 출력된다). **항상 `FAIL=` 합계와 이름 개수를 대조**하고, 어긋나면 해당 파일을 단독 실행할 것. 이름 집합 비교가 회귀 판정의 정본이므로 이 누락은 그냥 넘길 수 없다.

---

## 7. 환경

- **2222 에 프로덕션 서버가 살아 있을 수 있다** (Playwright 가 `start.bat` 으로 띄운 것, 회수 안 됨). **고아 워크스페이스 7개**가 남아 있고 `reuseExistingServer:true` 라 다음 E2E 가 그대로 물려받는다
- **`kill` / `taskkill` 절대 금지**
- 셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production` 이 설정돼 있고 **다른 런타임 루트**를 가리킨다. `env -u` 로 제거하고 실행하라
- **`git commit` 시 `git commit -- <경로>`** 로 범위를 못박아라 (공유 워크트리, 미커밋 1,200+ 파일)
- 커밋 메시지에 **어떤 시그니처도 넣지 마라** (CLAUDE.md §6)

### 7.1 C5 착수 실측 — ✅ **완료 (4차 세션). `08` 을 그대로 따르지 마라.**

독립 조사 결과. **`08` 이 지목한 삽입 지점 5개가 전부 틀렸고(일관되게 +6), 그보다 큰 문제는 `08` 이 미래형으로 서술한 C2·C3·C4 가 이미 구현돼 있다는 것**이다.

#### (1) 삽입 지점 — 정정된 참값

| 삽입 대상 | `08`/`03` 이 말한 곳 | **참값** |
|---|---|---|
| control 소켓 `binaryType='arraybuffer'` | `:1201` 직후 | **`:1207`(`const ws = new WebSocket(url)`) 직후.** ⚠️ `:1208-1211` 에 **조기 `return`** 이 있으므로 그보다 앞. `onopen`(`:1215`)·`onmessage`(`:1239`)보다 확실히 앞이다 |
| split output 소켓 `binaryType` | `:1007` 직후 | **`:1013`(`const output = new WebSocket(outputUrl)`) 직후.** `:1014` `outputWsRef.current = output` 과 `:1015` `onmessage` 사이 |
| text/binary 수신 분기 | `:687` 앞 | **`:691`** (`let rawMessage: unknown;` 앞 = `handleMessage` 본문 최상단). `JSON.parse` 는 **`:693`** |
| `onOutput` 시그니처 교체 | `:118` | **불필요 — `:124` 에서 이미 IR 이다** |
| `onOutput` 호출부 | `:592`·`:1140` | **`:598`(grace 재생)·`:1146`(라이브)**, 이미 `fromJsonOutputMessage` 경유 |

지목된 5줄의 **실제 내용**: `:687`=`}, [flushTerminalDeliveryVisibility]);` · `:1007`=`token: tokenStorage.getToken(),` · `:1009`=`metadata: msg,` · `:1201`=`…setSelectedLegacyResponderIdentity(null);` · `:1206`=`const url = getWsUrl();`. `01:976-985` 의 `handleMessage` 스니펫은 **내용은 오늘도 정확**하나 귀속이 `:684-690`→**`:690-696`** 로 밀렸다.

`event.data` 를 읽는 곳은 **`:693` 단 하나**이고 타입 좁히기는 전부 `JSON.parse` **이후**다. `catch { return; }`(`:694-696`)는 **로그 없는 조용한 폐기** — 오늘 ArrayBuffer/Blob 이 오면 정확히 여기로 사라진다. `frontend/src` 전체에 `binaryType` 설정 **0건**(= `08` 의 이 주장은 정확), 두 소켓 모두 기본값 `'blob'`.

#### (2) 🔴 `03:98` 의 두-소켓 서사가 틀렸다 — C5 설계에 직결

**`type:'output'`(=`0x01`)은 split 모드에서도 control 소켓으로 온다.** 근거 체인: 서버 기본은 `unified`(`config.schema.ts:56`)이고 unified 에서는 output 소켓이 아예 생성되지 않는다(`webSocketUrl.ts:69-76` → `WebSocketContext.tsx:1011`). **split 에서도** `routeSessionOutput`(`WsRouter.ts:4969`)은 `sessionSubscribers` 를 순회하는데(`:4975`) 구독 등록은 `handleSubscribe:2578` 뿐이고 프론트는 `subscribe` 를 **control 로만** 보낸다(`:1235`·`:1530`). output 소켓에 가는 것은 **terminal-authority(checkpoint) lane 뿐**(`WsRouter.ts:1112-1115`).

⇒ **`0x01` 을 받는 소켓은 항상 control 이다.** split output 소켓의 `binaryType` 은 `0x04`~`0x07` 를 위한 것이지 `0x01` 을 위한 것이 아니다.

#### (3) 🔴 `08` 의 상태 서술이 통째로 낡았다 — C2·C3·C4 는 이미 구현됨

| `08` 의 서술 | 실제 |
|---|---|
| `enqueueBytes` 신설 필요 (C2) | **완료** — iface `terminalOutputScheduler.ts:280`/`:295`, 구현 `:1403`/`:1503` |
| restore 게이트를 넓혀야 함 (C3) | **완료** — 게이트는 `:488` 로 이동, `isTerminalOutputWriteData(data)` 로 완화됨 |
| 하류 시그니처 `string`→`TerminalOutputWriteData` (C3) | **완료** — `TerminalView.tsx:246`·`:248`·`:1989`·`:2904`·`:2931` |
| IR 신설 + `onOutput` 교체 (C4) | **완료** — `terminalOutputDelivery.ts`(111줄, untracked), `WebSocketContext.tsx:124`, 테스트 11건 |
| `assertContiguousSegments` 추출 필요 | **완료·export 됨** — `visibleOutputRecovery.ts:418-441`, JSDoc 이 *"the binary output adapter can apply the identical invariant"* 를 목적으로 명시 |
| `TerminalContainer.tsx:3192-3443` 핸들러 (252줄) | **`:3191-3419`(229줄)** — ⚠️ **`08` §1.1 의 R1~R6 라인 지도는 전건 무효** |

⇒ **남은 것은 C5 하나다.** `frontend/src/utils/binaryFrameCodec.ts`·`frontend/tests/unit/binaryFrameCodec.test.ts`·`frontend/tests/unit/wsFrameDispatch.test.ts` **셋 다 부재**(= 전부 신설. `08:598` 의 *"S3 에서 신설된 파일 확장"* 은 사실과 다르다). 프론트에 프레이밍 코드는 **0건**이므로 확장할 기존 헬퍼가 없다.

#### (4) 🔴 픽스처에 배열이 **둘**이다 — `08` §5.4 는 하나만 말한다

top-level 6키: `$schemaNote`·`$handComputed`·`$rules`·`defaultContext`·**`vectors`(11)**·**`faults`(44)**(`:1405`). `faults` 는 role 기준 fault 20 / control 24 이고 41개가 `derivedFrom` 패치다. **`vectors` 만 순회하면 코퍼스의 80% 를 놓친다.** `$rules` 는 9키가 맞고(= `08` 정확) `prologueBytes` 는 이제 `{1:24, 2:24, 4:200, 5:12}` 다.

#### (5) `0x01` 만으로 채울 수 없는 IR 필드 — **4개 + 미확인 2**

| IR 필드 | 어디서 와야 하나 |
|---|---|
| `chunk.authorityEpoch`(UUID) | 프레임엔 `authorityEpochIndex`(u16)뿐 → **채널 등록부(index→UUID)** 필요. JSON control 로 도착. **오늘 `frontend/src` 에 `authorityEpochIndex` 0건 — 등록부가 존재하지 않는다** |
| `replayToken` · `repairToken` | JSON control 평면(`screen-snapshot`·`screen-repair`·`session:ready`). `08` §2.2 가 처방한 `liveOutputTokenRef` **미존재** |
| `ack` | `deliverySeq` 가 프레임 헤더에 없다 → `08` §3.3 판정대로 **`undefined`**. `TerminalContainer.tsx:3350` 의 `delivery.ack !== undefined` 분기가 자동 커버 |
| **[미확인]** `chunk.screenSeq` | 프롤로그 `screenSeq` 는 `Ordinal64`(**string**)인데 IR 은 **`number`** 다. **변환 계약이 어디에도 정의돼 있지 않다** |
| **[미확인]** `hasSourceSegments` | `segmentCount === 0` 이 JSON 의 `sourceSegments === undefined` 와 같은 뜻인지 정의 없음 |

#### (6) blast radius — 깨끗한 기준선이 없다

C5 가 만질 **추적 파일 6개 전부**가 대규모 미커밋 델타를 안고 있다: `TerminalView.tsx` **2,868** · `terminalOutputScheduler.ts` **2,058** · `TerminalContainer.tsx` **1,952** · `visibleOutputRecovery.ts` **1,888**(순수 추가) · `WebSocketContext.tsx` **1,154** · `ws-protocol.ts` **1,094**. 합계 **11,014줄, 전부 미스테이징**. 저장소 전체 스테이징 변경 **0건**.

**P2·P3 핀은 이미 stale 이다** — P2 는 프론트 7개 중 **6개 해시 불일치**, P3 의 C5 관련 5개는 **전부 불일치**. 즉 C5 가 red 를 새로 만드는 것이 아니라 **이미 red 인 상태에 들어간다**. (P3 의 red 경로는 `--expect-red` 에서만 도달 — `08` §7.2 판정 정확.) P2 목록 `canary-admission-evidence.test.mjs:37-56` 18개는 `08` 주장과 **완전 일치**, P3 `redFrontendSourceBaseline` 은 `:129-141`(`08` 은 `:129-140`, **+1 오류**).

⚠️ **HEAD 가 baseline 기록(`eb2f4f8`)보다 1커밋 앞서 있다** (현재 `dfca40c`). 그래서 `WsRouter.ts`·`wsSendPolicy.ts` 는 이제 clean 이고, `frontend/tests/unit/` 는 disk 65개 / HEAD 추적 43개 / baseline 측정 56개로 셋이 전부 다르다. **프론트 기준선(`612 tests / fail 7`)은 같은 워킹트리에서만 유효하다** — baseline 문서 스스로 그렇게 명시한다.

### 7.1a C5-a 검증 — 교차 차분이 가장 강한 증거였다

서브에이전트 검증자가 네 번 유휴로 들어가고도 보고 텍스트를 반환하지 않아, **읽어서 비교하는 대신 두 구현에 같은 바이트를 넣고 출력을 대조**했다. 하네스: `scratchpad/differential.mts` (동적 import 로 서버·프론트 코덱을 함께 로드, `npx tsx` 로 실행 — 스크래치패드에 `type:module` 이 없어 `.ts` 는 CJS 로 잡히니 **`.mts` 확장자가 필요**하다).

**입력 9,074건 · 발산 0.** 구성: 골든 벡터 11개 · fault/control 44개 · **모든 벡터의 전 바이트를 9가지 적대적 값(`00 01 02 08 09 0b 7f 80 ff`)으로 치환** · 각 벡터를 0~64바이트로 절단. 비교 대상은 `fatal`·`scoped`(코드·등급·channelId)·`diagnostics`·프레임별 헤더 6필드·**payload 바이트 전체**·프롤로그 값과 **키 집합**·세그먼트 배열·본문 바이트.

프롤로그 **키 집합**을 비교에 넣은 것이 요점이다 — `responderLeaseId` 의 *"키 부재"* vs *`''`* 구분이 값 비교만으로는 잡히지 않는다.

⚠️ **차분은 "일치"를 증명하지 "정확"을 증명하지 않는다.** 두 구현이 같은 오독을 공유하면 사이좋게 틀린다. 그 축을 막는 것은 **손계산 골든 벡터**(사양 표에서 유도, 인코더 덤프 아님)이고, 그것도 비교 집합 안에 있다. 두 축이 함께 있어야 의미가 있다.

### 7.1b 🔴 `01:544` 의 규칙이 틀렸다 — 개정 R2 로 닫음 (C5-e 중 발견)

원문: *"디코더는 `segmentCount === 0` 이면 `chunkIdBase` 를 chunkId 로 해석하지 않는다"*. **그대로 구현하면 정상 출력이 전부 버려진다.**

연쇄: 통상 프레임은 chunkId 를 갖고 세그먼트는 **없다** — 즉 `segmentCount === 0` 이 정상 상태다 → 규칙이 매 프레임의 chunkId 를 지운다 → 클라이언트가 chunkId 없는 청크를 **거부**한다(`visibleOutputRecovery.ts:1419-1422`) → 화면에 아무것도 안 그려진다.

**정본 규칙 (R2)**: 부재는 **`chunkIdBase = 0` 으로만** 표현하고 `segmentCount` 와 무관하다. `chunkIdBase !== 0` 이면 그것이 chunkId 다. 0 이 모호하지 않은 이유는 발급기가 `(prev ?? 0n) + 1n` 로 세어(`WsRouter.ts:3642-3646`) **0 을 절대 내지 않기** 때문이다 — 원판이 찾던 판별을 세그먼트 수가 아니라 **값 자체**가 제공한다. 세그먼트가 있는데 base 가 0 이면 세그먼트 identity 가 유도 불가이므로 **타일링 실패**로 처리한다(빈 `chunkId` 를 `assertContiguousSegments` 가 이미 거부하므로 새 규칙을 만들지 않았다).

`01` 은 **1622줄 유지 · 전 hunk 1:1**, R2 가 인용한 앵커 6개 기계 대조 통과. 뮤턴트 `A2`(원 규칙을 그대로 적용)가 테스트에 **KILLED** 되는 것으로 회귀 방어를 확인했다.

⇒ **교훈: 사양의 "이 경우엔 읽지 마라" 류 규칙은 그 경우가 얼마나 흔한지부터 세어라.** 여기서는 예외 조건이 실은 정상 경로 전부였다.

### 7.2 C5 잔여 — 배선 (다음 세션)

**C5-a(프론트 코덱)는 끝났다.** 남은 것은 그것을 실제 소켓에 붙이는 일이다.

| 단계 | 내용 | 상태 |
|---|---|---|
| **C5-b** 수신 분기 | `binaryType='arraybuffer'` 를 **`:1207` 직후**(control, 조기 return 앞)와 **`:1013` 직후**(split output). `handleMessage` **`:691`** 에 ArrayBuffer/Blob 2단 분기. 오늘 `catch { return; }`(`:694-696`)가 바이너리를 **로그 없이 삼킨다** | 미착수 |
| **C5-c** 채널 등록부 | `authorityEpochIndex`(u16) → `authorityEpoch`(UUID) 매핑. JSON control 로 도착(`SubscribedSessionInfo` `01:374-385` / `terminal-binary:capability.channels[]` `01:725-737`). **`frontend/src` 에 `authorityEpochIndex` 0건 — 통째로 신설** | 미착수 |
| **C5-d** 토큰 ref | `replayToken`/`repairToken` 은 프레임에 없다. `08` §2.2 가 세션 스코프 ref(`liveOutputTokenRef`)를 처방했고 **아직 없다** | 미착수 |
| ~~**C5-e**~~ `fromBinaryOutputFrame` | ✅ **완료.** `terminalOutputDelivery.ts` 에 `BinaryOutputIdentity`(호출자가 주는 3필드) + 어댑터. `assertContiguousSegments` 재사용, `ack` 는 `undefined`, 본문·세그먼트 모두 **뷰**로 전달(복사 0), `previewText` 지연. 테스트 15건 · 뮤턴트 **14/15 KILLED**(생존 1은 등가 확인) | ✅ |

✅ **[미확인] 2건 — 4차 세션에 실측으로 판정. 근거를 같이 남긴다.**

**(1) `screenSeq` 의 Ordinal64 → number: 어댑터에서 좁히고, safe-integer 밖은 계약 위반으로 올린다.**

근거: 이 값은 **원천이 이미 JS `number`** 다 — `SessionManager.ts:810` `screenSeq: number`, JSON 와이어도 `ws-protocol.ts:718` `screenSeq?: number`. 바이너리 프롤로그가 u64 로 **넓힌** 것이지 원래 64비트였던 적이 없다. 따라서 `Number(str)` 는 정상 트래픽에서 무손실이다.

⚠️ **좁히기는 코덱이 아니라 어댑터에 둔다.** 코덱은 와이어의 사실(`Ordinal64` 문자열)을 그대로 보고하고, `number` 타입 IR 을 만드는 `fromBinaryOutputFrame` 이 좁힌다 — 계층이 그렇게 갈린다. `Number.MAX_SAFE_INTEGER` 를 넘는 값은 **반올림하지 말고** 오류로 올릴 것: 조용히 반올림하면 `chunkId` 중복제거 키가 어긋나 화면이 틀어진다. 코덱에 `0x01` 도메인 검사를 새로 만드는 것은 **하지 말 것** — `07 §2.11` 은 `0x04` 만 규정하므로 사양 변경이 된다.

**(2) `segmentCount === 0` ⟹ `hasSourceSegments: false`, `chunks: [whole]`. JSON 과 정확히 등가다.**

근거: **JSON 생산자도 빈 배열을 내보내지 않는다** — `wsSendPolicy.ts:122` 가 `...(sourceSegments && sourceSegments.length > 0 ? { sourceSegments } : {})` 이고 coalesce 경로(`:278`)도 같다. 즉 JSON 와이어에서도 *"부재"* 와 *"있지만 빈 배열"* 은 이미 구별되지 않는다. 바이너리 인코더는 `segments.length` 를 그대로 싣는다(`binaryFrameCodec.ts:593`). ⇒ 두 표현이 같은 뜻이라는 것이 **정의가 아니라 실측 사실**이다. IR 쪽 대응은 `terminalOutputDelivery.ts:101` 의 `hasSourceSegments: sourceSegments !== undefined` 와 `:95` 의 `chunks = [whole]`.

⚠️ **C5 를 다 해도 end-to-end 로는 아무것도 흐르지 않는다.** 서버가 바이너리를 보내려면 **S4-a(서버 인코드 표면) + D10 협상 메시지 5종 + `realtime.terminalWireFormat` 설정키**가 필요한데 셋 다 미착수이고, `08` 은 S4-a 를 **명시적으로 범위 밖**으로 뒀다. 즉 C5-b~e 는 *수신 준비*이고 관측 가능한 동작 변화는 S4-a 이후에 나온다 — 그때까지 검증 수단은 골든 벡터와 단위 테스트뿐이다.

---

## 8. 미해결 (사용자 결정 대기)

1. ~~`@xterm/headless` devDependency~~ — **승인·완료.** `frontend/package.json` +1 / `package-lock.json` +11. 현행 결함 여부도 판정됐다: **메커니즘 실재, 도달 불가** (§4 C1 결과 + Arm C)
2. **GitHub 이슈 갱신** (Q5 승인됨, 미실행) — ⚠️ **"9건" 이라는 수의 근거를 찾지 못했다.** 3차 세션 실측:
   - 폐기된 측정 게이트를 **본문에서 실제로 언급하는 이슈는 4건**이다: `#19`(14회) · `#20`(10회) · `#21`(1회) · `#22`(1회). `#15`~`#18`·`#23` 은 0회. 특히 **`#19` 는 제목 자체가 "split/binary data plane 측정 gate와 조건부 도입"** 이라 본문 코멘트만으로는 해소되지 않는다
   - **`06` §3.5 Q6 의 "`docs/issues/` 는 git 미추적" 은 틀렸다.** 실측 **추적 3 / 미추적 5** 이고, 하필 게이트를 담은 `19-binary-data-plane.md`·`20-consumer-rollout-tracker.md`·`21-default-flip.md` **3개가 추적 대상**이다. Q6 의 "삭제 시 복구 불가" 논거는 그 3개에는 적용되지 않는다(결론 "삭제하지 않음" 자체는 다른 근거로도 유지 가능)
   - **집행하지 않았다** — 승인된 것은 *행위 유형*이고 **대상 집합과 문안이 정의된 적이 없다.** 공개 저장소 쓰기이므로 대상 4건 + 문안을 확정한 뒤에 진행할 것. 계획의 지침은 "코멘트 우선·본문 최소 변경"(`06:524`)
3. **P2 재발행** — 여전히 보류. 계획은 C2 후 `node tools/wave3/canary-admission-evidence.test.mjs --regenerate-green` 을 요구하지만, P2 는 **18개 파일**(11개가 server)을 동결하고 **12개가 이미 남의 미커밋 작업으로 dirty** 다. P5(전부 untracked, 3파일)와 달리 **남의 서버 작업까지 frozen 증거로 certify** 하게 된다 — `06` §S1 M-1 이 경고한 그 상황. 사용자 결정 필요.
   ⚠️ 3차 세션이 **`terminalDebugCapture.ts` 를 새로 dirty 로 만들었다** — P3(`authority-promotion-evidence`) 핀 목록에 있으며 C0~C4 는 건드리지 않던 파일이다. `TerminalContainer.tsx`(P2·P3)는 이미 dirty 였다. **재발행은 하지 않았다** — 위 결정이 나오기 전이므로
4. ~~`IR-BGSTAB-001` 상태~~ — **완료 (3차 세션).** `planned` → `in_progress`, 증거 2건(VE-1 코덱 테스트 / VE-2 골든 벡터) 첨부. **`covers` 는 AC-1·AC-2 로만 한정**했다 — 나머지 10개 AC(협상·설정키·runtime-config·롤백 수렴·`encodedBytes` 도메인)는 미착수라 덮이지 않는다. **AC 체크박스는 체크하지 않았다** — AC-1 의 "수신측 복원" 은 프론트 디코더(C5)가 나와야 완결된다. 증거 첨부 전 78/78·13/13 을 직접 실행해 확인했다. 타깃 진단 기준선 불변(error 1 / warning 5, 동일 코드)
5. ✅ **`0x05` CHECKPOINT_CHUNK — 차단 해소. `0x04` 프롤로그를 구현했다** (§4 참조).

   경위: 상속안을 "해소" 로 기록 → 독립 검증에서 **CRITICAL** 로 뒤집힘(`0x04` 에 `responderLeaseId` 자리 없음) → **`0x04` 프롤로그를 160 → 200 B 로 재설계하고 구현**하여 닫았다.

   **구현 완료 (3차 세션, `server/src/ws/` — HEAD 대비 clean 이고 어느 핀에도 없어 단독 커밋 가능)**:
   - `prologueBytes(0x04) = 200` 상수 · `CheckpointStartPrologue`(24필드) · `CheckpointStartWireMessage` · union 확대
   - `writePrologue`/`parseFrameMessage` `0x04` 분기 · `encodeResponderLeaseId`(presence bit ↔ 필드 상호검증)
   - 신규 거부 코드 **`prologue-domain-violation`**(scoped — `frameEnd` 는 이미 신뢰 가능하므로 배치 나머지는 산다) + `checkpointStartPrologueViolation` 7절
   - **손계산 골든 벡터 2개** — `checkpoint-start-rollback-228`(bit2 + bit4) / `checkpoint-start-promotion-228`(둘 다 clear). 인코더 출력을 덤프하지 않고 §2.9 표에서 직접 유도했다(`07:156`)
   - 핀 2개 갱신: `binaryFrameCodec.test.ts` 의 프롤로그 크기표와 거부 코드 인벤토리

   🔴 **4차 세션 독립 검증 = REJECT. 전건 수정했다 — 아래를 먼저 읽어라.**

   검증자(뮤턴트 20개 실행, 6개 생존)가 낸 것과 처리 결과:

   | 등급 | 내용 | 처리 |
   |---|---|---|
   | **CRITICAL** | `prologueBytes(0x04)=200` 인데 **SSOT 인 `01 §1.8` 은 160 인 채로 남았다**(`01:578`·`:582`). `01:568-571` 이 *"`01 §1.8` 이 유일 정본 · `07` 은 동결 부속서라 in-place 개정 금지 · 충돌 시 `01` 이 이긴다"* 를 선언하는데, 변경은 정확히 금지된 방식을 택했다 | ✅ **`01 §1.8` 에 개정조항 R1 을 적어 닫았다** — 이것이 `01:570` 이 지정한 유일한 개정 경로다. `06`:552·1328·1538 도 정정. **`07` 본문은 더 건드리지 않았다**(동결 존중) — R1 이 *"`07` 에 남은 160 은 stale, `01` 이 이긴다"* 를 명시 |
   | **HIGH** | `07 §2.11` 이 규정한 도메인 검사 **8종 중 5종 미구현**. `chunkCount=0`·`cols/rows=0`·`retainedActiveBuffer>1`·`modesValueMask & ~modesPresentMask`·bit0 교차검사가 전부 통과했다 | ✅ 구현 (TDD) |
   | **HIGH** | presence bit ↔ 필드 교차검사가 **bit4 에만** 있다. bit0/1/2/3 은 양방향 불일치해도 수용. 특히 `boundarySourceSeq` 는 lease 와 **동일한 present/absent 분포**이고 클라이언트가 한 줄 차이로 똑같이 엄격 비교한다(`terminalCheckpointRuntime.ts:522` vs `:523`) | ✅ 구현 (TDD). §2.9 가 각 필드에 *"bit N = 1 일 때만 유효"* 를 명시하므로 **사양 내 구현이지 확장이 아니다** |
   | **HIGH** | `presentButEmpty` 테스트가 **공허**했다 — byte 160 만 0 으로 만들고 lease 바이트를 남겨 **padding 절이 대신 발화**. 자기 이름의 절을 지우면 그대로 통과(M3 SURVIVED) | ✅ 슬롯 전체를 0 으로 채우도록 수정. M3 재실행 **KILLED** |
   | MEDIUM | 인코더 가드 3종 무테스트(flags2 예약 단언 · `assertDigest32` · 빈 lease) — 전부 SURVIVED | ✅ 테스트 추가. M14·M15·M18 재실행 **전부 KILLED** |
   | MEDIUM | 프롤로그 **9필드가 0 이 아닌 값으로 실린 적이 없다** → 오프셋·폭·엔디안 미핀. 인코더가 9개를 전부 상수 0 으로 써도 스위트 통과(M13 SURVIVED) | ✅ 전 필드를 **서로 다른** 비영값으로 왕복하는 테스트 추가(쌍 뒤바뀜도 잡힌다). M13·M13b·M13c **전부 KILLED** |
   | MEDIUM | `07` 자기모순 — `§2.11:495` 는 `0xFFF0`, `§2.6.1:339` 는 `0xFFE0`. 코드는 `0xFFE0` | ✅ R1 이 `0xFFE0` 을 정본으로 명시 (`07` 은 동결이라 미편집) |
   | MEDIUM | `07` 9곳 + `06` 2곳에 160 잔존 | ⚠️ `06` 은 정정. **`07` 은 미편집** — R1 의 stale 고지로 처리. 목록: `07`:17·431·435-483(§2.10 `checkpoint-start-188` 예제 전체)·489·490·723·962·1011·1054 |
   | LOW | 38 B 상한이 **단일 생성지점**에서만 유도된다. `Adapter.ts:2155` 가 `responder-browser-${epoch}-runtime-${N}`(≥48 B)를 만든다 — 오늘은 와이어에 안 닿지만 **핀하는 테스트가 없다** | ✅ **등급 확인 후 처리.** 호출그래프 실측: `nextCompatibilityResponderLeaseId` 의 생산자는 **`Adapter.ts:4442` 단 하나**이고 그것은 접미사 **없는** `:4435` 형태를 쓴다 → `:2155` 의 `-runtime-N` 형태는 이 경로로 흐르지 않는다. 상한 **유도**를 핀하는 테스트 추가(`18 + 20 === 38`, 접미사형이 상한 초과 + 인코더가 실제로 거부). 뮤턴트 M23(상한 32) **KILLED** |
   | LOW | 픽스처 `$handComputed` 가 `0x04` 벡터 2개의 출처(`07 §2.9`/`§2.6.1`)를 미기재 | ✅ 기재. 아울러 **flags2 가 어느 오프셋을 유의미하게 만드는지**가 벡터 유효성의 일부임을 명시 |

   🔴 **검증자도 놓친 것 — 골든 벡터 2개가 스스로 사양을 위반하고 있었다.** 검사를 구현하자 `checkpoint-start-rollback-228` 이 즉시 red 가 됐다. 두 벡터 모두 **flags2 bit0(`RETAINED_STATE_PRESENT`)이 clear 인데 off 128 `retainedStateDigest` 가 32×0x22** 였다 — §2.9:415 는 *"bit0 = 1 일 때만 유효"* 로 규정한다. 검증자는 벡터를 레이아웃 표의 **오프셋·폭·엔디안**에 대해서만 대조했고 **flags2 presence 의미론**은 대조하지 않았다. 수정: rollback 은 bit0 을 세우고(`0x0014`→`0x0015`, retained state 를 싣는 것이 실제 동작), promotion 은 off 128 을 전부 0 으로. `hexFrame` 은 **layout 행에서 재조립**했다(인코더 덤프 아님, `07:156`).

   ⇒ **교훈: "벡터가 레이아웃 표와 일치한다" 는 "벡터가 유효하다" 가 아니다.** 표는 오프셋을 규정하고 flags2 는 어느 오프셋이 유의미한지를 규정한다. 둘을 따로 검사해야 한다.

   **재검증 (뮤턴트 9개, 전부 KILLED)**: M3(zero-length lease) · M13/M13b/M13c(인코더 상수 0) · M14(flags2 예약 단언) · M15(`assertDigest32`) · M18(빈 lease 가드) · M21(`chunkCount` 절) · M22(boundary presence 절). 각 뮤턴트마다 적용 → 실행 → 원본 복원, 최종 sha256 **바이트 동일** 확인. ⚠️ **첫 하네스는 고장나 전부 "SURVIVED" 로 보고했다** — `execFileSync` 가 Windows 에서 `npx` 를 못 띄워 카운트 파싱이 `undefined` 였다. **파싱 실패를 생존과 구별하는 분기**를 넣고 뮤턴트 없이 baseline 을 먼저 파싱해 하네스를 자가검증한 뒤 다시 돌렸다. 이것을 못 봤으면 §5.2 에 25번째 항목이 생겼다.

   **검증 (4차 세션 최종)**: `binaryFrameCodec.test.ts` **89/89 · fail 0 · todo 0**(신규 5건), 서버 `tsc` exit 0, sidecar 13/13, 모놀리식 러너 **21 fail = 기준선**. 뮤턴트 **10/10 KILLED**(M3·M13·M13b·M13c·M14·M15·M18·M21·M22·M23), 복원 sha256 바이트 동일.

   ⇒ **검증자의 REJECT 사유는 전건 해소됐다.** 미처리로 남은 것은 `07` 본문의 stale `160` 9곳뿐이고, 그것은 **동결 부속서를 in-place 개정하지 않기 위해 의도적으로 남긴 것**이다 — `01 §1.8` 개정 R1 이 stale 임을 고지하고 `01:571` 이 충돌 시 `01` 을 이기게 한다.

   <details><summary>3차 세션 시점 기록 (원본 보존)</summary>

   **검증**: `binaryFrameCodec.test.ts` **84/84**(신규 6건 포함), 서버 `tsc` exit 0, 모놀리식 러너 **21 fail = 기준선**, sidecar 13/13. 벡터가 실제로 검사되는지 **뮤턴트로 확인** — lease 바이트 한 니블만 뒤집어도 독립 출처 검사 3개(layout↔hexFrame 자가감사 / `encode===hexFrame` / `decode===message`)가 전부 죽는다. `binaryFrameCodec` 은 자기 테스트 외 import 0 이라 blast radius 가 없다.

   </details>

   **진짜 해야 할 일 (재정의)**:
   - ✅ **(a) `0x04` 에 `responderLeaseId` 를 싣는 설계** — **3차 세션에 완료.** 160→200 B, off 160 `length` uint8(0..38) + off 161 raw 39 B + `flags2` bit4. `prologueBytes(0x04)` 상수 200 이라 순수성 불변식 유지. 기존 골든 벡터 재계산 **0**, 신규 2개. 상세는 §4
   - ✅ **(b) `07` §3.3 상속 목록에 `responderLeaseId` 등재** — **3차 세션에 완료.** 그 목록에 없던 이유는 §2.6 이 이 필드를 "인코더가 거부" 로 처분하며 분류에서 뺐고 §2.6 폐기가 공백을 남겼기 때문이다. 행을 추가하고 **빠뜨렸을 때의 실패 모드(모든 rollback chunk fail-closed)를 그 행에 적어** 두었다. `terminalCheckpointRuntime.ts:507-524` 는 무변경
   - ✅ **(c) 핀된 단언 처리** — **완료.** 구현과 같은 단위로 갱신했다: 프롤로그 크기표는 `0x04` 를 0-목록에서 빼고 `200` 을 단언, 거부 코드 인벤토리는 `prologue-domain-violation` 과 그 scoped 등급을 추가. 나머지 5건(`TerminalAuthorityController.test.ts:8255-8269`·`:8300-8307`, E2E 3건)은 **코덱 상류이거나 C→S JSON 경로**라 무영향
   - ✅ **(d) `0x06` 의 `boundarySourceSeq` 처분** — **3차 세션에 판정: `07:313` 은 과잉 정정.** 상속 목록에 유지하고 `0x06` 은 88 B 유지. 근거: `Controller.ts:1592-1593` 이 start·chunk·commit 전 원소에 **같은 값**을 주입하므로 독립 슬롯을 둬도 두 피연산자의 출처가 여전히 같아 검사가 강해지지 않는다. `07` §2.6.2 에 기록

   ⚠️ **`01`/`07` 의 *레이아웃 표* 개정은 구현보다 먼저 하지 마라** (분류·정정은 이미 반영했다 — §2.6.1/§2.6.2/§3.3). `07:570` 이 개정 경로를 `01 §1.8` 로 규정하므로 순서상 문서가 먼저인 것처럼 보이지만, **이 저장소는 스펙과 코드가 어긋났을 때의 피해를 이미 세 번 보여줬다**(§8 항목 8 의 내용 오류 3건 — 전부 S1 이후 서술 미갱신). 레이아웃은 손계산 벡터가 맞아떨어질 때 비로소 확정된다. **구현·벡터·문서를 한 커밋에 묶을 것.**

   구현 체크리스트:
   1. **실패 테스트 먼저 — F1(상수성)** 부터. `TerminalAuthorityController.test.ts` 의 롤백 하네스에서 enqueue 된 **모든** 메시지의 두 필드가 동일함을 단정. ⚠️ **경계 대조군 필수** — 원소 하나의 값을 바꿔 red 를 확인할 것. 하네스가 배열을 통째로 공급하므로 대조군 없이는 공허 통과한다
   2. `0x05`/`0x06` 인코더 단언(도착한 값이 트랜잭션 start 와 다르면 `RangeError`) — 테스트 먼저
   3. `01 §1.8` 개정 (SSOT 이므로 `07` 보다 **먼저**) — `0x05` 절 + 7종 불변식 + §1.9 "프레임에 넣지 않는 것" 표
   4. `07` 은 **배너만** 추가하고 본문 재작성 금지 (`01:570` 이 개정 경로를 `01 §1.8` 로 규정)
   5. `06` 의 D15·S4-0b 관련 5곳 + `0x01` 신규 행
   6. **그 다음에** `0x01` 처분 — 별개의 blast radius다
   ⚠️ **손대면 안 되는 것**: `binaryFrameCodec.ts:108-118`·`:333-337`·`:512-518`, `parseFrameMessage` 의 `0x05` 분기, `binary-frame-vectors.json`, `binaryFrameCodec.test.ts:743-747`. 이들을 바꾸자는 제안이 나오면 권고안을 잘못 적용한 것이다

6. ~~`07` §2.6 폐기 + §9 항목 1·3·5 판정 반영~~ — **완료.** `07` §2.5 · §2.6 · §6.4 · §9 에 판정과 근거를 반영했고 오인용 4건(`:1667`·`01:426`→`:466`·`01:311-320`→`:344`/`:346`·`WsRouter.ts:2396-2399`→`:2400`)도 정정했다
7. ~~EOL 테스트 수정 승인~~ — **완료 (3차 세션).** needle 3곳을 EOL 무관 헬퍼 하나(`indexOfCheckpointAuthorityGuard`)로 통합했다. 일괄 정규화(`replace(/\r\n/g,'\n')`)는 **택하지 않았다** — 다른 어서션의 고정폭 `slice` 창이 함께 넓어져 무관한 테스트의 결과를 바꿀 수 있다. 파일에 `\r` 의존 어서션이 0건임을 먼저 확인했고, 새 패턴이 `TerminalContainer.tsx` 에서 **단일 지점(line 2706)** 에만 매치함을 실측했다. 가드 없던 앵커 1곳에 `notEqual(-1)` 도 추가. 결과: 이 파일 `pass 58 / fail 1`(기준선 #4), 전수 `fail 6` = 기준선 6건과 **테스트명 집합 일치**
8. **`06-work-plan.md` 의 `wsSendPolicy.ts` 인용** — 등록 표 몫은 ✅ **완료 (3차 세션, 23줄)**. 미등록 몫과 **내용 오류 2건**은 남아 있다.

   **완료된 것**: 등록 표(`06:637-644`)가 지정한 stale form 이 동결 구역 밖에 **0건** 남았다. 동결 구역(`06:633-646` 정정 표, `06:2467-2612` §14) **hunk 0건**으로 보존 확인. 표에 없던 세 번째 사이트 `06:1889`(`FairTerminalDeliveryPolicy` `:518`→`:526`, `FairTerminalDeliveryPolicyValue` `:513`→`:521`)도 함께 정정 — **이것이 트랩의 순수형**이다: *정책 인터페이스*를 뜻하는 `:518` 과 `encodedBytes` 의 *정답*인 `:518` 이 같은 문서에 공존한다. `06:32`·`:1762` 의 `:518-528`(9필드 인터페이스)도 실은 같은 +8 계열이라 **`:526-536`** 으로 정정했다(실측: `:526` 선언 + 9필드 + `:536` 닫힘).

   ✅ **내용 오류 — 4차 세션에 정정 완료. 그리고 3건이 아니라 더 컸다.**

   뿌리는 기록대로 하나다: **S1 이 payload 필드를 사이드카로 승격해 재파싱이 사라졌는데 `06` 은 pre-S1 세계를 서술했다.** 다만 3차 세션은 §1.4 표의 **1행만** 틀렸다고 기록했는데, 4차 세션 실측 결과 **5행 전부 틀렸다.**

   | 실측 (4차 세션, 직접 확인) | 값 |
   |---|---|
   | `wsSendPolicy.ts` 의 `JSON.parse` | **0건** |
   | `wsSendPolicy.ts` 의 `Buffer.concat` | **0건** |
   | `WsRouter.ts` 의 `JSON.parse` | **`:1746`·`:2554` 2곳뿐, 둘 다 ingress** |
   | ⇒ `JSON.parse(message.payload)` 로 **라우팅 결정**을 내리는 지점 | **0곳** (문서 주장: 5곳) |

   5행의 실체: `hasFairDeliveryIdentity` → `:296-300` 사이드카 3필드 `!== undefined` 논리합 · `:5535` → `:5533`+`:5537` 사이드카 · `:5564` → `:5559-5561` 사이드카 · `:6396` → `:6394-6399` 정의, 사이드카 3필드 · **`:5846` 은 빈 줄**이고 `createFairDeliveryWireMessage`(`:5820-5845`)가 `delivery.*` 로 조립, dataGap 갈래는 `:5826` `...delivery.payloadFields` 스프레드.

   정정 방식: **표를 지우지 않고 "S1 이 무엇을 없앴는지의 기록" 으로 재구성**했다(각 행에 오늘의 실체를 병기 + "이 표를 근거로 S5-a0 에서 재파싱 방어를 설계하지 말 것" 명시). 살아남은 작업은 **S3 의 ingress 확장 하나**뿐이며 그 앵커도 정정했다(`handleMessageError` `:2534`→**`:2535`**, 호출 `:2538`→**`:2539`**, `tryParseRawMessage` `:2551`→**`:2552`**, `JSON.parse` `:2553`→**`:2554`**). ⑤(`:216`→**`:226`**, `Buffer.concat` 주장 철회)·⑦(`:6396`→**`:6394-6399`**, `JSON.parse` 주장 철회)·`:5842-5850`(→**`:5820-5845`**) 도 함께 정정.

   ✅ **동결 구역 침범 0건** — HEAD 대비 hunk 29개를 원본 좌표로 대조해 `06:633-646`·`06:2467-2612` 에 시작하는 hunk 가 없음을 확인.

   🔴 **그리고 같은 화석이 SSOT 인 `01` 에도 있었다 — `01` §3.6 "서버측 JSON 역파싱 지점". 함께 정정했다.**

   그 절의 `[설계결정]`(*"payload 역파싱을 전부 제거하고 3개 필드를 1급으로 승격한다"*)은 **S1 이 이미 집행한 것**인데 절 전체가 미집행인 것처럼 서술돼 있었다. 4행 전부 실체를 병기하고, 살아남은 것이 `tryParseRawMessage`(ingress, S3 소관) **한 행뿐**임을 명시했다. 사이드카 확정 목록도 기록했다 — `createWsTransportMessage`(**`wsSendPolicy.ts:85-135`**)가 `record` 에서 올리는 **13개**(기존 10 + S1 이 추가한 `connectionEpoch`·`deliverySeq`·`deliveryKind`), `metadata` 출처 7개는 별도.

   ⚠️ **줄 수 중립으로 편집했다 — 이것이 이번 세션에서 배운 것이다.** 처음에 자연스럽게 고쳤더니 `01` 이 1622→1632 줄이 되면서 **하류 앵커 23개(`01:1128`~`:1448`)가 통째로 +10 밀렸다.** 그 23개는 이미 stale 인 것과 정확한 것이 섞여 있어 일괄 +10 은 정확한 것을 망가뜨린다(§5.4 의 그 함정). **되돌리고 정확히 같은 줄 수(10줄)에 다시 넣었다** — `git diff -U0` 이 전 hunk `-N +N` 1:1 치환임을, 그리고 파일이 1622줄을 유지함을 확인했다.

   ⇒ **규칙: 널리 인용되는 문서의 본문을 고칠 때는 줄 수를 바꾸지 마라.** 못 맞추면 밀린 앵커를 전수 재검증해야 하고, 그 비용이 정정의 이득보다 크다.

   부수 소득: `createFairDeliveryWireMessage` 가 **세 필드 없는 closed list** 라는 사실을 이 정정 과정에서 코드로 재확인했다 — §8 항목 10 이 요구한 *"무조건 발화하는 근거"* 가 바로 이것이다. 사이드카 13개 목록에도 셋이 **없다**는 것이 두 번째 독립 근거다.

   <details><summary>정정 전 3차 세션 기록 (원본 보존)</summary>

   | 위치 | 문서의 서술 | 실측 |
   |---|---|---|
   | `06:120-124` §1.4 | *"`JSON.parse(message.payload)` 로 **라우팅 결정**을 내리는 지점 — 전수 확인 결과 **5곳**"* 이라며 첫 행에 `hasFairDeliveryIdentity` 를 올림 | **`wsSendPolicy.ts` 에 `JSON.parse` 가 0건이다.** `hasFairDeliveryIdentity`(`:296-300`)는 사이드카 3필드의 `!== undefined` 논리합일 뿐 파싱하지 않는다 → **그 행은 표에서 빠져야 하고 "5곳" 은 4곳이다.** 부수적으로 `:288`→`:296`, `` **`true`**(`:293`) `` 는 무조건 리터럴이 아니다 |
   | `06:1552` ⑤ | `` `wsSendPolicy.ts:216` `tryCoalesceOutputMessage` `` 를 *"JSON 재생성 → `Buffer.concat`"* 이라 설명 | **`Buffer.concat` 이 파일 전체에 0건이다.** 함수는 `:226` 이고 `existing.outputData` 등 사이드카를 비교·결합한다 → **설명 자체가 pre-S1 세계다** |
   | `06:1560` §5 S4-a | `` `WsRouter.ts:5846` `` 의 `...JSON.parse(delivery.payload)` 를 인용 | **그 코드가 존재하지 않는다.** `WsRouter.ts` 의 `JSON.parse` 는 `:1746`·`:2554` **2곳뿐이고 둘 다 인바운드**다. `:5840-5844` 는 `createFairDeliveryWireMessage` 가 `delivery.*` 필드로 객체를 조립할 뿐 파싱하지 않는다 |

   </details>

   **왜 중요했는가**: §1.4 는 *"바이너리에서의 실패 방향"* 을 예측하는 표다. 전제(payload 재파싱)가 이미 사라졌는데 표가 남아 있으면 **S5-a0 담당자가 존재하지 않는 위험을 막으려 한다.** ⇒ 그래서 표를 지우는 대신 **전제가 사라졌음을 표 안에 명시**했다.

   **미등록 stale 줄번호**(문서 에이전트가 실측했으나 위임 범위 밖이라 미수정): `:91`/`:95`→`:96`/`:100` (8곳), `:701`·`:702-703`·`:716-717`·`:738`·`:758`→`:709`·`:710-711`·`:724-725`·`:746`·`:766`, `:85-131`→`:85-135`, `:757`→`:765`, `:599-609`→`:607-617`, `:706-712`→`:714-720`, `:775`~`:899` 계열. `06:745` 의 `:251-258`/`:297-319` 는 앵커가 모호해 **재도출 필요**
9. 🔴 **이 세션 작업의 커밋 — 현 상태로는 안전하지 않다 (3차 세션 실측, 이전 지침 정정).**

   이전 판은 *"공유 워크트리이므로 `git commit -- <경로>` 로 범위를 못박을 것"* 이라 했다. **그것으로는 부족하다.** 경로 지정은 *다른 파일*이 섞여 들어오는 것만 막고, **같은 파일 안의 남의 헝크**는 막지 못한다. HEAD 대비 실측:

   | 파일 | HEAD 대비 | 이 작업의 몫 |
   |---|---:|---|
   | `frontend/tests/unit/terminalContainerRecoveryContract.test.ts` | **+1788 / -4** | 앵커 정정 ~20줄 |
   | `frontend/src/utils/visibleOutputRecovery.ts` | **+1888 / -0** | `assertContiguousSegments` 추출 수십 줄 |
   | `frontend/tests/unit/terminalViewRecoveryContract.test.ts` | **+679 / -0** | 앵커 가드 몇 줄 |
   | `frontend/src/utils/terminalDebugCapture.ts` | **+121 / -3** | `rawPreview` 확대 ~4줄 |
   | `frontend/src/utils/terminalHiddenOutput.ts` | +12 / -4 | 사실상 전부 |

   즉 이 파일들을 그대로 커밋하면 **남의 미완성 작업 수천 줄을 이 작업의 커밋 메시지로 기록**하게 된다.

   또한 `git status` 의 `M`/`??` 목록에는 **이 작업이 만지지 않은 파일이 다수 섞여 있다** — 예: `terminalHiddenOutput.test.ts`·`runtimeConfig.test.ts`·`terminalOutputScheduler.test.ts`·`useTerminalRuntimeResidency.test.ts`(수정), `terminalClipboard*`·`terminalQueryReply`·`terminalReplayGuard`(미추적). 파일 목록을 눈으로 훑어 고르면 반드시 섞인다.

   **선행 조건**: 워킹트리 소유자가 자기 작업을 먼저 커밋하든지, 아니면 헝크 단위 분리가 필요하다. 그 전까지 커밋하지 말 것. **순수 신규 파일**(`terminalOutputDelivery.ts` 와 S4 신규 테스트 9개, `tests/benchmarks/` 3개)은 남의 헝크가 없으므로 별도 커밋이 가능하지만, 그것만 커밋하면 **의존하는 프로덕션 변경 없이 빨간 테스트만 들어간다.**

10. **`0x01` OUTPUT 의 `responderLeaseId` 처분** — §4 참조. **선행 조사는 3차 세션에 해소됐다: 클라이언트 소비자 0.**

    | 축 | 실측 |
    |---|---|
    | 프론트 프로덕션 | **0** — 모든 output 이 `fromJsonOutputMessage` 를 통과하고(호출부 **2곳뿐**: `WebSocketContext.tsx:598` grace 재생 · `:1146` live), IR 이 읽는 output 필드는 **10개**(`data`·`screenSeq`·`authorityEpoch`·`authorityRevision`·`chunkId`·`sourceSegments`·`replayToken`·`repairToken`·`connectionEpoch`·`deliverySeq`)이며 **세 필드는 그중에 없다** |
    | 프론트 단위 테스트 | **0** — output + `responderLeaseId` 단정 없음 |
    | E2E | **0** — `responderLeaseId` 단정 17건 전부 `terminal-authority:*` **control** 메시지를 겨눈다(`:4515` `responder-disable-boundary`, `:4532` `responder-disabled`, `:4575` `responder-disable-accepted` 등). control 은 opcode 표에 없어 JSON 평면에 남으므로 `0x01` 레이아웃과 무관 |
    | 프론트 `responderLeaseId` 소비처 | 전부 handoff·checkpoint 계열 (`TerminalView.tsx:3623`/`:3678` 은 `TerminalLegacyResponderEnabledMessage`, `terminalCheckpointRuntime.ts` 는 checkpoint identity) |

    ⇒ **세 필드는 서버가 붙이지만 클라이언트가 읽지 않는다.** `0x01` 와이어에서 빼면 blast radius(파생 골든 벡터 38건)가 통째로 사라진다. C4 가 만든 "IR 단일 진입점" 이 이 판정을 값싸게 만들어 줬다.

    **서버측도 확인했다 — 결론은 유지되지만 이유가 필드마다 다르다.** 핵심은 **와이어 페이로드 ≠ 프로세스 내 메시지 객체** 라는 구분이다.

    | 필드 (on `output`) | 클라이언트 | 서버 | 판정 |
    |---|---|---|---|
    | `responderLeaseId` | 0 | **0** (`record.responderLeaseId` 전수 0건. `Adapter.ts:768`/`:790` 은 **checkpoint ACK** 대조이지 output 이 아니다) | **완전한 dead weight** |
    | `sourceSeq` | 0 | **읽는다 — 단 인코딩 이전에** `sendTerminalFrame` 안에서: audit 기록(`:1421`), 단조성 검사 `sourceSequenceRegressed`(`:1523-1534`), tail 추적 `checkpointTailSourceSeqByView`(`:1574`) | 와이어에서 빼도 안전 |
    | `streamEpoch` | 0 | **읽는다 — 동일하게 인코딩 이전에** (`:1343-1349`) | 와이어에서 빼도 안전 |

    `sendTerminalFrame` 은 `enqueueSettledViewFrame` → 전송 큐 → `createWsTransportMessage`(`JSON.stringify`) 보다 **앞**이다. 즉 서버의 읽기는 전부 프로세스 내 객체에서 일어나고 와이어를 되읽지 않는다. `wsSendPolicy.ts` 는 세 필드를 **0건** 참조한다.

    **`sourceSeq` 는 더 강한 결론이 성립한다** — 그 7건의 read 가 전부 `record.type === 'output' && activeCheckpoint && checkpointOutputAuthority` 분기(`Adapter.ts:1520-1524`) 안이고, **그 분기의 메시지는 `terminal-checkpoint:output`(`0x07`)으로 재작성되어 나간다**(`:1563-1570`). 즉 **`0x01` 로 나가는 경로에는 `sourceSeq` 를 읽는 서버 코드가 아예 없다.** 그리고 `0x07` 프롤로그(`07` §4.3, off 0 `checkpointSourceSeq` u64)가 이미 그 값을 싣는다. load-bearing 은 2건뿐이다 — rollover 펜스(`:1534`)와 drain watermark(`:1574`).

    **전송 계층이 세 필드를 사이드카로 승격하지 않는다.** `createWsTransportMessage`(`wsSendPolicy.ts:85-135`)의 사이드카는 닫힌 13개 목록(`type`·`sessionId`·`repairToken`·`replayToken`·`screenSeq`·`authorityEpoch`·`authorityRevision`·`chunkId`·`connectionEpoch`·`deliverySeq`·`deliveryKind`·`outputData`·`sourceSegments`)이고 셋은 없다 → **`01:748` 이 요구한 `WsTransportMessage.sourceSeq` 승격은 실제로 일어나지 않았다.** 셋은 `payload` 문자열 안에 불투명 텍스트로만 남으며, 서버에 그것을 되파싱하는 지점이 없다(`WsRouter.ts` 의 `JSON.parse` 는 `:1746`·`:2554` **2곳뿐이고 둘 다 인바운드**, `wsSendPolicy.ts` 는 0회 — ✅ 직접 확인).

    ⚠️ **`01:748` 은 오인용이다 (4차 세션 실측).** `:748` 은 `'mandatory-flag-not-accepted'` 거부코드 리터럴이다. `sourceSeq` 승격을 요구한 곳은 **`01:823`** — *"`lane.sent` 엔트리에는 각 delivery 의 `sourceSeq` 를 부착해 두어야 하며, 이는 `WsTransportMessage` 에 `sourceSeq` 필드를 1급으로 추가하는 것과 같다 — §3.6 의 필드 승격 작업에 함께 포함시킨다"*. 그 §3.6 작업은 S1 에서 집행됐고 **`sourceSeq` 는 빠진 채 집행됐다**(사이드카 13개 확정 목록, `wsSendPolicy.ts:85-135`).

    🔴 **독립적 방증 — coalesce 가 오늘 이미 세 필드를 버린다.** `tryCoalesceOutputMessage`(`wsSendPolicy.ts:273-279`)는 병합 결과를 **`type`·`sessionId`·`data`·`sourceSegments` 4개로만 재조립**한다(✅ 직접 확인). 두 authority output 이 병합되면 세 필드가 **JSON 평면에서, 바이너리 이전에 이미** 사라진다. 차단 가드도 없다 — `hasFairDeliveryIdentity` 는 셋이 없어 false, `materializeOutputSourceSegments` 는 `[]`. ⚠️ 실제로 병합이 일어나는지는 **미실측**(정적 도달 가능성까지만). 그럼에도 **"소비자가 없다" 는 결론의 독립 증거**다 — 이미 값을 잃는 경로가 있는데 아무것도 깨지지 않았다.

    ⇒ **세 필드 모두 `0x01` 레이아웃 변경을 요구하지 않는다.** `0x01` 벡터 4개와 파생 fault 38건 **재계산 불필요**. 이 항목은 설계 변경이 아니라 **`01 §1.9` "프레임에 넣지 않는 것" 표에 3행 등재 + `06` S4-0b 에 판정 기록**으로 닫힌다.

    ✅ **독립 서브에이전트 검증을 받았다** — **SOUND WITH CAVEATS**, 공격 전부 통과(§0.1 검증 상태 표). 단 **coalescing 방증은 근거에서 빼라**: single-flight 펌프 때문에 병합이 사실상 도달 불가라 "이미 값을 잃는 경로가 있다" 가 발화하지 않는다. **무조건 성립하는 근거로 교체할 것** — `WsRouter.createFairDeliveryWireMessage:5820-5845` 가 세 필드 없는 closed list 로 메시지를 재구성한다는 사실. (이 문단 위의 🔴 블록은 뒤집힌 근거이므로 인용하지 말 것.)

11. ~~**`01 §1.8` / `08` §5.3 앵커 인용 정정**~~ — ✅ **완료 (4차 세션).** 정정 **28건**, 기계 대조 **46개 앵커 전건 통과**(스크립트로 각 인용줄이 실제 그 내용을 담는지 확인).

    **`01` §1.8 구역 참값 (재측정 확정)**: §1.8 제목 `01:514` · `0x01 OUTPUT` 제목 `:520` / 표 `:522-528` / `screenSeq` 행 `:524` · 세그먼트 도입문 `:530` / 표 `:532-538` · `screenSeq` 8B 근거 `:546` · `0x02` 제목 `:548` / 필드 `:550` / replayToken 회전 `[미확인]` `:552` · `0x05` 제목 `:554` / 필드 `:556` / digest `:558`. 헤더 표 `:45-52` 와 캡션 `:41` 은 **원래 정확했다**(바꾸지 말 것).

    | 대상 | 건수 | 내용 |
    |---|---:|---|
    | `07` — `01:524` 오귀속 | 5 | `07`:259·545·663·886·1029. 전부 "`0x05` 프롤로그" 라 주장하나 `:524` 는 `0x01` 의 `screenSeq` 행 → **`01:556`** |
    | `07` — 나머지 §1.8 앵커 | 10 | `:71`(`518-520`→`550-552`) · `:72`(`512`→`546`) · `:73`·`:75`·`:114`·`:884`(`518`→`550`) · `:274`(`526`→`558`) · `:841`(`520`→`552`) · `:847`(`534-540`→`612-617`, `344-355`→`374-385`) · `:883`(`500-507`→`532-538`) |
    | 픽스처 `$handComputed` | 4 | `490-496`→`522-528` · `500-507`→`532-538` · `518`→`550` · `524`→`556`. `01:45-52`·`$rules.endianness` 의 `01:41` 은 정확해 유지 |
    | `08` §5.3 코덱 export | 11 | `decodeWsMessage` `573`→**`813`** · `parseFrameMessage` `684`→**`958`** · `prologueBytes` `108`→`128` · `rejectionGrade` `181`→`224` · `WIRE_REJECTION_CODES` `125`→`147` · `DECODER_POLICY_CODES` `158`→`190` · `encodeFrame` `501`→**`704`** · `encodeBatch` `530`→**`733`** · `frameByteLength` `402`→`502` · `defaultFlagsForOpcode` `394`→`494` · `deriveMaxBodyBytes` `214`→`266` |
    | `08` 본문 코덱·`01` 인용 | 8 | `:20`·`:172`(`640-646`→`914-920`) · `:104`(`626-630`→`880-887`, `697-721`→`958-995`) · `:106`(`700-709`→`971-983`) · `:426`(`363-366`→`463-466`) · `:464`(`test.ts:45`→`:46`) · `:474`(`647-657`→`921-931`) · `:481`(`214-220`→`266-272`) · `:20`(`01:347-356`→`374-385`, `01:650-662`→`725-737`) |

    ⚠️ **`08` §5.3 이 크게 어긋난 이유는 문서가 낡아서가 아니라 이 세션이 코덱을 키웠기 때문이다** — `0x04` 구현이 `encodeFrame` 을 `:501`→`:704` 로 밀었다. **`0x04` 작업이 되돌려지면 이 11건은 다시 틀린다.** 코덱을 만질 때마다 재측정 대상이다.

    🔴 **`01:518` 은 정답과 오답을 겸한다** — §5.4 가 경고한 형태의 실물. `07:342` 의 `01:518`(D14 순수성 불변식)은 **정확**하고, `07`:73·75·114·884 의 `01:518`(`0x02` 필드 폭)은 **틀렸다**. 같은 이유로 `07:865` 는 내가 건드리지도 않았는데 이미 `01:556` 이었고(ESC 6B 주장), 그것은 **`01:628`** 이 참값이다. **일괄 치환 금지 — 줄번호 단위로 주소 지정해 정정했다.**

    🔴 **기계 대조가 내 회귀를 잡았다 — 정정 작업 자체가 새 오인용을 만든다.** `06` §1.4 를 재작성하며 ⑤ 행에 *"그 재호출 안의 `JSON.stringify`(**`:91`**)"* 를 썼는데, `wsSendPolicy.ts:91` 은 `const output = isOutputMessage(...)` 이고 `JSON.stringify` 는 **`:96`** 이다. **RIGHT→WRONG 이 아니라 WRONG→WRONG 이지만, 갓 검증한 것처럼 보이는 새 오답**이라 더 나쁘다.

    발견 경로: 이번 세션이 도입한 인용 **49개 전부**에 대해 *"그 줄이 주장한 토큰을 담는가"* 를 스크립트로 대조했다(`scratchpad/verify-session-anchors.mjs`). 1건 FAIL → 수정 → **49/49 OK**. ⇒ **정정한 인용은 반드시 기계로 되짚어라.** 눈으로 훑으면 이 1건은 통과한다.

    같은 계열(`wsSendPolicy.ts` 의 `+5` 족)을 전수 확인해 **내가 만진 파일 안의 것만** 정정했다: `06`:1551·1557(③ `:91`→**`:96`**)·1558(④ `:95`→**`:100`**), `01`:621(`:91`→`:96`, `:95`→`:100`)·635(`:95`→`:100`). ⚠️ **`02`(3곳: `:230`·`:258`·`:537`)와 `05`(6곳: `:44`·`:61`·`:62`·`:111`·`:189`·`:774`)에 같은 stale 이 남아 있다** — 이번에 만지지 않은 문서라 **S5-a0 몫**으로 등재한다. 참값은 `JSON.stringify` = `wsSendPolicy.ts:96`, `Buffer.byteLength(payload,'utf8')` = **`:100`**.

    **남은 것 (미해결 1건)**: `07:69` 의 `` `01:534`. `opcode` 로 대체 `` — `01` 에서 대응 서술을 찾지 못했다(`:534` 는 세그먼트 표 `byteStart` 행). 추측으로 숫자를 넣으면 *갓 검증한 것처럼 보이는 오답*이 되므로 **그대로 두었다.** `06` 의 stale 앵커 계열(§8 항목 8 미등록 몫)은 여전히 S5-a0 몫이다 — 이번에 `06`:375·745·1091·1165·1167·1535·1612·2190·2191·2237·2238·2245·2247 이 같은 `01` §1.8 계열임을 확인했으나 **동결 구역(`06:2467-2612`)에 4건이 걸려 있어** 함께 판정해야 한다

### 연구 과정에서 나온 저장소 결함 2건 (바이너리 무관, 미수정)

1. **`frontend/tools/ensure-react-mosaic-patch.cjs:52` 가 패치를 복구하지 못한다.** `spawnSync(bin, [PACKAGE_NAME])` — 패키지명을 인자로 주면 patch-package 는 **create 모드**다(적용 모드는 인자 없음). `hasRequiredPatch()` 의 결함 감지는 정확한데 복구 명령이 틀려 exit 1 로 죽는다. `prebuild` 에 걸려 있으므로 **`frontend/` 에서 `npm install` 한 뒤에는 `npm run build` 가 막힌다** → CLAUDE.md 의 연쇄대로 `start.bat`·`ensureBuildArtifacts()`·루트 build 18종·CI 까지 간다. 게다가 create 모드는 조건이 맞으면 `patches/*.patch` 를 **덮어쓸** 수 있다. 수동 복구는 `frontend/` 에서 `npx patch-package`. 한 단어 수정(`[PACKAGE_NAME]` → `[]`)
2. **`WsRouter.ts:1543-1546` 이 클라이언트가 준 `?wsTransportMode=split` 을 무조건 수용한다.** `split-disabled` 를 돌려줄 정식 파서(`server/src/ws/wsTransportMode.ts`)가 프로덕션에서 호출되지 않는다. 지금 무해한 이유는 프론트가 파라미터 이름을 `mode=` 로 잘못 보내기 때문뿐(`frontend/src/utils/webSocketUrl.ts:58`)이고, **URL 을 직접 만들면 unified 설정에서도 split 연결이 열린다**
