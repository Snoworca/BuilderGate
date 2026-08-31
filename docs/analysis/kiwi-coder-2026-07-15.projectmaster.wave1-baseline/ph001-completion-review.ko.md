# Wave 1 PH-001 완료 독립 리뷰

## 리뷰 범위

- 작업: `T-PH001-06` — Split characterization 까칠한 Phase 리뷰
- Requirement: `REL-BGSTAB-006`
- 기준 계획: `docs/plans/2026-07-15.projectmaster.wave1-baseline.plan.md`
- TDD sidecar: `docs/plans/2026-07-15.projectmaster.wave1-baseline.sidecar.json`
- 원시 evidence: `docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/split-characterization.json`
- 구현·회귀: `frontend/tests/e2e/wave1-characterization-artifacts.ts`, `frontend/tests/e2e/wave1-characterization-artifacts.test.ts`, `frontend/tests/e2e/wave1-split-characterization.spec.ts`
- 이력: `.kiwi/sessions/2026-07-15.projectmaster.wave1-baseline/tasks/T-PH001-01.json`부터 `T-PH001-05.json`까지

## 판정

PH-001의 계획 DoD와 `REL-BGSTAB-006` AC-1~AC-5를 모두 충족한다. 실제 production split은 활성화되지 않았고, 현 runtime은 `unified`로 관측되었다. standalone split handshake의 13개 실패는 숨기거나 통과로 오인하지 않고 `mismatch` 원시 evidence로 보존되었다. restore 또는 supersede 결정은 내려지지 않았으며 disposition은 `unresolved`다.

## AC 전수 대조

| AC | 독립 확인 결과 | 판정 |
| --- | --- | --- |
| AC-1 | artifact에 `srs_expected`, `production_runtime_observed`, `test_observed` 세 종류가 각각 한 행씩 존재한다. 각 행은 `buildId`, effective mode, case ID, source, command, observed result를 보존한다. Git commit은 `ca111fef3b5a5a25d3aa488415c929e90ade46fd`이고 dirty 상태를 별도 표시한다. | 충족 |
| AC-2 | Playwright가 `https://localhost:2222` 로그인 후 `wss://localhost:2222/ws`의 `connected` frame과 non-empty client ID를 확인하고, 같은 socket에서 명시적 ping 이전/이후 pong count 증가를 상관시킨다. `server/src/index.ts`의 `WsRouter` construction·`/ws` upgrade dispatch와 `WebSocketContext.tsx`의 production URL/new WebSocket seam도 검증한다. artifact에는 인증 여부만 남기고 client ID와 token은 제거한다. | 충족 |
| AC-3 | standalone observation은 `test_observed`, `standalone-injected-split-handshake`, `wss.emit('connection', ...)`, metadata injection으로 production observation과 분리된다. standalone만 제공하거나 production actual-path evidence가 빠지면 completion guard가 거부한다. | 충족 |
| AC-4 | 네 mismatch 행 모두 exact Requirement 또는 test target, referentially valid production case, verdict, reproduction case ID, evidence reference를 갖는다. 집계 `match=1`, `mismatch=1`, `not_exercised=2`가 원시 행 재집계와 일치한다. runtime config와 browser wire mode는 서로 강제 동치화하지 않고 독립 필드로 보존한다. | 충족 |
| AC-5 | artifact와 guard가 `disposition=unresolved`, `splitActivationEnabled=false`, `mutatesExistingSrs=false`를 강제한다. `FR-BGSTAB-006/007` 블록은 HEAD와 동일하고 product runtime/default/UI seam에는 diff가 없다. | 충족 |

## 증거 무결성 및 비밀정보 검토

- 독립 구현한 Python canonical JSON(`sort_keys=True`, compact separators, UTF-8)으로 `digestAlgorithm`과 `contentDigest`를 제외한 payload를 재계산했다.
- 주장 digest: `d54487ef941f53c165dcc0c1878ea62e5cda1f5843fcca3c3e84294cd6999fda`
- 재계산 digest: `d54487ef941f53c165dcc0c1878ea62e5cda1f5843fcca3c3e84294cd6999fda`
- artifact에서 `1234`, `token=`, `authenticatedConnectedClientId`는 모두 검출되지 않았다. terminal raw output도 저장하지 않는다.
- `FR-BGSTAB-006` normalized block SHA-256은 HEAD와 현재 모두 `df2ebdd3f303a644a1f0afb91727c198f246067172f7e577006c01b027a63234`다.
- `FR-BGSTAB-007` normalized block SHA-256은 HEAD와 현재 모두 `3b10288abcf0909a5a94c79ffd6fd97a6f9c6bad01f61f751f142c89c283b1e4`다.
- `frontend/src/utils/webSocketUrl.ts`, `frontend/src/contexts/WebSocketContext.tsx`, `server/src/index.ts`, `server/src/ws/WsRouter.ts`, `server/config.json5.example`, `frontend/package.json`에는 diff가 없다. 현재 작업의 제품 runtime, default, UI 동작 변경은 없다.

## 자동 검증 재현

| 검증 | 결과 |
| --- | --- |
| `npx playwright test tests/e2e/wave1-split-characterization.spec.ts --project "Desktop Chrome" --reporter=line` | PASS, 2/2; digest와 verdict 재현 |
| `node --experimental-strip-types --test tests/e2e/wave1-characterization-artifacts.test.ts` | PASS, 3/3 |
| 변경 파일 한정 ESLint | PASS |
| `npm run typecheck` (frontend) | PASS |
| `npm run build` (server) | PASS |
| `node --test --test-reporter=tap dist/ws/wsTransportMode.test.js` | PASS, 6/6 |
| `node --test --test-reporter=tap dist/ws/WsRouterSplitHandshake.test.js` | expected observed mismatch, 3/16 PASS·13/16 FAIL; artifact와 일치 |

저장소 전체 `npm run lint`는 이 Phase가 변경하지 않은 기존 FileManager·hook·기존 test 파일 등의 42개 오류로 실패했다. PH-001 변경 파일 한정 lint, 전체 frontend typecheck, server build는 모두 통과했으며 전체 lint 오류를 이번 Phase의 회귀로 분류할 근거는 없다.

## TDD·리뷰 이력 정합성

- T-PH001-01과 T-PH001-03은 계획된 실패 signature만 발생한 RED evidence를 보존한다.
- T-PH001-02와 T-PH001-04는 대응 GREEN evidence 및 이전 reviewer finding의 수정·재리뷰 이력을 보존한다.
- T-PH001-05는 test-only exporter, atomic write, 독립 digest, 민감정보 제거와 두 독립 reviewer의 최종 `No findings`를 보존한다.
- sidecar의 task dependency, AC coverage, test case ID 및 RED/GREEN evidence는 개별 task state와 일치한다.

## 최종 결론

차단 finding은 없다. `REL-BGSTAB-006`은 restore/supersede 또는 split activation 판단이 아니라 정직한 unresolved characterization evidence로 구현 완료 상태에 올릴 수 있다.

Verification: Tier 2 automated checks and sub-agent review completed.

No findings
