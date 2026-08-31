# Wave 3 PH-003 Browser TerminalWriteCoordinator 단일 쓰기 권한 구현·검증 보고서

> 상태: 구현·HTTPS 실행·Phase 통합 까칠 리뷰, SpecKiwi/GitHub evidence 동기화와 독립 closure audit까지 완료. 최종 재검토 판정은 정확히 `No findings`다.

## 1. 결론

FR-BGSTAB-022의 browser terminal sole-writer 계약을 구현했다. 각 xterm runtime의 live output, replay, snapshot, repair, clear, resize, fit 및 Windows PTY mode mutation은 이제 하나의 generation-safe `TerminalWriteCoordinator` physical deque를 통한다. Checkpoint body와 parser tail, commit 뒤 `sourceSeq`까지 도착하는 live output의 실제 write callback이 모두 끝나기 전에는 drain ACK와 queued input을 해제하지 않는다.

Checkpoint wire 계약과 production browser dispatcher/runtime bridge는 양단에 additive로 추가했지만 server authority는 활성화하지 않았다. 실제 server는 요청 전 capability를 광고하지 않고 실행 중인 HTTPS runtime도 negotiation에 응답하지 않았으므로 이를 성공으로 간주하지 않고 activation을 거부했다. 별도의 test-controlled active server를 같은 실제 WebSocket ingress 앞에 두어 browser registration, start/chunk/commit/output, exact ACK와 input gate를 검증했으며 controlled frame은 legacy server로 전달하지 않았다.

최종 machine executable evidence verdict는 inventory의 `activation.verdict`와 동일한 `REJECTED_RUNTIME_CAPABILITY_UNAVAILABLE_FAIL_CLOSED_OBSERVED`, `eligible=false`다. 사람 관점에서는 runtime server capability가 없어 activation을 fail-closed로 거부한 합격 경계다. 기존 UI, keyboard/paste ownership, terminal status semantic, xterm engine 및 사용자 기본 설정은 변경하지 않았다.

## 2. 구현 결과

- `TerminalWriteCoordinator`가 live, compatibility mutation과 checkpoint transaction을 하나의 ordered deque로 직렬화한다. Active/pending checkpoint와 충돌하는 legacy output, snapshot, reset, repair와 replay는 뒤로 미뤄 화면을 덮지 않고 명시적 recovery로 수렴한다.
- terminal당 물리 write는 한 번에 하나만 in-flight이며, callback 유실은 동일 xterm FIFO probe와 bounded timeout으로만 정산한다.
- `terminalRawMutationAdapter.ts`만 raw xterm write/reset/resize/clear/fit/windowsPty mutation을 수행한다. React component와 WebSocket 경로는 coordinator command만 제출한다.
- dispose, remount, supersede는 view generation을 올리고 이전 callback, timer, settlement credit, ready waiter와 held input을 정확히 한 번 정산한다.
- production `terminalCheckpointRuntime`은 view registration, capability scope, session별 dispatcher, fresh recovery request와 apply/drain/failure ACK를 연결한다. Malformed global/session frame, ACK rejection, reconnect와 recovery 재진입에서도 generation/epoch 상한은 단조 증가한다.
- active capability가 passive/null로 철회되면 명시적 `rollback-to-compatibility`가 transaction, timer, lifecycle ACK, queued mutation과 이전 generation을 정산하고 strictly-higher clean legacy generation으로 원자 전환한다.
- checkpoint barrier에서 accepted된 모든 input은 payload-free token으로 추적되며 정확히 한 번 `released`, `rejected`, `superseded`, `disposed` 또는 `expired`로 정산된다. Rollback/stale generation input은 server로 전송하지 않는다.
- checkpoint는 `streamEpoch`, `checkpointEpoch`, `sourceSeq`, `snapshotSeq`, `oldestRetainedSeq`를 canonical uint64 decimal string으로 검증한다. JSON number, 앞자리 0, 부호, 공백, 범위 초과 및 rollover를 거부한다.
- start/chunk/commit/output metadata는 geometry, modes, parser tail, ordered chunk index/count, encoded byte total, base64 payload와 SHA-256 digest를 검증한다.
- apply ACK는 snapshot과 정확히 일치해야 하고 drain ACK는 `sourceSeq`와 정확히 일치해야 한다. failure progress는 `sourceSeq`를 넘을 수 없다.
- unknown/malformed `terminal-checkpoint:*` 메시지와 parser를 통과하지 않은 frontend ingress는 global/session scope를 구분해 명시적으로 fail-closed 처리한다. 다른 legacy session을 오염시키거나 sessionId가 없는 global 오류를 조용히 버리지 않는다.
- digest, chunk order, timeout, hold overflow, apply/drain 실패는 normal completion이 아니라 recovery latch와 fresh generation checkpoint 요구로 수렴한다.

## 3. Acceptance Criteria 근거

| AC | 판정 | 핵심 근거 |
| --- | --- | --- |
| FR-BGSTAB-022 AC-1 | PASS | live/replay/checkpoint/repair/compatibility mutation이 terminal별 coordinator 하나의 physical deque를 공유하고 active checkpoint 중 legacy authority 혼입이 차단됨을 unit, AST inventory와 HTTPS ingress로 검증했다. |
| AC-2 | PASS | production raw mutation은 `terminalRawMutationAdapter.ts` 밖에서 0건이고, terminal당 write callback 하나만 in-flight임을 검증했다. |
| AC-3 | PASS | canonical identity, chunk/byte/digest와 supported mode를 mutation 전에 검증한 뒤 reset, geometry, modes, body, parser tail, post-commit live output 순서로 적용함을 검증했다. Unsupported mode는 reset/resize/write 0건으로 실패한다. |
| AC-4 | PASS | stale generation/epoch, duplicate·missing·out-of-order chunk, digest mismatch, callback/assembly timeout, ACK rejection, malformed frame, reconnect, apply 실패와 rollover가 strict-higher recovery를 요청하고 ready를 닫는다. |
| AC-5 | PASS | body, parser tail과 `sourceSeq` live write가 물리적으로 drain되기 전 apply/drain ACK와 queued input release가 0건임을 unit 및 실제 browser ingress에서 확인했다. |
| AC-6 | PASS | dispose/remount/supersede/rollback과 reentrant/throwing late callback이 새 generation을 오염시키지 않는다. Accepted input과 write credit은 정상·fault·TTL·dispose 경로에서 payload 노출 없이 정확히 한 번 정산된다. |
| AC-7 | PASS | UI visual·label·layout, input ownership, status semantic, engine/default에 변화가 없고 legacy runtime 경로가 유지된다. |
| REL-BGSTAB-007 AC-4/5 | 부분 PASS | 공통 Ordinal64 wire, source/snapshot/retained sequence, checkpoint metadata 및 exact apply/drain/failure ACK를 구현했다. retained server model의 실제 송신·authority 승격은 PH-004~PH-005 gate로 남긴다. |
| REL-BGSTAB-007 AC-8/11/12 | 경계 보존 | local cache는 authority로 승격되지 않았고 UI/default/legacy 삭제가 없으며 capability가 unavailable 또는 inactive이면 activation을 거부한다. |

## 4. Executable evidence

| 항목 | 결과 |
| --- | ---: |
| post-ACK convergence focused | 87/87 PASS |
| authority/restore serial 회귀 | 192/192 PASS |
| 서버 checkpoint protocol/router focused | 3/3 files PASS |
| 프런트 전체 unit 회귀 | 483/483 PASS |
| 서버 전체 회귀 | 517/517 PASS |
| HTTPS Desktop Chrome exact E2E | 5/5 PASS |
| production raw mutation findings outside adapter | 0 |
| raw adapter import bypass findings | 0 |
| 프런트 typecheck | PASS |
| 서버 typecheck/build | PASS |
| 신규 PH-003 범위 targeted ESLint | PASS |
| `git diff --check` | PASS |

`TerminalView.tsx`와 `WebSocketContext.tsx` 전체 파일을 대상으로 한 확대 lint는 기존 HEAD에도 존재하는 `connect()` effect 호출 및 context hook export 규칙 오류 4건과 cleanup-ref 경고 5건을 그대로 보고한다. PH-003 신규 utility/test 범위는 0건이며, unrelated UI/context lint debt는 이 Phase에서 조용히 수정하거나 합격 증거로 숨기지 않았다.

Exact HTTPS 명령은 다음과 같다.

```text
npx playwright test tests/e2e/wave3-terminal-authority-fairness.spec.ts --project "Desktop Chrome" --grep "sole writer|refresh|remount"
```

다섯 browser case는 최신 source를 `npm run build` postbuild로 staging한 뒤 실제 `https://localhost:2222`에서 검증했다. 실행 중인 Node/BuilderGate 프로세스는 재시작하거나 종료하지 않았다.

1. local snapshot cache를 막은 hard refresh 뒤 동일 live session과 terminal marker 복구
2. same-session renderer remount 뒤 이전 generation snapshot과 early-ready ACK 차단
3. test-controlled active server의 실제 page WebSocket ingress에서 registration → start/chunk/commit/output → apply ACK(`snapshotSeq=9000`) → drain ACK(`sourceSeq=9001`) → 보류 input 0건에서 정확히 1회 해제
4. active apply/drain 뒤 두 번째 checkpoint input을 보류하고 passive capability를 철회하여 strictly-higher clean legacy generation, `superseded` settlement 1회·payload 노출/server send 0, stale frame 무오염, fresh compatibility snapshot/reset+post-output+새 input admission 복구
5. digest mismatch, out-of-order chunk, Ordinal64 rollover, stale callback, body/tail drain 및 queued-input barrier의 fail-closed 동작

Rollback case의 final raw event chain은 boundary `131` < local compatibility drain `138` < snapshot ACK outbound `142` < post-ACK output `150` < authoritative tail convergence `157` < dedicated drain `158` < legacy input-ready `160`이며 각 event count는 1이다. Pre-snapshot 및 pre-convergence server input은 0건이고 post-ready input은 1건이다. Raw tuple에서 독립 계산한 `sameSession`, `sameReplayToken`, `sameSnapshotSeq`, `sameConnectionGeneration`, `sameViewGeneration` proof는 모두 true이고 compatibility snapshotSeq도 artifact에 보존된다. Stale 또는 역행 `screenSeq`는 convergence에 기여하지 않는다.

다섯 번째 case에서 실제 server runtime negotiation은 `unavailable-no-response`였다. ACK를 보내지 않았고 activation은 명시적으로 거부했다. 반면 세 번째·네 번째 case의 test-controlled active path는 browser production dispatcher/coordinator를 통과하되 controlled ACK/input frame과 legacy authority request를 실제 server로 전달하지 않았다. inactive runtime 관측과 active browser 구현·rollback 증거를 서로 다른 evidence로 유지한다.

## 5. TDD와 fault 검증

RED에서는 production 구현을 바꾸지 않은 상태로 147개 등록 테스트 중 기존 133개가 통과하고 새 계약 14개가 의도대로 실패했다. GREEN 이후 core coordinator, production integration, protocol validator와 ingress를 232개 focused 회귀로 확장했다. 통합 리뷰의 rollback/input finding은 별도 10개 RED 실패로 재현했고, 이후 physical-owner/recovery/remount findings도 각 RED 계약 뒤 GREEN으로 전환했다.

특히 다음 경계를 고정했다.

- code point/Unicode와 parser-tail 순서
- checkpoint open/assembly/write callback timeout
- commit 뒤 `sourceSeq` watermark까지 live output 대기, contiguous/FIFO/timeout 경계
- active/pending checkpoint 중 legacy output/snapshot/reset/repair/replay 혼입 금지
- held output byte/chunk cap과 failure latch
- duplicate/empty settlement token 거부
- higher stream epoch의 fresh checkpoint 요구
- reconnect 및 recoveryPending 중 requested generation과 offending generation/epoch 상한의 단조 증가
- malformed global/session frame scope, ACK rejection과 중복 failure ACK 억제
- unsupported mode preflight의 reset/resize/write 0건 원자성
- recovery latch에서도 가능한 ordered active→passive/null rollback과 fresh legacy generation
- accepted input의 정상 release, downstream reject, digest fault, supersede, dispose와 TTL expiry exactly-once settlement
- rollback 뒤 old-generation frame, apply/drain/failure/write callback의 무오염
- callback 내부 supersede 후 throw가 새 generation timer/ready를 오염하지 않음
- drain ACK의 `< sourceSeq`, `= sourceSeq`, `> sourceSeq` 경계
- failure progress의 `sourceSeq` 초과 거부
- 모든 unknown checkpoint-prefix frame의 명시 거부

## 6. 리뷰·수정·재리뷰

코어 까칠 리뷰에서는 callback failure latch, 누락 callback/assembly timeout, begin 시 ready barrier, supersede settlement, higher epoch fence, reentrancy, duplicate credit, held queue bound와 generation poisoning을 발견해 수정했다. 같은 리뷰어의 최종 판정은 정확히 `No findings`였다.

프로토콜 독립 리뷰에서는 canonical `sourceSeq` 누락, frontend ingress parser 미사용, unknown checkpoint prefix의 조용한 무시, drain ACK의 미래·부분 progress 허용을 발견했다. mirrored wire type, ingress fail-closed, exact drain/failure fence와 경계 테스트를 추가했고 같은 리뷰어의 최종 판정은 정확히 `No findings`였다.

production bridge 까칠 리뷰는 다섯 차례 수정 루프에서 ACK rejection 미라우팅, 최초 generation bootstrap 부재, fresh recovery no-op, active 중 legacy 혼입, unsupported mode 부분 mutation, commit 후 watermark 조기 실패, reconnect requested generation 손실, malformed frame silent drop, stale epoch fence 하강, 중복 failure ACK, session/global scope 오염과 recoveryPending boundary 정체를 발견했다. 모두 RED 회귀로 고정하고 수정했으며 마지막 higher-start 보강 뒤 같은 리뷰어의 최종 판정은 정확히 `No findings`였다.

Phase 통합 reviewer는 capability 철회 시 recovery latch 때문에 legacy 경로로 돌아갈 수 없는 문제와 accepted checkpoint input의 무관측 삭제를 시작으로, rollback·recovery·supersede transition의 physical owner 조기 해제, snapshot 전 input 조기 개방, legacy fault repair latch 고착, notifier 예외 뒤 input 미정산, timeout remount 뒤 snapshot 요청 누락을 발견했다. 명시적 ordered rollback, payload-free input settlement, 모든 generation transition의 공통 physical-owner fence, `legacy-recovery-pending`, runtime recreation→bounded full snapshot, session-scoped pending handoff와 explicit gate sync를 RED 회귀와 HTTPS active→passive→fresh snapshot case로 구현했다.

동일 통합 reviewer는 마지막 remount/reconnect ordering과 bounded reconnect latch handoff에 이어 post-ACK server-held tail convergence도 반복 재검토했다. 이 과정에서 timeout/abort 부재, drained identity 중복, per-ID byte 회계, `writeAndWait` rejection false-success, rollback convergence 미생성, `screenSeq` 역행 수락과 총시간 timeout을 발견해 bounded seen ledger, progress inactivity timer, physical-written 전용 tail path와 identity reducer로 수정했다. Frozen production 최종 판정은 정확히 `No findings`였다. 최신 검증은 post-ACK focused 87/87, authority/restore serial 192/192, frontend full 483/483, server full 517/517, HTTPS 5/5를 확인했다. SpecKiwi/GitHub evidence 동기화도 완료했으며, 별도 closure reviewer가 보고서/hash/상태를 감사한다.

## 7. 산출물과 봉인 해시

| 산출물 | SHA-256 |
| --- | --- |
| `frontend/src/components/Terminal/TerminalView.tsx` | `1ba5256b852d5f37ac6e6ef9a1a21f0a65c483398018361b66ecf4f515cccd64` |
| `frontend/src/components/Terminal/TerminalContainer.tsx` | `a43d90902c12577527c8624b1dce626458901426e4651a11f486175841f07f42` |
| `frontend/src/utils/visibleOutputRecovery.ts` | `447eb2eb50c95f3b7cd4a36150aa9f6119701ff3a14c69c6151428903f82113b` |
| `frontend/src/utils/terminalCheckpointRuntime.ts` | `e86f77a4e182f506cf6d4340ac6d14b2ed3814a64f744faa9f99b41acd63d38a` |
| `frontend/src/utils/terminalWriteCoordinator.ts` | `66533a279772135c8aa874396a7c0268871145b9332f0caad8228ed67bfddd38` |
| `frontend/src/utils/terminalWriteCoordinatorRuntime.ts` | `822e2d4f37f7db9e6bd082ca5ca315865ed4be4aed413d75c3c002e5bcbb55e2` |
| `frontend/src/utils/terminalRawMutationAdapter.ts` | `64df40341da990df801107c8f3442af2df6b155c770b9a36bb8e64146f1f5175` |
| `frontend/tests/unit/terminalCheckpointRuntime.test.ts` | `9b3110434a68710ef410f092930b66c6580ee532889127578aa24dbc2d6dc7d1` |
| `frontend/tests/unit/terminalWriteCoordinator.test.ts` | `69f45c227cd0414ea61349a09343626bda730b4b57eb53ca44c5853a1ef77864` |
| `frontend/tests/unit/terminalSoleWriterInventory.test.ts` | `cf5204e8a36d53aeb337f2fec430a9f2d814ee8c888572a149abe54f94f9ccfb` |
| `frontend/tests/unit/wsCheckpointProtocol.test.ts` | `07ec8802160fcee531fa6d43372e72c6da7e544e529e8ff7149e680d74722752` |
| `frontend/tests/e2e/wave3-terminal-authority-fairness.spec.ts` | `bb5bbf8aba19e2c7b13d110c8f5eac219933f289a4b6c2e7284fc48ed9faad88` |
| `ph-003/red-evidence.json` | `b3a2c47f2500363877c9ae69bb463e3408c02550d726a20177aab14135e30a14` |
| `ph-003/sole-writer-https-e2e.raw.json` | `53625bee7110f87d133d17ba93d2cf59f0d1ff8351d747a8470121c3bacb998a` |
| `terminal-write-inventory.json` | `50cc8251938428acbd06170940f33714fd52d5189dcfbb7cee64ee4b18883a41` |

Inventory schema는 `1.2.0`, input hash는 `c7ea63d951661df9aaaee50cd0a74281aea8cd04c5648bf3e5503debca563c71`이며 raw evidence SHA-256 `53625bee7110f87d133d17ba93d2cf59f0d1ff8351d747a8470121c3bacb998a`를 내부에서 동일하게 참조한다. source hash mismatch, path case 오류, password/unredacted token과 rollback input payload 노출은 0건이고 WebSocket URL credential은 `REDACTED` 상태로 저장했다.

## 8. Rollback과 남은 경계

Rollback은 checkpoint capability 광고와 admission을 닫고 명시적 `rollback-to-compatibility` command로 transaction, timer, ACK identity, queued mutation, write/input settlement와 이전 generation을 정산한다. 그 뒤 strictly-higher clean legacy generation의 fresh compatibility snapshot/reset과 post-snapshot output만 수락한다. 같은 generation 안에서 legacy와 checkpoint authority를 섞지 않으며, stale frame/callback/input은 새 generation으로 전달하지 않는다.

이 Phase는 browser sole writer와 비활성 protocol 계약을 완성한 것이며 retained server authority를 승격한 것이 아니다. 실행 중 runtime capability가 unavailable인 상태에서 activation을 거부한 것은 합격 경계다. PH-004가 server retained model shadow와 driver lease parity를 증명하고, PH-005가 제한 promotion과 rollback epoch를 통과하기 전에는 server checkpoint delivery를 활성화하지 않는다.

## 9. SpecKiwi·GitHub 동기화

- `FR-BGSTAB-022`는 `implemented`이며 AC-1~AC-7이 모두 checked 상태다. VE-2~VE-7은 본 보고서, coordinator/runtime unit test, sole-writer inventory test, HTTPS raw evidence와 sealed inventory를 각각 가리킨다.
- stable parent `REL-BGSTAB-007`에는 이번 Phase가 실제로 충족한 AC-4/AC-5/AC-12 범위의 부분 evidence만 추가했다. retained server authority와 promotion gate가 남아 있으므로 parent status는 `planned`를 유지한다.
- Completed Work Log에는 2026-07-17자 PH-003 완료 기록과 본 보고서 경로가 등록됐다.
- GitHub #10 초기 comment `https://github.com/Snoworca/BuilderGate/issues/10#issuecomment-4998030181`은 Spec 동기화 직전 보고서이므로 아래 정정 comment가 supersede한다.
- GitHub #10 첫 정정 comment `https://github.com/Snoworca/BuilderGate/issues/10#issuecomment-4998087819`는 PowerShell 파이프의 문자 인코딩 손상으로 무효이며, 아래 UTF-8 정정 comment가 supersede한다.
- GitHub #10 현재 UTF-8 정정 comment: `https://github.com/Snoworca/BuilderGate/issues/10#issuecomment-4998097292`
- `speckiwi validate` strict/fail-on-warning 결과는 error 0, warning 0이다.
- 공식 workflow worklog mutator는 기존 run worklog의 legacy schema(`SRS-W055`, `SRS-W053`) 때문에 append를 거부했다. 누락됐던 Wave 3 PM state는 진단을 보존한 채 복구했고 공식 `workflow_task_status_set`으로 T-PH003-07까지 coder state와 동기화했다. 요구사항 evidence/status/AC mutation은 정상 SpecKiwi MCP 결과를 SSOT로 삼는다.

## 10. 독립 closure audit

독립 reviewer가 봉인 해시, 전체·focused·HTTPS 검증 수치, SpecKiwi status/AC/evidence, Completed Work Log, GitHub #10의 UTF-8 superseding comment와 degraded workflow 기록을 교차 감사했다. 최초 감사의 GitHub 동기화 불일치는 현재 UTF-8 정정 comment로 해소했고, 같은 reviewer의 최종 판정은 정확히 `No findings`였다. 이에 T-PH003-07과 PH-003을 완료 처리하고 PH-004 retained server authority shadow TDD로 전이한다.
