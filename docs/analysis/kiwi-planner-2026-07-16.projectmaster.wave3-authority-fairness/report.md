# Wave 3 구현 계획 보고서

- Target: `wave-3`
- Run ID: `2026-07-16.projectmaster.wave3-authority`
- Plan: `docs/plans/2026-07-16.projectmaster.wave3-authority.plan.md`
- Sidecar: `docs/plans/2026-07-16.projectmaster.wave3-authority.sidecar.json`
- Validator: `docs/plans/2026-07-16.projectmaster.wave3-authority.validator.json`
- TDD policy: `strict`

## 결과

Wave 3의 활성 Requirement 8개와 Acceptance Criteria 65개를 7개 Phase, 49개 Task로 분해했다. 각 Phase는 RED → GREEN → 통합·리팩터링 → 실제 artifact/E2E/benchmark 실행 → 구현 리뷰 → SpecKiwi/GitHub 동기화 → closure 리뷰 순서이며, 두 리뷰의 `No findings` 판정 전에는 완료할 수 없다.

계획은 observe-only resource policy, 비손실 canary, browser sole writer, server retained authority shadow, single-authority promotion, fair delivery/ACK credit, hidden dataGap/reveal recovery 순으로 의존성을 고정한다. Wave 4 범위인 renderer residency·WebGL·selection·IME는 명시적으로 제외했다.

## 검증

- plan validator: 25/25 PASS, 오류 0, 경고 0
- Requirement coverage: 8/8, AC coverage: 65/65
- SpecKiwi trace: Task↔Requirement 70건
- SpecKiwi plan evidence: Requirement별 8건
- orphan/unreferenced Requirement: 0
- strict TDD exemption: 0
- 독립 계획 리뷰: 1차 HIGH 3/MEDIUM 1, 2차 HIGH 1을 모두 수정한 뒤 최종 `No findings`

## 리뷰 반영

- HTTPS refresh/remount, no-cache recovery, 1/2/8-client flood와 decision artifact validator를 독립 실행 Task로 추가했다.
- sidecar `files[]`, `trace_intent`, test-case kind를 plan-contract 허용 형태로 정규화했다.
- Ordinal64 JSON number/noncanonical/out-of-range, `2^64` rollover, server restart와 PTY exit 판정을 개별 test symbol로 고정했다.
- 모든 다음 Phase의 첫 RED Task가 직전 Phase closure `-07`에 의존하도록 하여 gate 우회를 차단했다.

## 구현 경계

- `C:\\Work\\git-none\\orca`는 읽기 전용이다.
- Orca 상수는 복사하지 않고 BuilderGate policy/benchmark에서 도출한다.
- UI 시각·레이아웃·라벨은 변경하지 않는다.
- legacy recovery는 Wave 3에서 물리 삭제하지 않는다.
- AI TUI 사용자 입력·local echo·prompt redraw는 세션을 `running`으로 바꾸지 않는다.
