# Binary measurement, rollback, rollout and final audit

입력: [binary06 S5/S6/S7](../../research/binary-comms/06-work-plan.md), [binary05](../../research/binary-comms/05-test-migration-rollback.md), [master P10–13](../2026-09-08.remaining-work-autonomous.plan.md). 각 task 시작 때 MCP 원문·stability를 확인한다. draft/deprecated 요구를 임의 구현하지 않는다.

## BR-01 — 측정 계약 결정

- REQ PERF011 전체 나머지 AC, PERF010 AC2/3/4, IR001 AC10. BC-02/04/06 및 M1-M4 prerequisite 후 실행. 실제 schema/config/profile hash와 accepted scheduler를 고정한다.
- binary06 S5-a의 정책9개를 **5+3+1**로 처분: byte-domain5(socketSoftGate, bulkSlice, smallOutputBypass, creditWindow, queueMax), 비율/전략3(visibilityWeight, driverWeight, strategy)의 source 재귀속, 시간1 ackTimeout 별도 측정. bulkSlice의 encodedBytes quantum과 wire batch 상한을 각각 검증한다. literal expected/source assertions를 resolver 재호출로 대신하지 않는다.
- 산출물: paired JSON/binary workload/seed/repeats/samples/RTT/jitter/loss/config, 각 threshold/tolerance·근거 REQ/benchmark symbol·9-key disposition 표. 기존 batch64/8192 등 별도 collector 한도나 runtime 기본 수치 무단 변경 금지.
- 실패 강도: body0→encoded1, coalescing과 batching 구분, 경쟁 lane의 실제 송신 순서와 first/second ACK delta로 검증. 라운드 수·능력 accepted만으로 공정성 입증 금지.

## BR-02 — 실제 benchmark와 binary generation

- 파일: `server/src/benchmarks/terminalFairnessCharacterization.ts`, authority locator/publisher, TerminalResourcePolicy, codecs/wsSendPolicy; 연구가 지목하는 source pin5계열을 먼저 inventory(P1 fairness, P2 canary, P3 authority promotion, P4 retained shadow, P5 benchmark digest).
- 실제 동일 workload JSON/binary pair, 프레임/CPU/allocation/echo/queue 측정. 서버 CPU와 browser CPU를 분리하고 압축 대조군·WAN 조건·tiny/chunky/hidden/1,2,8 client 축을 문서 원문으로 고정한다. 임의 속도 수치 목표를 만들지 않는다.
- 완료: raw nonempty manifest/hashes/threshold 판정/회귀 tolerance, semantic corpus 동일, fairness/starvation 및 body/wire budget, batch/coalescing fuzz 모두 통과. 새 **binary** generation supported publication→independent integrity→build. JSON generation으로 binary 채택 증거 대체 금지.

## BR-03 — opt-in 실제 통합

- BC-07 M1-M4와 S5-c0 source ACK, accepted scheduler 및 negotiated unified config가 하드 선행. 설정 값만으로 binary 켜지 않음; subprotocol+in-band 양쪽 성공 필요.
- actual screen parity/echo regression, expected downgrade reason, credit ledger 일관성 및 단일 encode/decode caller0-bypass. 성공 후에도 기본값 전환·전체 SRS verified 아님. source가 바뀌면 관련 generation/fingerprint 다시 검증한다.

## BR-04 — rollback 계약 결정→구현

- REQ IR001 AC3/4/5/6/11, MIG002 AC5/6, MIG004 AC2/3/4, FR024 AC4/5. [연구 gaps](../../research/2026-09-08.binary-rollback-integration-gaps.md), [미채택 proposal](../2026-09-08.binary-rollback-contract-proposal.md)의 실제 파일 존재/최신 경로를 확인한다.
- 결정 Task: 최초 JSON decline와 established binary failure, retained/controller/group codec epoch 관계, failing group와 healthy shared-session view의 영향범위, 네 trigger(config hot reload, fatal decode, renegotiation failure, old build restart) 단일 진입점, fresh checkpoint/start-drain barrier를 동결한다. session/global isolation과 bounded producer 수집을 보존한다.
- 4001+ASCII fatal-prefix 후보는 기존 reconnect 재사용이지만 아직 채택되지 않았다. reason은 client 주장일 뿐; authenticated server membership/generation/closed-code grammar, duplicate/flood/lost-close/loop를 설계한다. unknown-channel을 fatal envelope로 오용하거나 여섯째 binary type을 무단 신설하지 않는다. Browser close1002는 허용되지 않음.
- 기존 authority rollback을 무조건 호출하면 shared healthy peer까지 영향을 줄 수 있다. 기존 `beginRollback`, checkpoint runtime, actor/credit cleanup 재사용 조건을 설계하고 별도 codec-only 복제 rollback 금지.
- 구 빌드 선정 Task: 실제 지원 release+artifact hash/OS/deps/config compatibility를 명시한다. 로컬 tag0.5.4의 commit은 `e584c2a4f2216ba689b7f77b8352ac3cde9ac171`(annotated tag object와 다름), schema는 이미 format4값 수용. 이를 자동 지원 rollback 배포물로 선정하지 않는다. 실제 artifact 없이 예전 commit/unit로 old-build gate 충족 금지.
- 결정 산출물 독립 No findings·필요 SRS 공식 증분 후 RED. 기존 current source의 negotiated 유지/경고만 하는 현상은 AC4 예외 허가가 아니다.

## BR-05 — M5/M6·R1–R7·default

- M5 두 binary client/서로 다른 session channel 격리; M6 8 mixed(4 binary/4 JSON) codec 무관 lane fairness. M1–M6 최종 전건 재검증·nonzero 수신 유지.
- R1 새 generation/epoch 경계, R2 늦은 old binary frame 거절+관측, R3 queued binary 폐기·같은 bytes JSON 재인코딩 금지, R4 첫 fresh JSON snapshot, R5 논리 화면/retained state 동등, R6 queue/timer/held credit 정확히1회, R7 rollback 비활성 대조로 R1–6의 rollback-specific assertion이 실제로 갈리는지 증명. 연구의 connectionEpoch/codecEpoch 이름을 source streamEpoch와 묵시적 동일시하지 말고 BR-04 mapping을 사용한다.
- MIG004 default gate: adopted binary evidence 없거나 불완전/변조면 json fail-closed. session/global kill switch, old-config 구 서버 기동, poisoned/absent cache hard reload, unified 기본·UI·AI idle 불변. 필요한 대응 SRS 원문을 먼저 읽는다.
- default 채택은 모든 성능/혼합/rollback 검증·독립 No findings·공식 evidence 후. 실제 release publication은 일반 local 구현 승인으로 추론하지 않는다.

## BR-06/07 — 실제 soak와 eligible 삭제

- default 전환 뒤 **실제 서로 다른 release2개** ID/date/build/source/hash 및 관측 workload/오류/rollback 기록. 가상의 릴리스·시간 가속·두 번 local build로 대체 금지. 외부 진행을 기다리더라도 아직 가능한 구현/검증은 계속하고 전체완료를 주장하지 않는다.
- MIG004 AC6 및 별도 **stable deletion Requirement와 해당 사용자 허가**를 확인한 뒤에만 legacy physical deletion. control JSON·downgrade compatibility는 보존. legacy encoder/decoder/local snapshot/viewport replay/recovery 제거 범위는 승인된 삭제 REQ별 RED·retained range/state/rollback 회귀로 입증한다. draft MIG003은 구현 권한이 아니다.

## BR-08 — P13 최종 감사

- 원본 A/B/C 각 When/Then, master P0–13와 binary06 §13 층A/층B 전체를 행 단위로 매핑. D1–D15/프롤로그/S4-0/S5 정책/CI OS 등 기존 결정이 현재 유효한지 확인하고 미결을 누락하지 않는다. Tier0 CI의 build-free 범위·기존 release.yml 비변경 등 원문 범위를 검토하며 요청 범위에 있는 미완료 deliverable은 별도 결정 task로 남겨 끝낸다.
- final relevant tests/full monolithic/broad node:test/frontend/E2E, actual HTTPS2222, build/source contracts/provenance/manifest reseal, strict SRS validation·links, per-REQ evidence/missingEvidence/stability, official worklog/read-back 및 scoped commits를 확인한다. 원본 user-owned7+관련 파일 보존.
- 모든 Phase는 다른 까칠 reviewer→fixer→재리뷰 No findings. 상태/AC를 bundle로 bulk verified 처리하지 않는다. 실제 종료 증거 없는 PID absence/로그 없음은 자연 종료 증거가 아니다.
- 모든 범위 완료 뒤에만 AGENTS의 remaining-work-autonomous-execution start/end 사이 임시 블록 제거→독립 검토. master/evidence/history는 보존하고 thread goal을 그때 complete한다. 이 문서가 체크리스트를 대체하지 않는다.
