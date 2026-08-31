# Agent Notes

## Current Project Goal

- 현재 작업의 전략적 목표는 읽기 전용 참조 저장소 `C:\Work\git-none\orca`의 검증된 구현을 연구하여 BuilderGate의 성능과 터미널 품질을 개선하는 것이다.
- 성능뿐 아니라 터미널 화면 깨짐, 출력·복구 순서, backpressure와 buffer 정책, 렌더링, 텍스트 선택·복사, hidden session 처리, snapshot/replay 및 runtime 수명주기 전반에서 Orca의 더 나은 원칙과 구현을 적극 흡수한다.
- 브라우저 새로고침·재연결·renderer 재생성 뒤에는 서버가 명시적으로 보존하는 terminal retained-state 전체를 복구해야 한다. G1 evidence가 architectural migration을 선택한 경우 현재 viewport-only/local snapshot/replay 복구는 새 server authority가 동등성을 입증한 뒤 제거하며, 선택된 browser retained range와 server authoritative recovery range를 일치시킨다. G1이 confirmed-bug-only를 선택하면 국소 수정 뒤 migration roadmap을 진행하지 않는다.
- BuilderGate의 기존 로직을 반드시 보존할 필요는 없다. Orca 방식이 측정·회귀 테스트·호환성 검증에서 더 낫다면 기존 로직을 걷어내고 대체할 수 있다.
- Orca의 상수나 Electron 전용 전제를 맹목적으로 복사하지 않는다. BuilderGate의 WebSocket/WAN 가능 환경, 다중 client, 기존 protocol과 SRS 계약을 기준으로 이식 가능성을 검증하고 TDD·benchmark·rollback을 갖춘 단계로 적용한다.
- `C:\Work\git-none\orca`는 명시적인 별도 승인 없이는 수정하지 않는 읽기 전용 참고 자료다.

## Work Memory

- Long-lived 작업 기록과 이전 구현/검증 메모는 `docs/memory/*.md`에 남긴다.
- 새 작업을 시작할 때 `docs/memory` 전체를 기본 컨텍스트로 읽지 않는다.
- 현재 요청과 직접 관련된 과거 결정, 구현 세부, 검증 이력, known caveat가 필요할 때만 해당 memory 문서를 골라서 참고한다.
- 새로 남길 작업 기록은 `docs/memory/YYYY-MM-DD-topic.md` 형식의 Markdown 파일을 우선 사용한다.

## Autonomous Boundary Decision Committee

- 사용자가 일반 작업의 자동 진행을 승인한 경우, 기존 안전 규칙·SRS·TDD·Orca 읽기 전용·프로세스 제한은 그대로 유지한 채 진행한다. 다만 아래의 경계 사건은 수정, 채택, 상태 승격 또는 완료 처리 전에 3명의 독립적인 판단·추론·결정 위원회를 자동 소집한다. 일반적인 재승인은 사용자에게 묻지 않는다.
  - user-owned untracked/modified 파일의 import/adoption 요청 또는 계획 파일이 다른 worktree에만 존재하는 경우
  - MCP/CLI의 `success`/`confirmed` 응답과 durable worklog/checklist/metadata read-back이 불일치하는 경우
  - worktree, commit/HEAD, 테스트·evidence, SRS, plan, artifact의 provenance 또는 fingerprint가 불일치하는 경우
  - workflow doctor/session/schema가 완료 또는 차단 상태에 대해 상충하는 판단을 내리는 경우
- 위원회 구성원은 서로의 결론을 전달받기 전에 같은 원시 증거를 독립적으로 검토한다: (1) 감사·도구 무결성 담당은 canonical event, idempotency, MCP read-back과 artifact hash를, (2) 보존·출처 담당은 Git root/common-dir, branch, HEAD, status, source 절대경로와 untracked hash를, (3) SRS·통합 담당은 Requirement/AC, stability, 계획 범위, TDD 및 재현성을 검토한다.
- 채택, 완료, SRS 상태 승격, AC 충족 판정에는 3/3의 명시적 동의와 Critical/High 미해결 항목 0건이 필요하다. 한 명의 보존성·지속성·출처 veto라도 있으면 자동으로 안전 복구 경로를 실행하며, 사용자 승인을 기다리거나 완료를 주장하지 않는다. 런타임 용량 때문에 세 번째 위원회를 즉시 만들 수 없으면 가용 agent를 기다리거나 재배정할 수 있다. 재배정은 결론을 보지 않은 idle agent를 하나의 새 역할에만 배정하는 뜻이며, 한 agent의 복수 역할 겸임이나 다른 위원의 결론을 전달받은 뒤의 위원 역할 수행은 금지한다. 3명 미만으로 채택·완료 결정을 내리지 않는다.
- 판단 전에 MCP workspace/run/task/event/idempotency와 artifact hash, Git root/common-dir/branch/HEAD/status/untracked hash 및 source 절대경로를 기록한다. 이 기록은 `docs/memory/YYYY-MM-DD-<topic>.md`(예: `YYYY-MM-DD-boundary-decision.md`)에 남기며 trigger, 각 역할의 원시 사실, 결정, 복구, read-back 및 차단 사유를 포함한다. 이 section이 요구하는 memory incident는 runtime behavior, requirement, SRS lifecycle을 바꾸지 않는 운영 감사 기록이므로 Requirement ID를 `N/A`로 기록할 수 있으며, 이 좁은 경우에는 Requirement lookup이 필요 없다. 이 문서는 완료 증거나 SRS verification evidence·요구사항 source를 대체하지 않는다.
- durable workflow 기록이 없으면 같은 canonical event를 emit 후 tail read-back하고, 실패 시 같은 idempotency로 한 번만 재시도한다. 그래도 없으면 SpecKiwi MCP `workflow_repair_record`(MCP가 불가할 때만 동등한 공식 CLI)의 dry-run을 먼저 수행하고 3/3 동의 시에만 실제 repair와 read-back을 수행한다. 여전히 지속되지 않으면 지원되는 MCP 상태를 `blocked`로 남긴다. 해당 blocked task의 수정·채택·SRS mutation은 durable write가 복구될 때까지 금지하며, 서로 다른 Requirement ID·task ID·worktree를 가진 작업만 독립 작업으로 계속할 수 있다. worklog, PM, SRS lifecycle, checklist, completed log를 수동 편집하여 결과를 꾸미지 않는다.
- 다른 worktree의 evidence는 관찰 자료일 뿐이며 canonical workspace에서 같은 commit/tree 조건으로 다시 검증해 새 evidence를 남긴다. 여기서 canonical workspace는 canonical Git common-dir와 확인된 HEAD에서 만든 깨끗한 전용 worktree를 뜻하며, 원본 사용자 worktree 또는 그 안의 modified/untracked 경로에는 절대 쓰지 않는다. user-owned untracked 실행 코드·테스트·생성물·secret은 자동 stage/copy/commit/import하지 않고 원본을 보존한다. 필요한 구현은 이 전용 canonical workspace에서 승인된 SRS와 strict TDD로 재구현하며, 과거 TDD나 provenance를 소급 주장하지 않는다.
- 이 절차는 `git reset`/`git clean`, 원본 파일의 이동·삭제·덮어쓰기, Orca 수정, 광범위한 process 종료, 기존 SRS 안정성/검증 gate의 완화를 허용하지 않는다. 기존 Phase Completion Review Rule도 항상 추가로 적용한다.

## Validation Rule

- Manual validation and Playwright E2E must target `https://localhost:2222`.
- `http://localhost:2221` is the HTTP redirect port, not the frontend app port.
- `https://localhost:2222` is the Vite dev server port behind the HTTPS reverse proxy.
- Health check example: `curl -k http://localhost:2221/health`
- Never terminate, kill, restart, or otherwise disrupt a `node.exe` process except for the verified local BuilderGate listener bound to TCP port `2222` under the exception below.
- Never terminate, kill, restart, or otherwise disrupt the BuilderGate processes using TCP ports `2001` or `2002`. Do not bind test services to either port.
- All temporary MCP and integration tests that require a listening port MUST use TCP port `2222` only.
- For local validation on TCP port `2222`, an agent may identify the exact listening PID, verify that its executable and command line belong to this ProjectMaster BuilderGate checkout, and terminate only that PID. Force termination of that single verified port-owner PID is allowed when graceful shutdown is unavailable. Never use image-name-wide or all-Node termination such as `taskkill /IM node.exe`, `Get-Process node | Stop-Process`, or any equivalent broad kill.

start.bat --port 2222 를 이용하여 실행하시오.
종료는 `stop.bat`를 우선 사용하되, 2222 포트의 검증된 BuilderGate listener가 정상 종료되지 않으면 해당 포트 소유 PID 하나만 지정하여 강제 종료할 수 있습니다.
절대 node.exe 를 모두 종료하지 마시오.


https://localhost:2222  를 통하여 플레이라이트로 테스트 가능합니다.
서버는 항상 기동중이며 백엔드/프론트엔드 코드 관계없이 수정하면 리프래시 됩니다.

## Password

- Local test password: `1234`

## Phase Completion Review Rule

- 모든 구현 Phase가 끝나면 반드시 까칠하고 예민한 코드 리뷰어 서브에이전트가 계획 문서를 참고하여 코드 리뷰를 수행해야 한다.
- 코드 리뷰어가 개선사항을 찾으면 반드시 수정하고, 같은 리뷰어 또는 동등한 역할의 리뷰어에게 재평가를 받아야 한다.
- 코드 리뷰어가 `No findings` 또는 동등한 무결점 판정을 내릴 때까지 `구현 -> 테스트 -> 리뷰 -> 수정 -> 재리뷰` 루프를 반복해야 한다.
- 이 규칙은 선택 사항이 아니라 강제 사항이며, 어떤 Phase도 이 절차 없이 완료 처리할 수 없다.

## Encoding Rule

- All file reads must assume `UTF-8` unless the user explicitly says otherwise.
- All file writes, rewrites, and generated files must use `UTF-8`.
- Do not use system-default code pages or locale-dependent encodings for project files.

## Additional Coding Rules

- Reuse first. Before adding a new class, hook, service, utility, parser, or state helper, search the repository for an existing implementation that can be reused or extracted.
- Avoid copy-paste implementations. If duplication is truly unavoidable, document the reason in the task explanation or plan.
- Keep adapters thin. Routes, controllers, contexts, bridge layers, and compatibility layers should delegate to service or domain logic instead of owning complex business rules.
- Preserve existing contracts deliberately. Prefer additive changes over breaking changes for API shapes, session status flows, WebSocket/SSE payloads, and UI-facing behavior unless the change is explicitly intended and documented.
- Session status invariant: when a user types in an interactive AI TUI such as Codex, Claude, or Hermes, that session must remain `idle`. User keyboard input, local echo, prompt redraw, cursor movement, ticker output, and waiting-for-input repaint must not transition the session to `running`. Only semantic command execution or substantive agent output may mark it `running`.
- Do not change existing UI visuals, iconography, labels, layout, or interaction style based only on personal judgment.
- If a UI change seems necessary to implement or test a feature, report the reason to the user first and ask before changing the existing UI.
- Do not silently coerce invalid or unsupported behavior into a different path. If fallback behavior is necessary, make it explicit and observable.
- Do not hide meaningful errors. Protocol, state, validation, or lifecycle errors that matter to callers or operators must remain traceable through code paths, logs, debug capture, or tests.
- Prefer safe defaults. Compatibility or legacy exceptions may exist, but insecure or weaker behavior must not become the default path without explicit approval.
- 모든 버그 수정은 반드시 회귀 테스트를 추가해야 한다. 재현 케이스, 수정 후 성공 케이스, 그리고 경계/엣지 케이스를 포함해야 한다.
- 관련 테스트는 개발 중간에만이 아니라 작업 완료 시점에도 반드시 다시 실행해야 한다.
- For substantial or multi-phase work, consult an existing plan first or create a minimal plan before implementation so the work can be resumed safely.

# SpecKiwi SRS workflow v1.9

This repository uses `docs/spec/` as the required source of truth for requirements.

Before making any code, test, CLI, MCP, or documentation change, agents MUST:
1. Read `docs/spec/00.index.md`.
2. Find the relevant Requirement ID in the scope SRS files.
3. Mention the Requirement ID in the work summary.
4. If no matching requirement exists, stop and ask whether to create/update an SRS requirement first.

Requirement metadata has two separate lifecycle fields:
- `Status` tracks implementation and verification progress.
- `Stability` tracks requirement maturity and change-control maturity.

Agents MUST stop before implementing a non-discarded requirement with `Stability=draft` or `Stability=deprecated` unless the user explicitly overrides that workflow.

TDD principle:
- Agents MUST follow TDD for behavior changes: write or update a failing automated test for the relevant Requirement ID before implementation, make the smallest change to pass, then refactor while keeping tests green.
- If no meaningful automated test can be written, agents MUST stop before implementation and explain the exception and alternative verification evidence.

Work-mode and the TDD First (tdd) workflow:
1. Before starting work, read the persisted work-mode with the MCP `get_work_mode` tool, or CLI `speckiwi mode` when MCP is unavailable (stored in `docs/spec/steps/state.md`). When no mode is set the mode is wait and the sdd (SRS-first) rules in this document apply.
2. Switch modes with the MCP `set_work_mode` tool (mode plus an optional activeTask for vibe/tdd) or CLI `speckiwi mode <value>`. Any mode may switch to any other of sdd, vibe, wait, and tdd; switching to sdd or wait drops a stale Active Task line, and an out-of-enum value is rejected with INVALID_MODE.
3. When the mode is `tdd`, step-scoped work follows the TDD First cycle: author the step SDS at `docs/spec/steps/<task>/design.md` per the installed SDS-MD Authoring Rules (`docs/rule/SDS-MD-Rules-v2.5.0.md`) with EARS acceptance contracts (SDS-AC), translate the SDS-ACs into failing tests and confirm they fail, implement the smallest change to green, run regression, then synthesize the step SRS and promote the step requirement with verification evidence.
4. tdd gates (all mandatory): do not write tests before the step's SDS exists; commit tests first and never weaken a test to reach green; never promote a step requirement without verification evidence.
5. In tdd mode the rule "do not implement behavior not covered by an SRS requirement" is satisfied for step-scoped work by the agreed SDS plus the mandatory post-hoc promotion; body-scope work keeps the sdd rules in this document.
6. Edits to existing body requirements and large architecture changes stay in sdd mode — never route them through a tdd step.

Scope SRS document naming:
1. A scope SRS document is named `docs/spec/{NN}.{scope-slug}.srs.md`, where `{NN}` is a two-digit ordering number. The full rules are in `docs/rule/SRS-MD-Rules-v2.5.0.md` §5.2.
2. Allocate `{NN}` as one above the highest number already present among the project's scope documents. The first scope document of a project is `01`, the next `02`. Do not number by tens.
3. Never reuse a number another scope document holds, and never renumber an existing document.
4. Prefer `speckiwi scaffold-scope <Name>:<PREFIX> --apply`, which allocates the number and registers the document in both index sections in one operation, over writing the file and the index rows by hand.

Agents MUST NOT:
- Implement behavior that is not covered by an SRS requirement.
- Create an alternate requirements source outside `docs/spec/`.
- Change requirement IDs manually.
- Mark requirements as verified without evidence.
- Introduce or invoke bulk-archive / bulk-finalize tooling that flips multiple requirements to `verified` or empties Active Target without per-requirement evidence and stability gate checks.

When SpecKiwi MCP tools are available, agents MUST use them for requirement lookup and safe SRS updates. If MCP is unavailable, use the `speckiwi` CLI.

Current work status workflow:
1. Read the active target with MCP `get_active_target`, or CLI `speckiwi active-target --json` if MCP is unavailable.
2. If `activeTarget` is empty, report that no active target is set and ask which target to use before making target-scoped changes.
3. Read `summary.countsByStatus`, `summary.countsByStability`, `summary.stabilityBlockers`, `summary.stabilityWarnings`, and `summary.newWorkCandidates` before selecting work.
4. Read open work with MCP `list_requirements` for `status=in_progress`, `status=blocked`, and `status=implemented`; CLI fallback is `speckiwi list --status <status> --json`.
5. Check missing verification evidence through `summary` or MCP `summarize_target` before saying work is complete.
6. Read recent completed work with MCP `list_completed_work`; CLI fallback is `speckiwi completed-work --json`.

Next target authoring workflow:
1. If the user asks to set the next target, first read the current Active Target and Target Map.
2. If the target is not registered, use a supported target-registration mutation such as MCP `set_active_target` with creation support, or CLI `speckiwi set-active-target <target> --create` when that option is available.
3. If the configured MCP/CLI cannot register the target, stop before target-scoped SRS changes and report the tool gap, unless the user explicitly authorizes a minimal SRS-MD patch.
4. After target assignment, confirm the resolved Active Target with MCP `get_active_target`, or CLI `speckiwi active-target --json` if MCP is unavailable.
5. When the user provides a target goal, record it with MCP `set_target_goal`, or CLI `speckiwi set-target-goal <target> --goal <text>` if MCP is unavailable.
6. For later SRS creation, omit the target only when the tool supports Active Target defaulting; otherwise pass the confirmed Active Target explicitly.
7. If the user provides an explicit different target for a requirement, the explicit target wins over Active Target.

Merge-time duplicate Requirement ID repair workflow:
1. Run `speckiwi validate --json` or MCP `validate_spec` first. Use repair only when `SRS-E002` duplicate Requirement ID diagnostics exist, or when a named duplicate ID is confirmed in parsed diagnostics.
2. Resolve normal Git conflict markers before repair. Then run MCP `diagnose_requirement_id_collisions` or CLI `speckiwi repair requirement-id-collisions diagnose --json`.
3. Select explicit keep and rename occurrences by `filePath`, `headingLine`, and `blockHash`. A duplicate ID alone is never enough to write.
4. Create a dry-run plan with MCP `plan_requirement_id_collision_repair` or CLI `speckiwi repair requirement-id-collisions plan --duplicate-id <id> --keep <file:line:blockHash> --rename <file:line:blockHash> [--replacement-id <id>|--allocate-next] --write-plan <path> --json`.
5. Apply only from the explicit plan or equivalent explicit mapping with MCP `apply_requirement_id_collision_repair` or CLI `speckiwi repair requirement-id-collisions apply --plan <path> --json`. `--ignore-lock` is allowed only on apply and bypasses only the SRS mutation lock.
6. Do not use collision repair for general renumbering, gap filling, ID beautification, bulk archive, bulk finalize, or Status/Stability changes. When two duplicate logical requirements should be merged or discarded, first repair IDs to uniqueness, then use separate guarded SRS mutations for discard, supersedes, Status, Stability, AC, or evidence changes.
7. When implemented runtime CLI or MCP repair tooling is available, do not hand-edit Requirement IDs. If tooling is unavailable and the user explicitly authorizes a degraded SRS-MD patch, limit it to the selected occurrence and explicitly mapped references.
8. Finish with `speckiwi validate --fail-on-warning --json`, `speckiwi summary --target <target> --json`, and `speckiwi links check --json` or MCP equivalents. Evidence must show duplicate IDs are zero and ambiguous references were reported or explicitly mapped.

The Completed Work Log — inline in `docs/spec/00.index.md` §7 and its split history file `docs/spec/91.completed-work-log.md` — is a read-only summary for agents. Requirement Block status, Acceptance Criteria, Verification Evidence, and Change Notes remain the source of truth for completion.

<!-- /SpecKiwi SRS workflow -->
