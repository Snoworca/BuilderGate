# Agent Notes

## Work Memory

- Long-lived 작업 기록과 이전 구현/검증 메모는 `docs/memory/*.md`에 남긴다.
- 새 작업을 시작할 때 `docs/memory` 전체를 기본 컨텍스트로 읽지 않는다.
- 현재 요청과 직접 관련된 과거 결정, 구현 세부, 검증 이력, known caveat가 필요할 때만 해당 memory 문서를 골라서 참고한다.
- 새로 남길 작업 기록은 `docs/memory/YYYY-MM-DD-topic.md` 형식의 Markdown 파일을 우선 사용한다.


## Validation Rule

- Manual validation and Playwright E2E must target `https://localhost:2222`.
- `http://localhost:2221` is the HTTP redirect port, not the frontend app port.
- `https://localhost:2222` is the Vite dev server port behind the HTTPS reverse proxy.
- Health check example: `curl -k http://localhost:2221/health`
- Never terminate, kill, restart, or otherwise disrupt any `node.exe` process.
- Never terminate, kill, restart, or otherwise disrupt the BuilderGate processes using TCP ports `2001` or `2002`. Do not bind test services to either port.
- All temporary MCP and integration tests that require a listening port MUST use TCP port `2222` only.

start.bat --port 2222 를 이용하여 실행하시오. 
종료는 stop.bat 를 사용하시오. 
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

# SpecKiwi SRS 워크플로 v1.4

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

Completed Work Log is a read-only summary for agents. Requirement Block status, Acceptance Criteria, Verification Evidence, and Change Notes remain the source of truth for completion.

<!-- /SpecKiwi SRS 워크플로 -->
