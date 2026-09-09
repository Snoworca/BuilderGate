# Remaining roadmap — sol medium

이 문서는 실행 인계용 색인이다. 요구사항 SSOT는 [SRS index](../../spec/00.index.md), 현재 진행 SSOT는 [master](../2026-09-08.remaining-work-autonomous.plan.md)다. 파일 줄번호·HEAD·MCP 상태는 작업 시작 시 재확인한다. 이 인계는 새로운 요구 승인이나 완료 증거가 아니다.

| Master / 원본 | 실행 Task | 다음 읽을 문서 / 의존 |
|---|---|---|
| P0 남은 effective config | RG-01 | [03 regression/settings](03-regression-settings.md); runtime 실행 전 |
| P1 A0 / P2 A1 / P3 A2-A3 | 완료된 prerequisite 보존 | [04 binary](04-binary-convergence.md); 재구현하지 않음 |
| P4 A4 / 앞당긴 P9 | BC-01→02→03→04 | [04](04-binary-convergence.md); hidden 통합과 source/epoch 설계 조율 |
| P5 A5 | BC-05 | BC-04 이후; 최종 변경 source에 새 generation |
| P6 B0/B1 | bounded 완료 보존 | [03](03-regression-settings.md); full server와 다름 |
| P6 B1 split | RG-02→03 | restore/supersede 결정 후 구현; 13 TODO 유지 중 |
| P6 B2 browser | RG-04→05 | 소유권·타입·runtime preflight 후 10회 |
| P6 B3 / P7 C final | RG-06→07→08 | hidden 01의 통합 완료 후 full frontend; server 안전성 선행 |
| P7 C1-C5 | 구현 완료, 최종 gate 미완료 | [03](03-regression-settings.md); 159 subset으로 면제 금지 |
| P8 admission / lexical / diagnostics | 완료 보존 | 아래 완료 ledger; 다시 pending으로 돌리지 않음 |
| P8 hidden | H 계열 | [01 hidden](01-hidden-recovery.md); 파일명이 index와 다르면 실제 01 문서로 연결 |
| P9 나머지 producer/digest | BC-06→07 | [04](04-binary-convergence.md) |
| P10 | BR-01→02→03 | [05 measurements/rollout](05-benchmark-rollout.md); M1-M4 선행 |
| P11 | BR-04→05 | [05](05-benchmark-rollout.md); rollback 결정부터 |
| P12 | BR-06→07 | 실제 default 전환 및 실제 2 release soak 이후 |
| P13 | BR-08 | 모든 하위 목표/증거 완료 후 임시 AGENTS 블록 제거 |

## 완료 ledger와 현재 경계

- P1/P2/P3: ACK 설계, 예약 source tuple 전파, source/legacy ledger 정산 완료. P4a parser/rejection·P4b explicit adapter/write callback도 prerequisite 완료다. 자동 binary intake와 ACK roundtrip은 미완료다.
- P8 admission: canonical `bbf59ed` exact20/default concurrency/118000ms 아래 3회 `80441.2659/80083.2498/79877.6218ms`; [보고서](../../report/2026-09-09.admission-three-run-validation.md), PERF010 VE-7. 149 unique inputs/17 unique 보존 경로, 54 mjs/guard hash 범위. 성공 inner JSONL 별도 미보관 한계 유지. 과거 20/21 discrepancy는 agreed successor로 해결됐으며 과거 메모의 pending 문구로 되돌리지 않는다.
- P8 lexical actual occurrence accounting 완료. P8 diagnostics 현재0/0/byCode{}, links671/broken0 수동 기준 정합 완료; 링크 수와 target 분포는 고정 정책값이 아니다. [진단 보고서](../../report/2026-09-09.srs-diagnostic-baseline.md).
- P8 checked 하위 항목은 admission/lexical/diagnostics **3개**다. hidden과 P8 전체는 미완료다.
- C1-C5 구현은 완료, [159 case executions](../../report/2026-09-09.C-final-regression.md)는 subset 증거다. 원본 §10의 full server/frontend GREEN은 아직 필수다.
- hidden runtime/registry `9f1c68e` 177/177/type3는 준비 API일 뿐 Context/View/Container 연결·matching start/drain은 미완료다. 상세는 01과 [hidden plan](../2026-09-09.hidden-recovery-barrier.md).

## 실행 순서와 병렬성

1. 01 hidden 통합과 RG-01/RG-02 read-only 및 binary BC-01 설계 조사를 분리 가능하다. 동일 Context/View/Container 또는 WsRouter/source pin 파일에 동시 writer 금지.
2. RG-06 서버 안전성 fixture 정리는 제품 hidden 파일과 분리 가능하나 실제 process 실행은 단일 owner가 통제한다. 서버 시작·종료를 병렬 agent가 공유하지 않는다.
3. BC-02 recovery lane/all-consumer membership 결정 없이 P4 자동 ACK를 활성화하지 않는다. M1-M4 비공허 증거 없이 P10 opt-in을 켜지 않는다.
4. 모든 동작 변경: 현재 SRS lookup→구체 설계 독립 No findings→RED 확인/커밋→최소 구현→관련 최종 회귀→다른 reviewer No findings→scoped commit/공식 evidence read-back. 미동결 영역은 결정 Task 결과를 먼저 만든다.
5. 원본 [remaining execution plan](../../next/2026-09-07-remaining-work-execution-plan.md) §3–10과 [binary06](../../research/binary-comms/06-work-plan.md) §3/5/13을 crosswalk한다. 옛 숫자·식별자는 현재 source와 재측정한다. 요구 충돌은 조용히 선택하지 않는다.

대범위 종료는 실제 release/soak/deletion까지 포함한다. 어렵거나 외부 시간이 필요하다는 이유로 설계·코드 준비를 전체 완료로 바꾸지 않는다.
