# MCP Session Orchestration SRS 완료 보고

작성일: 2026-07-09

## 결론

`docs/research/mcp/00.index.md`와 하위 연구 문서를 기반으로 신규 SRS scope `MCP Session Orchestration`을 작성했고, SpecKiwi target `0.5.5-buildergate-stability`에 MCP 요구사항 15건을 등록했다.

최종 상태는 완료다. 이전에는 IMP4 이후 서브에이전트 인증 갱신 오류로 차단되었으나, 재개 후 IMP4/IMP5/IMP6 보강과 5분야 최종 검증을 모두 통과했다.

## 신규 SRS 산출물

- `docs/spec/40.mcp-session-orchestration.srs.md`
- `docs/spec/00.index.md`

## 신규 요구사항

- `SEC-MCP-001` — MCP listener transport security and runtime rebind
- `IR-MCP-001` — BuilderGate MCP tool surface contract
- `FR-MCP-001` — Stable session identity, alias listing, search, and alias updates
- `FR-MCP-002` — Shared input gateway for MCP messages and leader replies
- `FR-MCP-003` — Agent command profiles and MCP-launched follower sessions
- `REL-MCP-001` — MCP launch compensation and session close lifecycle safety
- `FR-MCP-004` — Webhook assignment invocation with random query key
- `FR-MCP-005` — Tools dialog management UI for MCP sessions and security
- `OBS-MCP-001` — MCP audit, status observability, and verification coverage
- `SEC-MCP-002` — Scoped capability, auth boundary, and webhook key security contract
- `FR-MCP-006` — MCP registry startup reconciliation and legacy tab backfill
- `IR-MCP-002` — MCP control REST API and management dialog contract
- `IR-MCP-003` — MCP management action endpoints, webhook credential variants, and agent status enum contract
- `IR-MCP-004` — MCP webhook and live-session edge-case contract tightening
- `IR-MCP-005` — MCP final security and wire-contract precedence rules

## 연구/개선 기록

- `docs/research/2026-07-09.mcp-srs-validation-improvements.md`
- `docs/research/2026-07-09.mcp-srs-second-validation-improvements.md`
- `docs/research/2026-07-09.mcp-srs-final-validation-improvements.md`
- `docs/research/2026-07-09.mcp-srs-exit-validation-improvements.md`
- `docs/research/2026-07-09.mcp-srs-post-exit-validation-improvements.md`
- `docs/research/2026-07-09.mcp-srs-convergence-validation-improvements.md`

## 주요 확정 사항

- MCP HTTP는 기본 `127.0.0.1` 전용이며, 외부 접근은 Tools dialog의 security tab에서 whitelist와 TLS/proxy 조건을 명시적으로 충족할 때만 허용한다.
- runtime `sessionId`는 UUID이며 restart/orphan recovery로 바뀔 수 있으므로 stable 주소로 `sessionKey`와 `generation`을 병행한다.
- 세션 alias는 하단 상태 표시줄/탭 rename이 쓰는 `WorkspaceTab.name`과 `nameSource='user'`를 primary source로 삼는다.
- 세션 검색은 코딩 에이전트가 자연어를 해석한 뒤 `buildergate.session.search`와 `buildergate.message.send`를 호출하는 모델이다.
- 직접 MCP server-to-server 또는 tool-to-tool 메시징은 이번 범위의 비요구사항으로 명시했다.
- webhook query/header key, promptPreview, recentAuditEvents, one-time fullKey/fullUrl, `agentStatus`, `bindingLifecycle` wire contract를 최종 precedence requirement로 정리했다.

## 검증 결과

- `speckiwi validate --json`: errors 0, warnings 1
- 남은 warning: 기존 `REL-BGSTAB-005` draft warning, MCP SRS 범위 외
- `mcp__speckiwi.validate_spec`: PASS
- `mcp__speckiwi.summarize_target`: target 총 45건, MCP 신규 work candidates 15건 포함
- `git diff --check`: 대상 SRS/연구/report/pipeline 범위 통과, LF→CRLF 경고만 존재
- IMP4/IMP5 targeted 재검증: No findings
- IMP6 targeted 재검증: No findings
- 최종 5분야 서브에이전트 검증: 추적성, 보안/운영, 세션/입력, 프론트/REST, SRS 품질 모두 No findings

## 잔여 리스크

- 이번 작업은 SRS/연구 문서화 완료이며 구현은 아직 수행하지 않았다.
- target 전체에는 기존 `REL-BGSTAB-005` draft warning이 남아 있지만 이번 MCP scope와 직접 관련이 없다.

## 다음 단계

`SEC-MCP-001`부터 `IR-MCP-005`까지 15건이 `planned/evolving` 상태이므로 후속은 `kiwi-srs-feasibility`로 target/scope feasibility를 평가한 뒤 구현 계획으로 넘어가는 것이 적절하다.
