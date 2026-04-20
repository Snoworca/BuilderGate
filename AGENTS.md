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

## Encoding Rule

- All file reads must assume `UTF-8` unless the user explicitly says otherwise.
- All file writes, rewrites, and generated files must use `UTF-8`.
- Do not use system-default code pages or locale-dependent encodings for project files.

## Additional Coding Rules

- Reuse first. Before adding a new class, hook, service, utility, parser, or state helper, search the repository for an existing implementation that can be reused or extracted.
- Avoid copy-paste implementations. If duplication is truly unavoidable, document the reason in the task explanation or plan.
- Keep adapters thin. Routes, controllers, contexts, bridge layers, and compatibility layers should delegate to service or domain logic instead of owning complex business rules.
- Preserve existing contracts deliberately. Prefer additive changes over breaking changes for API shapes, session status flows, WebSocket/SSE payloads, and UI-facing behavior unless the change is explicitly intended and documented.
- Do not silently coerce invalid or unsupported behavior into a different path. If fallback behavior is necessary, make it explicit and observable.
- Do not hide meaningful errors. Protocol, state, validation, or lifecycle errors that matter to callers or operators must remain traceable through code paths, logs, debug capture, or tests.
- Prefer safe defaults. Compatibility or legacy exceptions may exist, but insecure or weaker behavior must not become the default path without explicit approval.
- Every bug fix must add regression coverage. Include a reproduction case, a success case after the fix, and an edge or boundary case when relevant.
- Relevant tests must be executed again at task completion, not only during intermediate development.
- For substantial or multi-phase work, consult an existing plan first or create a minimal plan before implementation so the work can be resumed safely.
