# Final Validation

- [ ] `IMPL-001` full-cell guide 구현
- [ ] `IMPL-002` move/insert reorder semantics 구현
- [ ] `IMPL-003` `1 -> 5 => [2,3,4,5,1]` 만족
- [ ] `IMPL-004` swap이 아닌 move semantics 유지
- [ ] `IMPL-005` Option A vendor patch 경로 구현
- [ ] `IMPL-006` runtime patch completeness 보장
- [ ] `IMPL-007` equal canonical grid 유지
- [ ] `IMPL-008` none/focus/auto non-entry 유지
- [ ] `IMPL-009` handle-only drag start 유지
- [ ] `IMPL-010` right-click context menu 유지
- [ ] `IMPL-011` equal persistence/reload 일치
- [ ] `IMPL-012` 회귀 테스트 확장
- [ ] `IMPL-013` intermediate target shift 규칙 일관성
- [ ] `IMPL-014` clean install patch reproducibility
- [ ] `IMPL-015` root drop path disable/no-op 정책 유지
- [ ] `IMPL-016` touch out-of-scope 유지
- [ ] `IMPL-017` self-drop no-op
- [ ] `IMPL-018` outside-target drop no-op

## Automated Results

- `frontend`: `npm run build`
- `frontend`: Playwright reorder regression suite

## Remaining Validation

- 없음. 수동 검증 항목이 남는다면 verification 문서의 evidence로 관리한다.
