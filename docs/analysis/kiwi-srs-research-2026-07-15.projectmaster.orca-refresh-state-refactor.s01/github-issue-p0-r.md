## 목적

브라우저 새로고침 후 terminal 화면·scrollback이 잘리는 경계를 deterministic하게 재현하고, BuilderGate가 보존해야 할 `full retained-state` 계약과 server/browser history 범위를 구현 전에 고정한다.

현재 server snapshot과 browser local snapshot은 모두 viewport-only이며 `TC-7004`는 700줄 중 첫 marker가 reload 뒤 없는 것을 성공으로 assert한다. Server headless 기본 1,000줄, browser live xterm literal 10,000줄, 2MiB oversized empty fallback과 256KiB replay tail이 서로 다른 절단 경계를 만든다.

## 선행 의존성

- #3의 SRS/benchmark foundation
- Stable `FR-BGSTAB-004/014`의 확장·supersede/change-control에 대한 사용자 승인

## 관련 SRS

`FR-BGSTAB-004`, `FR-BGSTAB-014`, `FR-BGSTAB-017`, `FR-BGSTAB-018`, `REL-BGSTAB-003`, `REL-BGSTAB-004` 및 신규 refresh retained-state/model-view authority 계약.

## 범위

- `TC-7004`를 current viewport-only characterization으로 유지한다.
- Pre-refresh server model, wire checkpoint/delta, browser applied state와 final xterm buffer를 같은 session/epoch/sourceSeq로 기록한다.
- 24/999/1,000/1,001/9,999/10,000/10,001 logical lines, 2MiB 직전/직후, ASCII/CJK/emoji, ANSI split, normal/alternate, active/hidden을 재현한다.
- Local cache valid/absent/poisoned/oversized와 remount, replay-tail, visible/hidden overflow를 분리한다.
- `full retained-state`를 configured retention 안의 normal scrollback·active/alternate screen·cursor/mode/geometry·parser tail·snapshot sequence로 정의한다.
- Retention, aggregate model memory, checkpoint chunk/in-flight budget과 browser write budget을 서로 다른 정책으로 정의한다.
- Browser-visible history가 server authoritative retained history를 넘지 않는 불변식을 고정한다.

## Acceptance criteria

- [ ] 사용자가 보고한 refresh 절단을 최소 한 경로에서 deterministic하게 재현하고 발화 boundary를 machine-readable evidence로 남긴다.
- [ ] G1 evidence로 `confirmed-bug-only` 또는 `architectural migration` 구현 분기를 명시적으로 선택하고 근거를 기록한다. Migration 이득이 입증되지 않으면 shadow/promotion 작업을 자동 시작하지 않는다.
- [ ] `confirmed-bug-only` 선택 시 국소 fix와 회귀 evidence를 terminal condition으로 기록하고 #10~#22 migration/deletion chain은 inactive/deferred로 남긴다. 이를 완료된 migration으로 표시하지 않는다.
- [ ] Retention 밖 expected eviction과 retention 안 loss를 test가 구분한다.
- [ ] `TC-7004`의 current behavior와 목표 pre/post retained logical-line/cell hash test가 별도 test로 존재한다.
- [ ] 2MiB 초과가 empty success가 되지 않아야 한다는 additive checkpoint/resync contract가 SRS에 있다.
- [ ] Browser retained range와 server authoritative range가 같은 effective policy에서 파생된다. 현재 literal 10,000은 characterization/test corpus이며 실제 제품 retained-history 값은 별도 승인된 stable SRS AC로 결정한다.
- [ ] Snapshot/delta listener-first, epoch/sourceSeq, covered range, digest/apply ACK와 ready/input drain barrier가 SRS에 정의된다.
- [ ] SpecKiwi가 신규·superseding refresh authority Requirement ID를 할당하고 사용자 승인 AC와 `Stability=stable`을 기록한다. #5/#6/#10/#11/#12/#14/#16/#21/#22 body가 이 exact ID를 참조한 뒤에만 #23을 닫는다.
- [ ] Local cache는 provisional/non-authoritative이며 cache absent/poisoned correctness gate와 삭제 조건이 정의된다.
- [ ] Server restart/offline 보존 범위와 live-server browser refresh 범위를 분리한다.
- [ ] Baseline raw sample은 retained rows/bytes, checkpoint chunks, serialize/apply latency, browser long task, mismatch reason과 queue maxima를 포함한다.
- [ ] 구현 PR 분해와 rollback gate가 #10/#11/#12/#14/#22에 연결된다.

## 비목표

- 이 이슈에서 big-bang authority 전환 또는 legacy 삭제를 하지 않는다.
- Orca의 local 5,000줄 또는 remote `scrollbackRows=0` 상수를 복사하지 않는다.
- UI 시각·label·layout을 사용자 승인 없이 바꾸지 않는다.

## 공통 완료 조건

- Parent: #2
- Source research: `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md`
- Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
- SRS change-control와 신규·superseding refresh authority Requirement의 `Stability=stable` 확인 전에는 test/fixture/runtime 구현을 시작하지 않는다.
- 동작 변경은 failing regression test부터 TDD로 진행한다.
- 관련 test/typecheck/build와 적용 가능한 `https://localhost:2222` 검증을 수행한다. `node.exe`와 TCP 2001/2002 process를 중단하지 않는다.
- Phase reviewer finding을 모두 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.
