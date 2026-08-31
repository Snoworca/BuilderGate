# SDS: Wave 3 Windows daemon identity-probe uncertainty

| Field | Value |
| --- | --- |
| Document Type | sds |
| Task | wave3-daemon-identity-probe |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-21 |

## 1. Context & Scope

The Wave 3 authority-promotion evidence fails before contracts run when the Windows daemon sentinel treats a live BuilderGate PID as exited after a PowerShell CIM identity probe is inconclusive. This step changes only the live-process classification in the daemon process-information utility and adds deterministic daemon regression tests. It does not change the application protocol, ports, renderer, or terminal authority implementation.

## 2. Goals / Non-goals

- Goal: Preserve the running app PID, start attempt, generation, and restart count when liveness succeeds but Windows identity metadata is unavailable.
- Goal: Keep the existing bounded restart path when liveness fails.
- Goal: Preserve strict ownership proof for readiness and fatal-port-owner validation.
- Non-goal: Relax normal-stop ownership behavior or add a process-name-wide termination path.
- Non-goal: Change TCP ports 2001 or 2002, terminal data delivery, or the Wave 3 authority contract.

## 3. Architecture Decisions

- **Decision**: Treat every post-liveness Windows CIM failure as live-with-unknown-identity. / basis: the preceding explicit PID liveness check is the exit signal; CIM is metadata only. / trade-off: an unknown identity cannot prove ownership to strict consumers. / rejected: treat a failed CIM result as a process exit.
- **Decision**: Leave sentinel policy and stop-client ownership policy unchanged. / basis: sentinel already permits unknown identity for liveness while ownership-sensitive paths must remain strict. / trade-off: the fix stays localized to process-info classification. / rejected: grant unknown identity as ownership proof.

## 4. Interfaces

- `queryWindowsProcessInfo(pid: number, options?: ProcessInfoOptions): ProcessInfo` — after successful liveness, returns either verified metadata or a `running: true` unknown-identity record.
- `runSentinelTick(options): Promise<'continue' | 'restart' | 'exit' | 'fatal'>` — preserves its current restart and epoch transitions; tests exercise its process-info-provider path.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN liveness succeeds and the Windows identity probe times out, is nonzero, is empty, or is malformed THE SYSTEM SHALL return live unknown identity and the sentinel SHALL preserve the current app epoch.
- SDS-AC-2: WHEN liveness fails through the process-info provider THE SYSTEM SHALL take the existing bounded restart path and record the replacement epoch transition.
- SDS-AC-3: WHEN sentinel continuation observes unknown identity THE SYSTEM SHALL NOT relax readiness, fatal-port-owner, or normal-stop ownership behavior and SHALL NOT use process-name-wide termination.
- SDS-AC-4: WHEN focused daemon regression suites complete THE SYSTEM SHALL prove the four probe cases, live-unknown preservation, true-exit restart, and ownership-path regression before authority-promotion evidence is retried.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
| --- | --- | --- |
| SDS-AC-1 | tools/daemon/process-info.test.js; tools/daemon/sentinel.test.js | timeout, nonzero, empty, malformed CIM output each return live/unknown; no spawn plus appPid/startAttemptId/stateGeneration/restartCount remain unchanged. |
| SDS-AC-2 | tools/daemon/sentinel.test.js | process-info-provider `running: false` restarts and advances the expected state fields. |
| SDS-AC-3 | tools/daemon/stop-client.test.js | fatal-owner identity mismatch remains fail-closed, normal-stop unknown-identity policy remains unchanged, and no broad termination is introduced. |
| SDS-AC-4 | tools/daemon/process-info.test.js; tools/daemon/sentinel.test.js; tools/daemon/stop-client.test.js | focused suite passes, followed by Wave 3 authority-promotion evidence. |

## 7. Open Questions

- (none; user authorized automatic decisions for this scoped fix.)
