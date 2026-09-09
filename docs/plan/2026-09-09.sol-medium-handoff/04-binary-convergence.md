# A / P9 binary production convergence

읽을 원본: [ACK 설계](../2026-09-08.ack-domain.design.md), [원본 A](../../next/2026-09-07-remaining-work-execution-plan.md), [binary06 §3/5/13](../../research/binary-comms/06-work-plan.md), [codec framing](../../research/binary-comms/01-frame-format-and-negotiation.md). 연구문서의 오래된 epoch/21B/ACK 표현보다 현재 SRS가 우선한다.

## 보존할 완료 prerequisite

P2a `ba769c2` reservation/commit/router tuple138; P2b `b359b05` same-source two clients/recreated lane68; P3 `1f80200` source/legacy ACK ledger83와 ceiling mutant; P4a `2498b397` parser/rejection server108/frontend96; P4b `5abfc4c` explicit adapter/write completion270. [accounting](../../report/2026-09-08.A-source-ack-accounting.md), [protocol](../../report/2026-09-08.A-source-ack-protocol.md), [write completion](../../report/2026-09-08.A-source-ack-write-completion.md).

IR001 AC11 negotiate request/capability response 구분과 실제 boot6는 완료된 subset이다. JSON fallback peer loss correction `70bf41d`도 완료지만 fair lane resumption 또는 all-binary ledger를 증명하지 않는다. [fair recovery 설계](../2026-09-08.fair-recovery-resumption.design.md).

## BC-01 — producer/epoch/consumer 사실표와 결정 task

- REQ IR001 AC1–7/10/12, FR024 AC1/2/4/5, PERF010 AC1/5/6/8, PERF011 AC1/10, MIG002 AC2/5. hidden 상세는 01과 결합하되 같은 파일 동시 writer 금지.
- 소스: `SessionManager` output reservation/flush/current retained epoch, `terminalStreamEpoch` issuer, `TerminalAuthorityController` state epoch, `TerminalAuthorityProductionAdapter` promotion/rollback, `WsRouter.routeSessionOutput`, `wsSendPolicy.createFairTerminalDeliveryScheduler`, `terminalBinaryGroupSession`, `wirePayload`/binary codecs, Context binary intake.
- 산출물: 모든 normal/checkpoint/replay/repair output producer→codec→channel/source identity→fair admission→wire→consumer 표. Opcode0x01 normal output와0x07 checkpoint output의 ACK 소유권을 분리. accepted global capability를 개별 frame membership로 오인하지 않는다.
- 결정 전제: reserved source tuple은 기존 issuer 재사용; controller·retained streamEpoch·group codecEpoch 관계를 명시적으로 동결. 임의 counter/Number 변환/header flag 추가 금지. binary06 S4-0b 세 미결(issuer 동일성, transaction 중 lane fallback, responderLeaseId 실제 대입)을 현재 source로 판정한다.
- gate: 구체 state/ordering/affected client-session 범위와 RED matrix를 별도 설계로 작성→독립 No findings→필요 SRS 공식 증분. 결정 전 구현 금지.

## BC-02 — recovery lane/all-consumer fair membership

- BC-01 후. 현재 legacy checkpoint-start/invalidate lane 종료·settled direct output 우회, 실제 checkpoint hooks와 연결을 조사한다. 사용 sender가 안 보인다는 이유로 public control을 unreachable로 가정하지 않는다.
- 비교 결정: legacy control suspension/resumption 또는 negotiated binary에 observable rejection+실제 authority hooks. JSON 호환은 PERF010 AC7을 보존하되 binary frame을 JSON으로 몰래 보내는 우회 금지.
- RED: timeout/overflow lastlane/peer, checkpoint transition, hidden/dataGap, lane replacement, late old ACK zero, new lane 첫/두 번째 delta, duplicate/unsent/overack, healthy peer와 다른 session 불변. 실제 route/scheduler/wire를 사용하고 capability admission만으로 우회 테스트 금지.
- frame마다 source tuple·실제 송신 ledger 존재를 입증한 후에만 production intake ACK 소유권을 연결한다. stale-only/준비 flag만으로 완료 금지.

## BC-03/04 — 실제 binary intake→write completion→ACK roundtrip

- 파일: Context binary branch/terminalBinaryNegotiationClient/channel registry/intake; TerminalView 실제 write wrapper와 staged coordinator; Container ACK emitter; server dispatch/rejection. P4b `ackConnectionEpoch`를 global capability만으로 자동 부여하지 않는다.
- metadata를 enqueue 시 캡처하고 session/connection/view generation 변경 시 stale callback ACK0. 한 번 accepted write 완료당 단일 ACK; 실패/timeout/retired restore는 성공 ACK 금지. checkpoint settlement는 별도 계약 보존.
- 검증: 실제 parser 양방향 corpus·mandatory anchors/outbound union, binary batch 여러 session roundtrip, source64 경계와 first/second/cumulative/duplicate credits, malformed rejection 관측. 최종 실제 browser/HTTPS 검증은 canonical runtime 소유권 preflight 후.
- 완료: 원본 A When/Then 미매핑0, P3 mutant harmless source-control→semantic mutant→원복 결과 보존, final A suite/full server/front baseline 비교. P4 전체는 자동 roundtrip 입증 뒤에만 체크.

## BC-05 — 최종 A5 publication

- BC-04 최종 source 뒤 원본 §9.8의 **실제 현재 함수 signature**를 읽고 supported publisher→새 generation→provenance/evidence build 순서. §9.9 consumer manifest reseal도 해당 source 변경에 적용.
- 기존 generations·raw/user files 보존. source digest mismatch 시 독립 3역할 boundary, 임시 gate disable/allowlist로 통과 금지. 현재 JSON `0d7495...` 등 중간 generation은 이후 source의 증거가 아니다.
- validation: published candidate accepted/threshold/provenance/current source+compiled files/checkout EOL roundtrip, server build, A suite 및 frontend 명시 타입·unit delta. mutation 시 harmless provenance control 먼저.
- 완료: source/evidence scoped commits 후 authority git status clean, original §10 A 전체 gate, 독립 의도/테스트강도 No findings, 보고서와 per-REQ MCP evidence/read-back. 이 작업으로 PERF011 전체 AC 승격 금지.

## BC-06 — 단일 codec 경로와 retained digest

- FR024 AC1–7: 모든 terminal payload producer 단일 encoder, 모든 browser payload 단일 decoder→기존 string/Uint8Array staged path→TerminalWriteCoordinator. 두 번째 scheduler 금지. unified에서 JSON control과 binary data 프레임을 실제 frame type으로 구분.
- IR001:28B big-endian7field, ordinal64 canonical 무손실, opcode1..7/예약 opcode rejection, prologue/descriptors/body 경계 및 mandatory flags. wire byteLength와 body-only encodedBytes(0B는1)를 혼동하지 않는다.
- IR002 **AC2/4 원문 MCP 조회 후** 실제 codec-independent server adapter digest와 mixed-version checkpoint 검증 구현. 연구 S5-b는 명칭만 바꾸는 작업이 아니다. 실제 serialized content/index/count/total/digest의 일치·누락/중복/순서/잘림 실패→fresh recovery를 입증.
- corpus: ASCII/CJK-wide/combining/ZWJ/emoji/split ANSI/normal-alt/resize-reflow, 최종 terminal state hash JSON 동일. 오류를 empty success/silent tail로 삼지 않고 view stale·reason 관측·PTY/peer isolation, AI TUI idle 보존.
- 테스트: codecs/IR golden vectors/property/fuzz + actual producer/source no-bypass contracts + browser writer integration. 현행 파일명은 rg로 찾고 기존 harness/codec를 재사용한다.

## BC-07 — opt-in 전 M1–M4

- [binary05 §7](../../research/binary-comms/05-test-migration-rollback.md) / binary06 S6-a를 읽되 최신 AC11 negotiate와28B 계약에 맞춰 fixture를 작성한다. M1 old no-codec, M2 explicit JSON refusal, M3 unsupported version, M4 decoder failure.
- 실제 old client가 output/checkpoint를 **1건 이상** 받는 관측 하한과 명시적 downgrade reason을 단언한다. zero receive·구조만 확인한 JSON 객체는 실패. M4는 BC-01/BR-04 rollback 설계가 필요하므로 선행 결정부터 수행한다.
- 완료 gate: M1–M4 비공허 통과/독립 No findings 전에 P10 binary-optin 활성화 금지. 새 harness 전에 기존 raw-client/browser harness를 검색한다.
