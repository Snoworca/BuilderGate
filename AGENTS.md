# Agent Notes

## Dev/Test Ports

- HTTP redirect server: `http://localhost:2001`
- BuilderGate HTTPS server: `https://localhost:2002`
- Vite dev server: `http://localhost:2003`

## Validation Rule

- Manual validation and Playwright E2E must target `https://localhost:2002`.
- `http://localhost:2001` is the HTTP redirect port, not the frontend app port.
- `http://localhost:2003` is the Vite dev server port behind the HTTPS reverse proxy.
- Health check example: `curl -k https://localhost:2002/health`

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

# SpecKiwi SRS workflow

This repository stores requirements as Markdown SRS documents under `docs/spec/`. For detailed authoring and validation rules, read [the rules document](docs/rule/SRS-MD-Rules-v1.0.0.md).

Prefer SpecKiwi MCP tools when configured. Use the `speckiwi` CLI fallback when MCP is unavailable. Never bypass SRS-MD rules or create an alternate requirements source of truth.
