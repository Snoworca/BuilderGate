# Wave 3 PH-001 7차 리뷰 수정 구현 보고

## 상태

- Requirement: `OBS-BGSTAB-005`
- 대상 Task: `T-PH001-02`, `T-PH001-03`, `T-PH001-04`
- 상태: 1차 `HIGH 5 + MEDIUM 2`, 2차 `HIGH 4 + MEDIUM 1`, 3차 `HIGH 2`, 4차 `HIGH 3`, 5차 `HIGH 2 + MEDIUM 1`, 6차 `HIGH 1`, 7차 `HIGH 1` 수정 및 자동 검증 완료, 최종 독립 재리뷰 `No findings`
- 활성화: 금지. stable candidate 계약은 현재 `0개`이며 `REL-BGSTAB-010` gate 전에는 legacy 이외 정책을 적용하지 않는다.

동일한 까칠한 리뷰어가 최종 frozen seal과 mutation harness를 재검증해 `No findings`를 반환했다. PH-001의 강제 review gate는 충족됐다.

## 리뷰 지적 수정

### 1. raw/effective provenance

Zod가 기본값을 채운 뒤에는 canonical 설정이 실제 파일에 있었는지 알 수 없으므로, secret-free typed provenance를 `WeakMap<Config, Provenance>` sidecar에 보존한다. 다음 실제 parse 경로가 schema parse 전에 raw presence를 캡처하고 검증된 `Config` 객체에 등록한다.

- `server/src/utils/config.ts#loadConfigFromPath`
- `server/src/utils/configStrictLoader.ts#loadConfigFromPathStrict`
- `server/src/services/ConfigFileRepository.ts#parseConfigForPlatform`

보존 정보는 terminal resource 29개 safe scalar의 canonical presence와 legacy scrollback presence다. 각 값은 `absent | unknown-effective | present-valid(safe scalar) | present-invalid(kind)`로 정규화하며 임의 문자열·객체·비밀·raw config는 sidecar나 telemetry에 저장하지 않는다. 따라서 명시적 WS 값도 `canonical-explicit`, 실제로 없던 값만 `schema-default`, raw 여부를 알 수 없는 직접 Config는 `effective-only-unknown`으로 보고한다. `RuntimeConfigStore`는 `structuredClone` 전에 sidecar를 읽으며, `replaceFromConfig`는 새 Config provenance로 교체하고 `replaceValues`는 29-key `runtime-replacement` provenance를 재생성한다.

이 세 파일은 초기 Task file 목록 밖이지만 실제 startup/settings reload/rollback 경로를 닫기 위해 부모 에이전트가 승인한 plan divergence다.

### 2. 29-key typed policy와 실제 divergence

Telemetry 전용 두 설정을 제외한 terminal resource key 29개를 모두 typed policy로 컴파일한다. unit과 apply boundary를 key metadata에서 결정하며 snapshot의 두 `*Chars` 값은 `chars`다.

관측값은 runtime 적용을 주장하지 않고 `consumer-input-projection`으로 표시한다. 조사에서 확인된 현재 legacy divergence도 숨기지 않는다.

- server headless scrollback: `pty.scrollbackLines`를 `SessionManager.initializeHeadlessState`가 소비
- browser xterm scrollback: `TerminalView` constructor의 `scrollback: 10000`
- canonical `resourceLimits.terminal.scrollbackLines`: 현재 알려진 runtime consumer가 적용하지 않음
- `headless.writeLagWarnMs`, `headless.writeBatchMaxBytes`: `reserved-unapplied`

따라서 과거 보고서의 “모든 consumer가 canonical policy ID를 실제 적용한다”는 주장을 제거했다.

### 3. 후보 profile

근거가 없던 `rel-bgstab-007-legacy-equivalent@1.0.0` stable 등록과 experimental 등록을 모두 제거했다. registry는 빈 배열이며 known-looking, self-declared, experimental profile도 `candidate-policy-not-registered`다. 명시적으로 선택한 후보는 production observation에서 평가되지만 stable 계약이 없으므로 비교/적용되지 않는다.

### 4. exact tuple inventory

매니페스트와 repository inventory는 AC-1의 다음 15개 필드를 양방향 exact 비교한다.

`(consumerId, category, resourceKey, unit, source, schemaVersion, profileVersion, legacyAliases, applyBoundary, consumerPath, consumerSymbol, evidenceSignature, evidenceRole, evidenceAstSha256, state)`

현재 결과는 resource key 29개, exact consumer tuple 80개, consumer 또는 non-consumer로 분류된 path 25개다. 전달 adapter뿐 아니라 `headlessOutputQueue`, `headlessTerminal`, `wsSendPolicy`, `webSocketBackpressure`, `terminalOutputScheduler`, `terminalHiddenOutput`, `visibleOutputRecovery`, `terminalSnapshot`의 실제 enforcement 지점을 keyed chain으로 등록했다. TypeScript AST 기반 repository inventory는 comment/string/template을 제외하고 각 exact signature가 의도한 class/function의 canonical full-owner 안의 실행 코드에 존재해야만 tuple을 생성한다. class method, local function, anonymous callback과 cleanup은 부모 ancestry와 source start identity를 포함하므로 같은 이름의 다른 함수나 자식 callback이 증거를 가로챌 수 없다. `WsRouter` send/drain처럼 과거 OR로 묶였던 소비자는 80개 exact tuple로 분리했다.

dataflow 추적은 direct getter, getter 결과 alias, transitive alias, destructuring, static element access, `config.resourceLimits`와 `config['resourceLimits']` root, parenthesized/type wrapper를 지원한다. parameter/local/destructured/import/catch binding은 null tombstone으로 outer alias를 차단하고, 알 수 없는 재할당과 동적 property는 안전하게 미등록으로 실패한다. 분류 파일 전체를 더 이상 건너뛰지 않는다. 각 분류 파일의 `(resource key, canonical owner, AST expression)` occurrence multiset SHA-256이 현재 검증값과 정확히 같을 때만 기존 projection/schema/persistence 접근을 면제한다. 따라서 pure `ConfigFileRepository`와 hybrid `inputReliabilityMode` 양쪽에 새 접근을 붙이는 mutation이 실패한다. 새 파일과 알려진 경로, shadowing, comment-only, wrong-owner, nested callback, split-owner mutation 및 13개 필드 fault injection을 모두 검증한다.

5차 수정에서 getter 이름 문자열 비교를 제거하고 신뢰된 repository module import binding을 추적한다. renamed import, namespace import, const/assignment alias는 getter identity를 유지하지만 parameter/local shadow tombstone은 이를 차단한다. constant-dead branch, short-circuit dead side, post-terminator, reachable `void`와 discarded expression은 evidence가 아니다.

6차 수정에서 80개 tuple 각각에 `object-option-flow 47`, `reserved-copy 2`, `control-guard 20`, `call-input 6`, `derived-control 5`의 role을 inline으로 고정했다. role은 실제 AST 문맥과 정확히 같아야 하며 derived-control은 lexical binding과 의미 있는 downstream guard/effect를 확인한다. 같은 role 안에서 callee·return·effect를 바꾸는 우회는 TypeScript printer의 comment-free semantic envelope SHA-256으로 검출한다. fingerprint 계약은 `terminal-resource-evidence-ast/v1`, TypeScript `5.9.3`에 고정되어 compiler upgrade도 명시적 재검토를 요구한다.

7차 수정에서 local envelope 바깥 predecessor가 실행을 끊는 경우까지 닫았다. inventory가 consumer/classification/compiler와 두 focused test, validator, differential tool을 포함한 evidence source 34개의 UTF-8 SHA-256과 source-set SHA-256을 계산하고, manifest validator가 이를 실제로 비교한다. `if (true) return` 및 `try { return } finally {}`를 기존 guard 앞에 삽입해도 `source-hash-mismatch`로 실패한다. 이 coarse seal은 intentional source change 때 reviewed manifest rebaseline이 필요하다는 의도된 비용이다.

### 5. 실행 differential과 telemetry

별도 fixture가 observer disabled baseline과 observe-enabled 설정으로 다음 8개 실제 server/frontend helper corpus를 각각 실행한다.

- `headlessOutputQueue`
- `wsSendPolicy`
- `webSocketBackpressure`
- `terminalOutputScheduler`
- `terminalHiddenOutput`
- `visibleOutputRecovery`
- `terminalSnapshot`
- `useTerminalRuntimeResidency`

동일 input corpus의 admission/cap/drop/reconnect/recovery 및 bytes/order/generation 결과 SHA-256은 양쪽 모두 `2fe5453825d00a0a86ba633e0aceef72419170eb855d3a72dee09a0fa05c5287`이며 byte-for-byte 동일하다. RuntimeConfig projection SHA-256도 양쪽 모두 `7d740ada140eac71f51d42de98bc74a71fe38ef6cb3cc464e4587bf4764c342e`다. Artifact validator가 원시 실행 결과로 parity/coverage/legacy-only/payload-free/read-only claim을 계산하며 매니페스트에는 parity boolean을 하드코딩하지 않는다.

Telemetry record와 read를 분리했다. getter는 기록을 추가하지 않으며 consumer/resource/reason/source는 allow-list다. startup, `replaceValues`, `replaceFromConfig`의 각 config generation에서 중앙 orchestration이 등록된 34개 고유 consumer/resource decision을 기록한다. 일반 consumed 값은 compiled policy를 사용하지만 실제 divergence는 실제 consumer 결정을 사용한다. server headless scrollback은 `pty.scrollbackLines`, browser xterm은 hardcoded `10000`과 해당 source를 기록하며, 미적용 `writeBatchMaxBytes`·`writeLagWarnMs`는 `legacyDecision: null`과 `reserved-unapplied`으로 기록한다. disabled observer는 0건이고 observe observer는 bounded/payload-free다.

### 6. runtime/tooling 모듈 분리

AST scanner와 80-entry exact catalog, manifest validator는 tooling-only `TerminalResourcePolicyInventory.ts`로 분리했다. Production이 import하는 `TerminalResourcePolicy.ts`는 약 25.7KB의 compiler/observer 계약만 남기고, startup telemetry에는 34개 unique decision만 담은 5.7KB `TerminalResourcePolicyObservations.ts`를 사용한다. 테스트는 runtime policy와 `RuntimeConfigStore`가 inventory/TypeScript scanner를 import하지 않는지, compact decision 목록이 full catalog에서 도출한 결과와 정확히 같은지 검증한다.

## 검증 결과

| 명령 | 결과 |
| --- | --- |
| `cd server && npx tsx --test src/services/TerminalResourcePolicy.test.ts src/services/RuntimeConfigStore.test.ts` | 24 pass, 0 fail |
| `cd server && npx tsx --test ... TerminalResourcePolicy, RuntimeConfigStore, config.schema, ConfigFileRepository.resourceLimits, SettingsService.resourceLimits` | 38 pass, 0 fail |
| `cd server && npm run build` | exit 0 |
| `cd server && npm test` | exit 0, 기존 runner 517 pass |
| `cd frontend && node --experimental-strip-types --test` 관련 actual helper unit 7개 | 98 pass, 0 fail |
| `cd frontend && npm run typecheck` | exit 0 |
| `node tools/wave3/terminal-resource-consumer-manifest.test.mjs` | exit 0, tuple 80/path 25/key 29, focused 24, 실행 claim 9개 true |
| `git diff --check` | exit 0, 기존 CRLF warning만 존재 |

관련 원시 증거:

- [review-fix-red-evidence.json](./review-fix-red-evidence.json)
- [review-fix-2-red-evidence.json](./review-fix-2-red-evidence.json)
- [review-fix-3-red-evidence.json](./review-fix-3-red-evidence.json)
- [review-fix-4-red-evidence.json](./review-fix-4-red-evidence.json)
- [review-fix-5-red-evidence.json](./review-fix-5-red-evidence.json)
- [review-fix-6-red-evidence.json](./review-fix-6-red-evidence.json)
- [review-fix-7-red-evidence.json](./review-fix-7-red-evidence.json)
- [focused-green-output.txt](./focused-green-output.txt)
- [differential-green-output.json](./differential-green-output.json)
- [green-evidence.json](./green-evidence.json)
- [terminal-resource-consumer-manifest.json](../terminal-resource-consumer-manifest.json)

Manifest SHA-256은 `1d6dcff51115ed5760cf6a9f30a169060d052d46feaf465ec1d205d79f5bd155`다. evidence source 34개의 개별 SHA-256과 source-set SHA-256 `84d05c72ed8ca2ba8045c0a66d4f167f471c51cce473b0c84d8294d54dcdc4b3`을 manifest에 포함하고 validator에서 활성 검증한다. 분류 access hash, evidence role, semantic AST hash와 reason도 manifest 양방향 identity에 포함한다. Artifact guard는 이제 `green-evidence.json`과 이 보고서의 manifest SHA, source count, tuple count, 5~7차 review marker까지 교차 확인하므로 stale 보고가 다시 통과하지 않는다.

## 변경 경계와 rollback

- UI visual, label, layout, interaction 변경 없음
- Settings 저장 shape와 public runtime payload 변경 없음
- product default 숫자 변경 없음
- queue/drop/recovery/terminal authority 동작 변경 없음
- Orca, `docs/spec`, GitHub, Kiwi state/sidecar 변경 없음

Rollback은 loader 세 경로의 provenance 등록, `RuntimeConfigStore`의 observation API, `TerminalResourcePolicy.ts`와 분석 artifact를 함께 제거하는 것이다. 데이터 migration이나 기존 queue/generation 변환은 없다.

## 남은 위험

- AST inventory는 명시적 consumer signature, role, semantic envelope fingerprint, occurrence-aware classification hash, canonical source-set seal과 미등록 callsite scan을 결합한다. 알 수 없는 동적 property access는 안전하게 미등록 callsite로 실패하며, intentional consumer/source 변경은 catalog·fingerprint·source seal과 mutation test를 명시적으로 재검토해야 한다.
- 본 Phase는 divergence를 관측만 하며 canonical scrollback을 실제 runtime authority로 승격하지 않는다.
- 7차 이후 evidence-consistency 수정까지 반영한 최종 독립 재리뷰 결과는 `No findings`다.
