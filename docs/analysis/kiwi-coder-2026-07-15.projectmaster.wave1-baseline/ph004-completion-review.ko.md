# Wave 1 PH-004 G1 결정 게이트 까칠한 독립 리뷰

## 판정

No findings

최초 리뷰의 HIGH 1건은 strict-TDD로 수정됐고 같은 리뷰어의 재평가에서 해소를 확인했다. 현재 Wave 1은 아직 `in_progress`, T-PH004-05는 `running`, Wave 2는 `pending`이므로 이 판정 자체가 후속 상태를 선행 mutation하지 않는다.

## Finding 해결 이력

### FND-PH004-001 — HIGH — evaluator가 Wave 1 closure 전에 Wave 2를 `eligible`로 선언한다

- 계획 계약: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md`는 앞 wave가 성공 완료된 뒤에만 다음 wave를 순차 활성화하고, 각 Phase의 까칠한 reviewer `No findings`를 완료 gate로 요구한다.
- 현재 PM 상태: `.kiwi/sessions/2026-07-15.projectmaster.wave1-baseline/pm-state.json`에서 T-PH004-05는 `running`이고 Wave 1은 아직 닫히지 않았다.
- 현재 실제 진행 상태: `kiwi/waves.jsonl`은 Wave 1을 `in_progress`, Wave 2를 `pending`으로 유지하므로 아직 실제 mutation은 발생하지 않았다.
- 문제 구현: `tools/wave1/g1-decision-gate.mjs:246-255`는 prerequisite artifact와 stable authority Requirement만 만족하면 즉시 `wave-1: characterization-complete`, `wave-2: eligible`을 반환한다. evaluator 입력·denial에는 PH-004 최종 리뷰, MIG-BGSTAB-001 완료, Wave 1 completion marker가 없다.
- 문제 기록: `g1-decision-record.json`의 `evaluation.activationState`도 동일하게 Wave 2를 무조건 `eligible`로 봉인한다. 바깥쪽 `activationSemantics.wave2EligibleAfterWave1Closure=true`는 evaluator 결과를 바꾸거나 강제하지 않는 서술 boolean일 뿐이다.
- 독립 재현: 현재 T-PH004-05가 실행 중인 상태에서 `node --test tools/wave1/g1-decision-gate.test.mjs`가 6/6 PASS하고, decision record 입력을 재평가하면 `result=allow`, `wave-2=eligible`이 그대로 나온다.

영향: 수정 전 gate evaluation을 다음 wave 오케스트레이터가 machine-readable activation SSOT로 소비하면 mandatory review와 Wave 1 closure를 건너뛰고 Wave 2를 조기 활성화할 수 있었다.

요구했던 수정:

1. G1 decision 유효성과 실제 Wave 2 활성화를 분리한다.
2. T-PH004-04 시점의 evaluator 결과는 최소한 `wave-2: eligible-after-wave1-closure` 또는 `pending-wave1-closure`처럼 조건부 상태를 반환하고 `wave-1`을 완료로 단정하지 않아야 한다.
3. 실제 `eligible` 또는 `in_progress` 전이는 T-PH004-05 `No findings`, MIG-BGSTAB-001 완료 evidence/status, Wave 1 completion event가 모두 확인된 뒤 별도 오케스트레이션 단계에서만 수행한다.
4. T-PH004-05가 미완료인 fixture에서 `wave-2=eligible`을 거부하는 회귀 테스트와, closure 이후에만 활성화되는 테스트를 추가한다. 단, 테스트가 `waves.jsonl`이나 SRS를 직접 mutate해서는 안 된다.
5. 수정된 evaluator 결과로 `g1-decision-record.json`을 다시 생성하고 digest/deep-equality를 재검증한다.

### 재평가 결과 — 해결됨

- RED evidence: `ph004-fnd001-red-evidence.json`은 기존 7개 중 2개가 의도한 failure로 실패했고, 조기 `characterization-complete/eligible` 및 activation evaluator 부재를 직접 포착했다.
- GREEN evidence: `ph004-fnd001-green-evidence.json`은 7/7 PASS와 decision-record deep equality를 기록한다.
- `evaluateG1Decision()`은 입력에 완료를 가장한 lifecycle evidence를 붙여도 `evaluationStage=decision`, `wave-1=pending-wave1-closure`, `wave-2=eligible-after-wave1-closure`, `activationReadiness.ready=false`를 유지한다.
- 실제 활성화는 별도 `evaluateG1Activation()`만 수행한다. T-PH004-05 exact task/verdict/reference, MIG-BGSTAB-001 exact ID/status/reference, Wave 1 exact target/status/completion-event reference가 모두 맞아야만 `wave-2=eligible`이다.
- review task·verdict·reference, MIG ID·status·reference, Wave target·status·reference를 각각 누락 또는 오염한 9개 독립 변형은 모두 `ready=false`와 해당 machine-readable pending reason을 반환했다.
- 새 decision record 파일 SHA-256은 `5a3d552a81a5f8ad7baa464ab3c008375b82f13e4496497974c8e44a5e7c0fc0`이고, 재평가 결과와 byte-equivalent deep equality를 이룬다.
- 수정 중 SRS, PM state, `waves.jsonl`, UI, product default, authority, budget, legacy 삭제 mutation은 없었다.

## 독립 검증 결과

| 검증 | 결과 |
| --- | --- |
| `node --check tools/wave1/g1-decision-gate.mjs` 및 test 파일 | PASS |
| `node --test tools/wave1/g1-decision-gate.test.mjs` | PASS 7/7; FND-PH004-001 decision/activation 분리 회귀 포함 |
| decision input 재평가 ↔ 봉인된 `evaluation` deep equality | PASS |
| decision-stage에 완료 lifecycle evidence를 첨부한 음성 검증 | PASS; 첨부값을 무시하고 closure 전 조건부 상태 유지 |
| final activation 3 prerequisite 누락·오염 9개 변형 | PASS; 전부 `ready=false`, Wave 2 실제 eligible 금지 |
| `g1-evidence-audit.json` 파일 SHA-256 ↔ decision record | PASS |
| split/retained/benchmark raw·summary artifact 파일 SHA-256 | 모두 PASS |
| PH-001/002/003 review 파일 SHA-256 및 최종 verdict | 모두 PASS, `No findings` |
| artifact 내부 content digest ↔ audit content digest | 모두 일치 |
| SpecKiwi MCP strict + fail-on-warning validation | PASS, error 0, warning 0 |
| `speckiwi links check --json` | PASS, 162개 검사, broken 0 |
| active target 및 prerequisite Status | `wave-1`; REL-BGSTAB-006/OBS-BGSTAB-004/PERF-BGSTAB-008 모두 `implemented` |
| stable authority Requirement | REL-BGSTAB-007 존재, Target=`wave-3`, Status=`planned`, Stability=`stable` |

## MIG-BGSTAB-001 AC 대조

| AC | 판정 | 근거 |
| --- | --- | --- |
| AC-1 | 충족 | 세 evidence family의 Requirement ID, reference, run/build ID, content digest가 기록됐고 파일·내부 digest를 독립 재검증했다. |
| AC-2 | 충족 | exact two-value enum이며 선택/반대 분기 evidence reference가 machine-readable하게 존재한다. 사용자 발화 세 건을 결합하면 Orca식 구조 교체 허용과 전체 wave 진행 의사가 명시된다. |
| AC-3 | 충족 | 선택 branch는 migration이며 local fix authorization은 비어 있다. bug-only 음성 계약도 테스트한다. |
| AC-4 | 충족 | 별도 exact ID REL-BGSTAB-007이 실제 SRS에 Stability=`stable`로 존재하고 필수 다섯 경계를 포함한다. |
| AC-5 | 충족 | gate 결과는 authority promotion, UI 시각 변경, legacy 삭제, retained/memory/checkpoint budget을 모두 false로 기록한다. 실제 diff에도 해당 default·authority·삭제 mutation은 없다. |
| AC-6 | 충족 | decision validity와 activation readiness가 분리됐고, 현재 조건부 상태·세 closure check·pending reasons 및 최종 resulting state가 machine-readable하게 기록된다. |

## REL-BGSTAB-007 계약 대조

- AC-1/AC-6/AC-11은 기존 사용자 의미 설정을 source로 삼되 새 numeric default, aggregate/chunk/inflight 숫자, WebGL/binary/split 기본화와 UI 변경을 승인하지 않는다.
- AC-3~AC-5는 ordered retained state, sequence/epoch/checkpoint, sole-writer ACK와 failure convergence를 구체적으로 정의한다.
- AC-8/AC-10은 local cache의 비권위성 및 server restart·PTY 종료·offline-only 비보장 경계를 명시한다.
- AC-12는 shadow/canary/limited promotion과 epoch 기반 rollback을 명시하며 byte tail 임의 결합을 금지한다.
- REL-BGSTAB-007 구현은 Wave 3 대상이며, Wave 2는 authority promotion을 제외한다. Wave 3~5와 GitHub #8~#22는 현재 deferred 상태가 맞다.
- 이 계약에서 추가 finding은 발견하지 못했다.

## 범위·상태 최종 확인

- 사용자 발화 세 건은 Orca식 구조 교체 허용과 해당 wave 계획의 끝까지 진행을 함께 명시하므로 `architectural migration` 선택 근거로 충분하다. 이는 개별 UI/default/budget/deletion 승인이 아니다.
- REL-BGSTAB-007은 별도 exact ID, Target=`wave-3`, Status=`planned`, Stability=`stable`이며 configured range, browser/server authority, eviction, checkpoint와 compatibility 경계를 모두 정의한다.
- REL-BGSTAB-007 AC-10은 server restart·PTY 종료·offline-only를 보장 밖으로 명시하고, AC-12는 shadow/canary/limited promotion 및 epoch 기반 rollback을 명시한다.
- Wave 2는 Wave 1 closure 이후에만 eligible이고 authority promotion은 범위 밖이다. Wave 3~5 및 GitHub #4~#22는 해당 wave/Requirement gate까지 deferred다.
- 현재 `kiwi/waves.jsonl`은 Wave 1 `in_progress`, Wave 2~5 `pending`을 유지한다.
- SpecKiwi validation은 error/warning 0, wave-1 summary는 prerequisite 3건 `implemented`와 MIG-BGSTAB-001 `in_progress`, wave-3 summary는 REL-BGSTAB-007 `planned/stable`, links check는 162개 중 broken 0이다.

## 최종 verdict

No findings
