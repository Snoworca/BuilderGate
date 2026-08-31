# Wave 3 PH-004 retained server model shadow·driver lease 구현 보고서

> 상태: 구현, 전체 회귀, HTTPS 실행, 독립 구현 리뷰와 artifact 의도 재감사까지 완료했다. 두 최종 판정은 모두 정확히 `No findings`다. Retained checkpoint delivery와 single authority 승격은 의도대로 아직 비활성이다.

## 1. 결론

`REL-BGSTAB-011`의 session-owned retained model shadow와 explicit driver lease를 기존 headless commit chain에 구현했다. PTY output은 session별 `streamEpoch/sourceSeq` 순서로 retained state와 semantic fact를 먼저 commit하고, 성공 또는 관측 가능한 degradation 정산 뒤에만 기존 legacy delivery로 전달된다. Input, resize와 query reply는 실제 `WsRouter` 경로까지 client/view/lease/authority generation으로 fencing된다.

이 Phase는 새 authority를 활성화하지 않는다. 현재 browser hard refresh 5/5는 기존 legacy snapshot 복구를 입증하지만 local cache가 없는 상태에서 retained server checkpoint만으로 configured range 전체를 복구하는 계약은 아직 입증하지 못했다. 따라서 machine gate는 `eligible=false`, `reason=no-local-cache-retained-authority-unproven`, `verdict=PASS_FAIL_CLOSED`다. 이는 실패를 숨긴 것이 아니라 PH-005 promotion을 차단하는 의도된 합격 경계다.

## 2. 구현 결과

- 기존 `SessionManager` headless terminal을 재사용해 source record, snapshot identity, retained markers, fact ledger와 lease state를 session lifecycle에 결합했다. 별도 terminal model을 중복 생성하지 않았다.
- `sourceSeq`는 PTY ingest에만, `snapshotSeq`는 output commit과 resize checkpoint 변화에 사용해 resize가 가짜 PTY sequence를 소비하지 않는다.
- normal/alternate buffer, logical line와 cell attribute, Unicode width, cursor/saved cursor, modes, rows·cols/reflow, incomplete parser tail과 oldest retained marker를 checkpoint에 보존한다.
- OSC 0/2 title, OSC 7 cwd, BEL, DSR query는 split BEL/ST parser state와 record-local ordinal identity로 deduplicate하며, commit·overflow·degradation·write failure 경로에서 각각 committed 또는 rejected로 정확히 한 번 종결한다.
- operation/fact ledger는 정책 byte limit에 맞춰 eviction하며, 매 commit마다 전체 배열을 stringify하지 않고 append/remove 증분 byte 회계로 exact JSON structural byte를 유지한다. 1,024 UTF-8 byte를 넘는 semantic key는 길이를 포함한 SHA-256 canonical key로 제한한다.
- shadow comparer는 모든 session headless write가 idle일 때만 최소 5초 간격으로 독립 roundtrip model과 비교한다. Generation fence와 unref timer를 사용하며 결과는 delivery/runtime authority를 변경하지 않는다.
- 실제 WebSocket negotiation에서 observer view도 등록하지만 mutation lease는 한 client만 소유한다. Observer의 identity 없는 input/resize는 명시적으로 거부되고, driver disconnect 뒤 observer가 재협상해 deterministic하게 lease를 얻는다.
- 자연 종료, stop/delete, replacement와 router destroy는 model admission을 닫고 lease/view를 정산한다. 종료된 PTY generation의 늦은 output/exit 또는 stale mutation은 새 generation을 오염시키지 않으며 bounded rejection tombstone에 사유와 횟수를 남긴다.
- model/policy settler가 실패해도 PTY producer와 기존 renderer delivery는 유지된다. 해당 session의 canary promotion만 fail-closed로 차단한다.
- 사용자 keyboard/local echo/prompt redraw/cursor/ticker/waiting repaint가 AI TUI session을 `running`으로 바꾸지 않는 idle invariant를 유지한다.

## 3. Acceptance Criteria 판정

| AC | 판정 | 근거 |
| --- | --- | --- |
| REL-BGSTAB-011 AC-1 | PASS | session stream/source sequence와 model-commit-before-delivery를 실제 headless queue·failure 경계까지 검증했다. |
| AC-2 | PASS | normal/alternate retained state, cells/attributes, Unicode, cursor/modes, geometry/reflow, parser tail와 snapshot/oldest identity를 checkpoint roundtrip으로 검증했다. |
| AC-3 | PASS | model ledger, checkpoint/transport compatibility field를 typed policy로 구분하고 overflow를 empty success가 아닌 typed rejection/degradation으로 처리한다. PH-006의 per-client credit/socket scheduler는 parent 후속 범위다. |
| AC-4 | PASS | independent roundtrip comparer가 5초 low-duty/global-idle fence에서 42개 등록 축 중 해당 state 축을 비교하고 delivery authority를 바꾸지 않는다. |
| AC-5 | PASS | split semantic facts와 duplicate/overflow/write-failure/throwing-settler를 committed 또는 observable rejection으로 exactly-once 정산한다. |
| AC-6 | PASS | 1/2/8-client와 실제 두 WebSocket의 claim, observer rejection, disconnect/rebind, replacement stale mutation을 검증했다. |
| AC-7 | PASS | degradation/mismatch/lease failure가 promotion만 차단하고 PTY·legacy delivery·다른 client/session을 멈추지 않는다. |
| AC-8 | PASS | AI TUI idle invariant 회귀가 GREEN이며 사용자 입력·repaint는 status를 running으로 전이하지 않는다. |
| AC-9 | PASS | natural exit, explicit stop/delete, generation replacement, router destroy와 late callback rejection/ledger cleanup을 검증했다. |
| REL-BGSTAB-007 | 부분 PASS | retained model/fact/sequence/lease와 bounded shadow 기반을 구현했다. no-local-cache authority recovery, promotion, fair delivery와 hidden reveal은 PH-005~007이 남아 parent status는 `planned`를 유지한다. |

## 4. 실행 증거

| 항목 | 결과 |
| --- | ---: |
| strict TDD RED | 30 등록 / compatibility 12 PASS / 신규 계약 18 expected FAIL |
| PH-004 exact focused | 57/57 PASS |
| 고정 coverage registry | 42축: 41 PASS, retained no-local-cache 1 not-proven |
| 서버 전체 회귀 | 517/517 PASS |
| 프런트 전체 unit | 485/485 PASS |
| 프런트 production build | PASS |
| HTTPS Desktop Chrome | 5/5 PASS |
| `git diff --check` | PASS; line-ending conversion warning만 존재 |

Focused artifact는 test 이름 57개와 coverage axis ID 42개의 정렬 SHA-256을 각각 `1e7da1ab816128c69d68e7e9e2922acdc324b65a91038429e9a0c6d8c7ba1a0f`, `e45cb0525ad44a3b2b22e02439efaefd3eba0744b9fe582206675babec912573`으로 고정한다. Test/axis 삭제뿐 아니라 같은 수를 유지한 ID 교체도 `coverage-threshold-failed`로 거부한다. Source, test body, assertion anchor, raw evidence와 tool hash mismatch는 0건이다.

HTTPS 명령은 `frontend`에서 다음과 같이 실행했다.

```text
npx playwright test tests/e2e/wave3-terminal-authority-fairness.spec.ts --project "Desktop Chrome"
```

실제 `https://localhost:2222`에서 no-cache hard refresh, same-session remount, controlled active checkpoint ingress, active→passive rollback과 wire/coordinator fault 5개 case가 통과했다. 실행 중인 Node 및 BuilderGate 프로세스는 종료·재시작하지 않았다. 이 결과 중 hard refresh는 legacy snapshot characterization이며 retained authority promotion 증거로 잘못 해석하지 않는다.

## 5. 리뷰·수정·재리뷰

까칠 구현 reviewer는 초기 구현 이후 commit-before-delivery, semantic settlement, ledger hot path, driver lifecycle, 실제 WebSocket observer mutation, Ordinal64 rollover, comparer duty cycle와 old PTY generation callback 경계를 네 차례 재검토했다. 발견된 사항마다 회귀 테스트를 먼저 추가하고 구현을 수정했다.

최종 구현 reviewer는 exact 57/57, literal 42축, server 517/517, build/typecheck와 lifecycle/protocol 경계를 다시 실행·대조한 뒤 정확히 `No findings`를 반환했다. 별도 artifact intent reviewer는 test/axis allowlist, AST test body, assertion anchor, mutation fail-closed proof와 no-local-cache 판정의 진실성을 독립 재감사했고 정확히 `No findings`를 반환했다.

## 6. Authority 경계와 rollback

PH-004에서 legacy delivery/responder가 계속 권위자이며 retained model은 shadow다. Checkpoint delivery, single responder handoff와 browser no-local-cache retained recovery는 활성화하지 않는다. Shadow mismatch, model degradation, missing mutation identity 또는 lease failure가 발생하면 canary eligibility를 닫고 기존 delivery를 유지한다.

Rollback은 retained admission/comparer를 닫고 lease/view/timer/pending semantic settlement를 session generation 단위로 정산하면 된다. 이미 socket에 실린 legacy output 순서를 재정렬하거나 PTY를 pause하지 않는다. PH-005는 이 기반 위에서 old admission stop → disable ACK → stale lease revoke → new lease/responder → fresh checkpoint의 single-authority epoch를 별도 TDD로 구현해야 한다.

## 7. 봉인 해시

| 산출물 | SHA-256 |
| --- | --- |
| `server/src/services/RetainedTerminalAuthority.test.ts` | `00b6d2e3e390f03e8c9e5f6e7282e46361a4868f2384b03aaa3fed75b8b6974c` |
| `server/src/services/SessionManager.ts` | `477cd762c10a37250b83f0ea941ebad8502000fe99d39e89364c0975b25e7dbe` |
| `server/src/ws/WsRouter.ts` | `aad79c7551ac177217caf7002c00942ace5797d0c0bbf23dfdc18207e48eaa15` |
| `server/src/ws/WsRouterCheckpointProtocol.test.ts` | `4b07d54473fee4b1fd9c7ef8ec361e13ea60291f3a85590ae917a9d68bc7a50c` |
| `tools/wave3/retained-shadow-parity.test.mjs` | `59d856642bcc3e0d92ebea885b589477562859c75bc5287b31b1832a931ffe8d` |
| `retained-shadow-parity.json` | `9914e22418e315184ef7cdc315b95b57d693efbe6ad6f84da144ac59a248e265` |
| `ph-004/red-evidence.json` | `c45d67f2b8a827f8f19d63f0b751929846b6fb4362ed03b2b654fc8ab1725aed` |
| plan sidecar | `a4ddeb529693dbfde52fd4dfe7def3df49e70542b8915a4feac4c300e531bb20` |

`green-evidence.json`은 위 해시와 최신 57/57·42축·517/517·485/485·5/5 결과를 machine-readable하게 보존한다.

## 8. 다음 Phase gate

`REL-BGSTAB-011`은 본 Phase evidence와 exact `No findings`를 근거로 `implemented`까지 올릴 수 있다. 그러나 `REL-BGSTAB-007`은 stable parent이고 retained no-local-cache recovery가 아직 not-proven이므로 `planned`를 유지한다. PH-005의 `MIG-BGSTAB-002`는 현재 `planned/evolving`이며 사용자 `--auto` 지시에 따라 strict TDD RED에서 시작한다.

SpecKiwi에는 `REL-BGSTAB-011` VE-2~VE-6, AC-1~AC-9, `implemented`와 Completed Work가 등록됐고, `REL-BGSTAB-007`은 부분 evidence VE-5~VE-6만 추가한 채 `planned`를 유지한다. GitHub #11 최초 구현 보고 `issuecomment-4999195944`는 pre-closure artifact hash를 담고 있어, 최신 Spec hash·artifact·workflow 보정을 포함한 UTF-8 정정 보고 `issuecomment-4999298118`이 supersede한다.

Closure 1차 감사에서 Spec 동기화 뒤 stale artifact input hash, 누락된 fallback checklist/task checkpoint, stale PM projection과 PH-004 pipeline event 누락을 발견했다. Artifact를 최신 Spec hash로 재실행하고 `mismatches=0`을 확인했으며, checklist·task JSON·PM/state/worklog를 동기화했다. 공식 `workflow_pipeline_emit`은 기존 pipeline의 `SRS-W055` 4건과 `SRS-W053` 1건 때문에 거부되어 진단을 state/worklog에 보존한 뒤 UTF-8 degraded fallback event를 기록했다.

후속 종료 감사에서는 GitHub/local report projection, PM degraded-workflow 경계, PH-004 task requirement trace를 추가 보정했다. 모든 보정 뒤 독립 종료 reviewer가 artifact·SpecKiwi·GitHub·checklist·task·PM/state/worklog/pipeline 전체를 다시 대조했고 최종 판정은 정확히 `No findings`였다. 따라서 PH-004는 완료하며, authority delivery 승격은 여전히 비활성인 상태로 PH-005 positional responder handoff의 strict RED로 넘긴다.
