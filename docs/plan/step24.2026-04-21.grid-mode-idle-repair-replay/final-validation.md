# Final Validation

- [x] `IMPL-001` Grid mode idle repair replay 동작 경로 구현
- [x] `IMPL-002` geometry mutation 없이 snapshot 기반 복구 구현
- [x] `IMPL-003` quiet window 기반 one-shot trigger 구현
- [x] `IMPL-004` tab mode 및 일반 shell 경로 기본 비적용
- [x] `IMPL-005` ACK/queued output/session:ready 경계 테스트 통과
- [ ] `IMPL-006` codex/hermes 실사용 검증 완료

## Automated Results

- `server`: `npm run test` → `131 test(s) passed`
- `frontend`: `npm run build` 성공

## Remaining Validation

- 실제 grid mode `codex`/`hermes` 세션에서 idle repair replay가 수동 드래그 없이 화면을 정상화하는지 확인 필요
