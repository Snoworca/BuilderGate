# kiwi-srs-feasibility 보고서 — MCP scope

## 1. 메타
- run-id: `2026-07-09.projectmaster.0-5-5-buildergate-stability.v01`
- target: `0.5.5-buildergate-stability`
- scope: `MCP`
- 평가일: 2026-07-09
- 모드: live, Normal
- 정책: 기본 feasibility 매핑

## 2. Feasibility 분포
| 라벨 | 건수 |
| --- | ---: |
| high | 15 |
| medium | 0 |
| low | 0 |
| blocked | 0 |

**Target 종합 판정: conditionally-ready.** MCP scope 15건은 모두 구현 가능하다. 다만 보안 listener, capability/auth boundary, session registry, input gateway, webhook, Tools dialog, audit/status UI가 함께 들어가는 대형 기능군이므로 planner 단계에서 server control-plane, input/lifecycle, REST/UI, verification을 분리해야 한다.

## 3. Stability 변경 결과
변경 없음. MCP scope 15건은 모두 이미 `planned/evolving`이고 verification evidence가 아직 없으므로 기본 정책상 `high + has_verification=false -> evolving`으로 유지된다.

| 결과 | 건수 |
| --- | ---: |
| 적용 | 0 |
| keep / NO-OP | 15 |
| guard 거부 | 0 |
| 사용자 승인 필요 | 0 |
| system failure | 0 |

## 4. 핵심 조건
- `IR-MCP-005`는 최종 wire-contract precedence로 취급한다. replay rejection, close confirmation, webhook secret exposure, bindingLifecycle, agentStatus, audit field의 최종 규칙은 이 항목을 우선한다.
- `SessionInputGateway`는 WebSocket input, restore input, MCP/webhook input을 단일 정책으로 수렴하되 AI TUI idle invariant를 보존해야 한다.
- 외부 whitelist 모드는 TLS 또는 trusted TLS proxy 없이 열면 안 된다.
- browser JWT는 MCP/webhook 인증 credential로 재사용하지 않는다.
- sessionId는 기존 UUID runtime id로 유지하고, restart/orphan recovery에 견디는 stable `sessionKey`와 generation guard를 추가한다.

## 5. Status 충돌 / 외부 모듈
- Status 충돌: 없음.
- cwd 외부 경로 영향: 없음.
- 기존 SpecKiwi 경고: `REL-BGSTAB-005` draft 경고 1건은 MCP scope 밖의 기존 경고다.

## 6. 다음 단계
1. `$kiwi-planner`는 MCP scope 15건 전체를 대상으로 `plan_contract=1.2.0` 계획을 작성한다.
2. 계획은 최소한 security/listener, registry/identity, input gateway, launch/webhook/lifecycle, REST/UI, observability/test phases로 나누는 것이 안전하다.
3. `$kiwi-pm` 구현 시 보안/입력/lifecycle 변경마다 회귀 테스트를 먼저 고정한다.

## 7. 산출물
- target snapshot: `target-snapshot.json`
- per-REQ judgement: `per-req-judgement.json`
- mutation plan: `mutation-plan.json`
- stability mutation result: `stability-mutations.json`

## 8. 평가 루프
- iter1: CRITICAL 0 / HIGH 2. `per-req-judgement.json`의 6축 점수 구조 누락, IR-MCP-003~005 코드 path evidence 부족.
- improvement1: 모든 REQ에 implementability/evidence_strength/dependency_health/ac_verifiability/scope_fit/product_fit 축 점수와 근거를 추가하고, IR-MCP-003~005를 실제 REST/API/input/close/audit 코드 표면에 연결.
- iter2: CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 0. 독립 재평가 통과.
