# Wave 3 PH-002 Non-loss TerminalResourcePolicy canary 구현·검증 보고서

## 1. 결론

REL-BGSTAB-010의 non-loss canary 기반을 서버 WebSocket, 서버 PTY headless model, 브라우저 output scheduler에 구현하고 검증했다. 세 consumer 모두 기존 entry를 보존하면서 새 admission 경계에만 정책을 적용하고, 실패·중지·rollback 시 대상별 legacy policy로 복귀한다.

현재 프로덕션 stable profile registry는 서버와 프런트 모두 0개다. 따라서 사용자 설정과 기본 UI 동작은 바뀌지 않으며, 실제 프로덕션 runtime을 실행해 확인한 최종 admission 판정은 다음과 같다.

```json
{
  "eligible": false,
  "reason": "candidate-unavailable"
}
```

최종 executable evidence verdict는 `PASS_FAIL_CLOSED_CANDIDATE_UNAVAILABLE`이다.

## 2. 구현 결과

- 서버 bootstrap은 하나의 registry-derived lease authority를 `RuntimeConfigStore`, `SessionManager`, `WsRouter`에 공유한다.
- structurally valid한 lease만으로는 admission·preview·rollback을 수행할 수 없으며, 해당 target에 실제 활성화된 lease provenance와 generation이 일치해야 한다.
- WebSocket candidate backlog와 headless backlog는 정책 generation별로 보존된다. cap 감소와 rollback은 이미 수락된 entry의 bytes, expiry, ordering, ready/recovery metadata를 바꾸지 않는다.
- rollback은 새 admission을 먼저 legacy policy로 전환하고, rollback 시작 시점의 pre-boundary entry만 원래 FIFO와 lifetime으로 drain한 뒤 ledger를 닫는다. rollback 이후의 legacy output은 이전 boundary 종료를 굶기지 않는다.
- application-level candidate send/write 실패는 대상 canary만 legacy로 정산한다. 기존 reliable queue를 지우거나 transport reconnect를 강제하지 않는다. 외부 peer/network disconnect만 기존 연결 정리 경로를 사용한다.
- WS coalescing은 generation뿐 아니라 expiry, ready, recovery generation, source, exactly-once identity가 모두 같을 때만 허용한다.
- 프런트는 stale·duplicate generation을 state-preserving 방식으로 거부하고, candidate cap 감소나 fallback 때 기존 retained FIFO를 유지한 채 새 admission budget을 분리한다.
- server sequence, replay token, authority epoch/revision, restore attempt 및 xterm identity를 이어 전달해 refresh·reconnect·renderer 재생성 중 late callback이 새 authority를 침범하지 못하게 했다.
- 세 consumer의 transition ledger는 bounded·immutable·payload-free이며, policy/profile, 이전·다음 decision, generation, accepted/rejected reason, rollback 결과를 기록한다.

## 3. Acceptance Criteria 근거

| AC | 판정 | 핵심 근거 |
| --- | --- | --- |
| AC-1 | PASS | stable contract, capability, explicit target selection, active lease provenance가 모두 확인된 경우만 candidate가 된다. production shared-authority 및 inactive/spare lease 회귀 테스트와 프런트 zero-profile coordinator가 비선택 대상을 legacy로 유지함을 검증했다. |
| AC-2 | PASS | cap 증가·감소, N-1/N/N+1, maxChunks, production PTY, WS production route, 프런트 retained FIFO/compaction/fallback 회귀가 기존 entry와 새 admission budget의 분리를 검증했다. grandfathered backlog는 재해석·drop되지 않는다. |
| AC-3 | PASS | direct/observe/enforce candidate failure 및 overflow가 forced reconnect를 일으키지 않고 reliable queue를 보존함을 검증했다. 프런트 restore-buffer 실패는 stale/FAILED_HELD ownership을 유지하며 권위 증명 전 ACK·direct recovery write·silent drop을 허용하지 않는다. |
| AC-4 | PASS | 서버 WS, 서버 headless, 프런트 scheduler 각각에 대해 bounded ledger의 정확한 suffix, event ordering, immutable payload-free record를 검증했다. 3 consumer × AC-1~AC-6의 정확한 18-cell evidence matrix를 생성했다. |
| AC-5 | PASS | compiler/profile/consumer mismatch, inactive·revoked lease, send/write failure, saturated ingress, unproven authority lineage가 해당 target만 legacy로 정산함을 검증했다. 다른 client/session, PTY producer와 shared authority state는 불변이다. |
| AC-6 | PASS | WS와 headless의 모든 pre-boundary generation, async callback/write fence, 프런트 rollback·retry·restore single-flight를 검증했다. rollback 중 새 legacy admission은 허용하되 이전 boundary의 FIFO drain과 ledger closure를 방해하지 않는다. |

## 4. Executable evidence

가드는 repository의 REL-BGSTAB-010 test source를 탐색하고, 실행된 TAP의 정수 구조(`tests/pass/fail/cancelled/skipped/todo`)와 named test 수를 교차 검증한다. 누락·중복·skip·cancel·todo·malformed summary는 모두 fail-closed 처리한다.

| 항목 | 결과 |
| --- | ---: |
| 서버 focused | 42/42 PASS |
| 프런트 focused | 133/133 PASS |
| 정확히 이름이 등록된 REL-BGSTAB-010 테스트 | 60 |
| 추가 authority-lineage 테스트 | 15 |
| consumer × AC matrix | 18/18 PASS |
| 서버 전체 회귀 | 517/517 PASS |
| 프런트 전체 unit 회귀 | 376/376 PASS |
| 서버 typecheck/build | PASS |
| 프런트 typecheck | PASS |
| `git diff --check` | PASS |

프런트 focused에는 scheduler, TerminalView, TerminalContainer뿐 아니라 mandatory production source인 `visibleOutputRecovery.ts`의 전용 회귀 파일도 포함한다. 다음 세 authority-lineage 테스트를 각각 AC-3, AC-6, AC-5에 등록했다.

- `restore-needed and snapshot authority proof is exact and fail-closed`
- `coalesced UTF-8 output expands to exact recovery chunks without losing identity`
- `coalesced recovery output rejects the whole batch before a later stale segment can partially apply`

## 5. 프로덕션 activation 경계

가드는 source text의 상수를 하드코딩해 추정하지 않는다.

- 서버는 `TerminalResourcePolicyRuntime.ts`를 실제 실행해 registry snapshot과 production authority selection을 읽는다.
- 프런트는 zero-profile `createTerminalOutputPolicySelectionCoordinator()`와 `createTerminalOutputPolicyRuntime()`을 실제 실행한다.
- 양쪽 결과는 stable profile 0개, selected profile 0개, `legacy/candidate-unavailable`이다.
- 양쪽 empty registry hash는 `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`다.
- OBS-BGSTAB-005 trusted observation manifest와 production runtime registry는 서로 다른 evidence 항목으로 기록한다.
- `server/src/index.ts`, server runtime/protocol/WS/headless 파일과 frontend `WebSocketContext`, protocol, runtime context, TerminalView/Container, scheduler/recovery 파일을 tool-owned mandatory production source set으로 해시한다.

## 6. 산출물과 봉인 해시

| 산출물 | SHA-256 |
| --- | --- |
| `tools/wave3/canary-admission-evidence.test.mjs` | `ed7c177b437d528a71700bbf9f800eb31772592e631d8bc28242235f7ae1b778` |
| `ph-002/green-evidence.json` | `4029bb020f6b15a56681b0c163b36c84373ed27508e3ef5e4ecc152398b17d6a` |
| `canary-admission-evidence.json` | `e02ed9609e9ded65e18d577e27426ac80d90f01d787a57605b9299f1e3d5b0ae` |
| 봉인된 `ph-002/red-evidence-iteration10.json` | `4ebd24ac98bcce70e75013344c47cacd423bfa38838792abdd7641e2e2832859` |

historical RED iteration 10은 변경하지 않았다. GREEN은 RED 당시의 입력 해시를 그대로 historical baseline으로 보존하고, 현재 reviewed regression corpus는 별도 해시 집합으로 기록한다.

기본 guard 실행은 완전 read-only다. GREEN과 admission artifact는 명시적인 `--regenerate-green` 실행에서만 갱신한다. 테스트 실행 시간처럼 의미와 무관한 raw stdout 변동은 artifact에서 제외하고, 정렬된 test name과 TAP 정수 구조의 deterministic semantic hash를 사용한다. 재생성 직후 기본 guard를 연속 두 번 실행했으며 artifact SHA-256은 세 시점 모두 `e02ed9609e9ded65e18d577e27426ac80d90f01d787a57605b9299f1e3d5b0ae`로 동일했다.

## 7. 리뷰·수정·재리뷰

최종 구현 코드가 `No findings`를 받은 뒤 evidence rebase를 수행했다. Evidence 전용 까칠 리뷰에서 `visibleOutputRecovery.ts`가 mandatory production hash에는 포함됐지만 대응 테스트 파일이 focused corpus에서 빠졌다는 HIGH finding 1건을 발견했다.

해당 테스트 파일 16개를 focused 실행에 추가하고, 핵심 authority-lineage 3개를 AC-3/AC-5/AC-6 matrix에 연결했다. GREEN과 admission artifact만 다시 생성한 뒤 default guard, 전체 회귀, diff check를 재실행했다. 같은 리뷰어의 최종 재평가 결과는 정확히 `No findings`였다.

## 8. 남은 경계

이 Phase는 canary 기반과 fail-closed evidence를 완성한 것이며 프로덕션 enforcement를 활성화한 것이 아니다. stable profile은 여전히 0개다. 후속 Phase에서 stable contract를 등록하려면 동일한 executable gate, non-loss rollback, authority-lineage 및 전체 회귀 evidence를 다시 통과해야 한다.
