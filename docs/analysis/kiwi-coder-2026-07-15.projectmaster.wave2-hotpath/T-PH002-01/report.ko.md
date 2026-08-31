# T-PH002-01 Repair queue·protocol RED 증거

- Requirement: `REL-BGSTAB-008` AC-1~AC-7, AC-9~AC-11
- 범위: server test contract 두 파일
- production 변경: 없음
- 결과: 계획대로 전체 명령은 `EXPECTED RED`

## 바뀐 계약

기존 screen-repair timeout, failure, byte overflow가 held output을 하나의 문자열로 full flush하는 기대를 테스트 등록과 source에서 제거했다. 정상 under-cap ACK, stale token, replay-pending rejection, UTF-8 within-cap characterization은 유지했다.

새 계약은 다음 장애 경계를 직접 만든다.

1. UTF-8 byte 및 chunk N-1/N/N+1, empty chunk, `compatibility-cap` source
2. overflow 시 old token abort, affected view만 restore-needed, fresh snapshot transaction 시작
3. fresh snapshot sequence가 덮는 prefix 제거, post-snapshot 두 chunk의 identity/order/exactly-once, drain 뒤 ready
4. timeout, write failure, parser-reset failure, authority unavailable, fresh transaction 뒤 두 번째 overflow
5. old connection close/dispose 뒤 new connection의 pending transaction/chunk reference, bytes, messages, ready/stale, token 불변
6. affected client overflow 중 다른 client의 output/input/control delivery, router protocol을 통한 authoritative headless repair, repair ACK 뒤 후속 producer output 유지
7. safe-send high-water 압력에서 recovery control과 실제 competing output을 함께 보류한 뒤 control-priority drain 및 giant/direct repair output 금지
8. telemetry의 byte/chunk/sequence/token/reason/outcome/source와 raw payload 비저장

AC-6은 현재 구현이 이미 functional safety를 만족했다. old connection에서 온 replay/repair ready·failed·timeout·duplicate callback을 호출해도 new connection transaction과 held chunk reference가 그대로이고 old output 또는 ACK-ok가 발생하지 않았다. 계약에 없는 generation telemetry를 새 RED 조건으로 만들지 않고 `PASS characterization`으로 보존했다.

## 검증 결과

`server` 기준:

- `npm run build`: PASS
- exact test-runner filter: 5개 중 5개가 의도한 signature로 RED — AC-1/3/5/7/10
- `screen repair` filter: 기존 정상 characterization 14 PASS, 신규 5 RED, obsolete full-flush expectation 0
- exact split filter: AC-6 PASS characterization, AC-2/4/9/11 의도한 signature로 RED
- full split: 21개 중 4 PASS, 신규 4 FAIL, 기존 standalone split limitation 13 TODO, 예상 밖 failure 0
- scoped `git diff --check`: PASS

실패는 현재 production의 giant concat/full flush, fresh resync transaction 부재, chunk identity 미보존, 불완전 parser failure의 조기 ready, redacted recovery telemetry 부재를 정확히 가리킨다. 테스트 로그와 증거 문서에는 raw terminal input/output payload를 저장하지 않았다.

## 리뷰

이전 까칠한 리뷰의 finding을 모두 반영했다. fresh replay의 ACK 전 output/ready 누출 0, safe-send recovery control과 competing output의 queue 우선순위, router protocol을 경유한 다른 client authoritative repair와 후속 producer output까지 다시 강화했다.

동일 reviewer `tph00102_prickly_review`의 최종 독립 재리뷰 판정은 정확히 `No findings`이다.
