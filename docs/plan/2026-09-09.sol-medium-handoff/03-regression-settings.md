# B/C regression and settings — execution tasks

공통 선행: [master](../2026-09-08.remaining-work-autonomous.plan.md), [원본 §4/5/9/10](../../next/2026-09-07-remaining-work-execution-plan.md), [test inventory](../../report/2026-09-08.remaining-test-inventory.md). 모든 명령은 현재 수집 수와 필터를 확인한 뒤 실행한다. 원본에 있는 port0/임의 port·tree kill 명령을 그대로 실행하지 않는다.

## RG-01 — effective runtime preflight와 전체 서버 inventory

- REQ: REL-BGSTAB-001 AC1–4, REL006 AC1–4; 설정 공개는 FR008 AC5/IR001 AC8. 작업: `server/src/test-runner.ts` 등록표/filter, 각 `server/src/{services,ws,utils}/*.test.ts`, boot test의 실제 listener/process 경로를 표로 만든다.
- 이미 B0 pipe helper7/7·27 HTTP cases, B1 peer-IP3/TLS1+boot6는 bounded 완료다. [safe transports](../2026-09-08.safe-test-transports.design.md), [exclusive runtime](../2026-09-08.exclusive-runtime-validation.design.md), [boot](../../report/2026-09-08.binary-negotiation-boot-validation.md)를 재사용한다.
- 산출물: 정확한 command/cwd/env/filter→tests/ports/child/cleanup 소유권 표 및 실제 resolved config/capability 스냅샷. schema default만으로 rollout 상태를 판정하지 않는다. MCP disabled envelope/load/merge를 재검증한다.
- 실행: canonical exact committed tree, 독립 deps/lock/patch read-back, owned config 초기 raw snapshot, `start.bat --port 2222`. `stop.bat`의 안전 branch 검토 후 verified2222 listener PID 한 개만 예외적 종료. 2001/2002·다른 Node·wrapper signal/취소 금지. Native Worker IPC guard도 현재 검토본을 사용한다.
- gate: 포트/프로세스/입력 전후 증거와 안전성 독립 No findings. `terminalWireFormatBoot.test.ts` standalone 임의 port/tree kill runner는 계속 금지. 필요 fixture 수정은 RED부터.

## RG-02 — split disposition 결정 (구현 전)

- REQ FR006 AC2–5, FR007 AC1–7, REL006 AC3/5, REL008 AC10/11. [split accounting](../2026-09-08.split-test-accounting.md)의 28 collected/15 ordinary PASS/13 failing TODO는 full split 성공이 아니다.
- 원본 TODO 의미: subscribe 분리(:151), duplicate output(:228/268), pairing token/identity/expiry(:346), output(:395), replay/ACK(:474/522), repair/ACK(:603/660), overflow/hard limit(:740/795), close reroute(:842), snapshot 이후 tail(:894). 현재 위치는 rg로 재확인.
- 결정 산출물: 각 TODO 이름→SRS expected→실제 production unified 관찰→standalone 관찰→restore 또는 supersede 후보와 근거. REL006은 아직 disposition unresolved를 요구하므로 구현 전에 공식 요구 변경 필요성을 검토한다. TODO 삭제·단언 완화·13개 suppression 그대로 완료 금지.
- RG-03 실행은 승인된 disposition 뒤에만: actual HTTPS upgrade/browser URL과 `WsRouter.setupConnectionHandler`, pairing/group maps, `recoverSplitOutputFailureOnControl`, queue/replay/repair 처리까지 RED→구현. 기존 production unified 제한을 무단 활성화하지 않는다. 최종 원본 B gate는 TODO0·전건 GREEN; 달성 불가이면 미완료와 근거 보고.

## RG-04 — B2 타입/ownership 잔여 정리

- REQ REL001 AC1; 기존 owned cleanup core/fixture와 [ownership plan](../2026-09-08.e2e-workspace-ownership.design.md) 재사용. 13 live specs migration·실제 UI/API control 준비·113 isolated controls는 완료된 준비 증거다.
- 파일: `frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts`의 `REPLY_DA1_CONPTY`, `waitForSnapshot` 두 기존 미사용 선언; `tsconfig.e2e-ownership.json`. 삭제 질문은 과거 pending 기록이다. 최신 사용자 답변/명시 허가를 확인하며 같은 승인 질문 반복 금지. 허가 없이 가짜 사용 추가/ts-ignore/noUnused 완화 금지. 삭제가 승인되면 두 선언만 제거하고 정확한 project typecheck/독립 diff 검토.
- 실제 control: `workspace-ownership-validation.spec.ts`, `playwright.ownership-validation.config.ts`, `workspaceOwnershipFixture.ts`, `workspaceLeakGuard.ts`. 외부2222만, webServer 자동 start/stop 없음, 성공 POST ID만 소유권, sibling/user workspace 무삭제, quota 실패 시 eviction 없음. 실제 control은 새 canonical runtime에서 검증해야 하며 unit을 browser 증거로 재표기하지 않는다.

## RG-05 — busy bounce 실제 재현과10회

- RG-01/04와 hidden 관련 동작 준비 후 `busy-agent-workspace-bounce.spec.ts`를 원본 §9.11의 동일 의미로 실행한다. 현재 config는 외부2222/owned fixture를 사용하도록 명령 preflight를 마친다.
- 첫 실제 실패 raw/상태/trace→관련 상태 전이와 observable condition 조사→RED→최소 수정. prefix cleanup·동시 사용자 workspace 삭제·고정 sleep으로 통과 금지. 최종 동일 spec10회 모두 통과, 실패라면 isolated/concurrent 차이를 조사한다.

## RG-06/07 — full server / full frontend regression

- RG-06: RG-01 안전성 확보 뒤 원본 §9.1 전체 monolithic 및 §9.4 broad node:test를 실제 nonempty collection으로 실행. listeners 없이 실행 가능한 파일과 실제2222 exclusive fixture를 명시 분리하되 전체 coverage를 빠뜨리지 않는다. 파일 glob이0개이면 실패. 1회 green으로 flake 분류 금지; 실패 이름/isolated/concurrent/부하 의존 근거를 남긴다.
- RG-07: hidden 01 통합 뒤 원본 §9.7 전체 frontend unit을 명시 파일 expansion으로 실행. 기존965/964pass1 REL012 실패 baseline은 과거 증거이며 현재 숫자는 재수집한다. 실제 app/node/test configs를 명시한 타입 검사; `files:[]` root tsc는 앱 검증 아님. 같은 source에서 중복 전면 검사는 피한다.
- 완료: 모든 새 실패 수정 또는 원본 B3가 허용하는 근거 있는 flaky 분류를 보고하되, A/C가 요구하는 GREEN을 flake 분류만으로 면제하지 않는다. 독립 No findings와 정확한 최종 raw/HEAD/hash.

## RG-08 — C 최종 closure (새 기능 없음)

- C1 FR025 AC1–5: retired13 schema/types/template/editable/persistence surfaces, known telemetry migration만 허용, raw input 무변경/로드 시 미저장, server.port/SSL/JWT secret/maxFileSize 보존. C2 FR026 AC1/2 timing; C3 AC3–7 authenticated limits2→hook/App/Sidebar/TabBar/Item/MoveDialog, 초기10/8·low/high/fractional·malformed warn/reject. C4 FR015 AC1/2/3/6의 recentEventLimit subset만 immediate/available. C5 historical backlog notice 완료.
- [C final159 보고서](../../report/2026-09-09.C-final-regression.md): schema/store42, template/persistence9, WorkspaceService42, capacity7, frontend35, RuntimeConfigStore4, SettingsService17, FileService1, AuthService2. server tsc 및 별도 explicit frontend type 증거를 재사용할 때 정확 source 동일성 확인. 다른 HEAD의 증거를 하나의 동일-tree run으로 쓰지 않는다.
- 남은 필수: **원본 §10 C가 요구하는 §9.1 full monolithic + §9.6 schema + C3이면 §9.7 full frontend GREEN**. 159는 이 gate 대체물이 아니다. C3 동작은 E2E 또는 unit 허용이지만 전체 프로젝트 E2E 의무는 남는다. C4 subset으로 FR015 전체 matrix 완료 금지.
- 완료 산출물: 원본 C When/Then별 증거표, 전체 gate 결과, reviewer No findings, scoped report/commit/공식 evidence read-back. P7 checkbox는 이때만 완료.
