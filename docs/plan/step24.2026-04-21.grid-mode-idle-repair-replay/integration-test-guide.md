# Integration Test Guide

## Target

- `https://localhost:2002`

## Manual Scenarios

### Scenario A: Codex grid corruption auto-repair

1. grid mode에서 Codex TUI 세션 2개 이상 배치
2. 줄바꿈이 깨질 가능성이 있는 긴 출력 또는 status line이 있는 상태를 만든다
3. 깨짐이 보일 때 사용자가 셀 크기를 조절하지 않고 idle 상태로 둔다
4. quiet window 이후 자동 repair replay가 1회 발생하는지 본다
5. 화면이 수동 리사이즈 없이 정상화되는지 확인

### Scenario B: Hermes grid corruption auto-repair

1. grid mode에서 Hermes TUI 세션 실행
2. status line / wrapped line / long output로 깨짐 재현
3. idle 진입 후 자동 복구 확인

### Scenario C: tab mode no-op

1. 같은 세션을 tab mode에서 사용
2. idle 진입 시 repair replay 요청이 발생하지 않는지 확인

## Pass Criteria

- grid mode에서만 repair replay가 동작
- idle quiet window 이후 한 번만 동작
- 복구 후 output 중복이나 입력 차단 고정이 없다
