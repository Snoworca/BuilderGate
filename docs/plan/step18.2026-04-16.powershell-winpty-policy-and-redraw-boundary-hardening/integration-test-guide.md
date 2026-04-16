---
name: Step18 Integration Test Guide
description: Step18 설계를 검증하기 위한 자동/수동 테스트 시나리오를 정리한다.
---

# Integration Test Guide

## Automated

### Server

- `npm test`
- backend resolution unit tests
- windowsPty metadata propagation tests
- snapshot ACK timing tests

### Frontend

- `npm run build`
- Playwright PowerShell regression

## Manual

### Scenario A: Plain PowerShell Rapid Enter

1. PowerShell 세션 생성
2. `A` 입력
3. 즉시 `Enter`
4. 매우 빠르게 반복
5. 출력이 줄 단위로 정상 적층되는지 확인

### Scenario B: PSReadLine Compatibility

1. 긴 줄 입력
2. backspace 연속 입력
3. paste
4. history recall
5. tab completion menu
6. multiline / wrapped line 편집

### Scenario C: Open / Refresh / Reconnect Immediate Input

1. 새 PowerShell 세션 생성 직후 바로 입력
2. 새로고침 직후 바로 입력
3. reconnect / workspace restore 직후 바로 입력
4. interactive-ready barrier가 유지되는지 확인

### Scenario D: Codex From PowerShell

1. PowerShell 세션 생성
2. `codex` 실행
3. 동일 입력/반응성 확인

### Scenario E: Other Child TUI From PowerShell

1. PowerShell에서 VT-heavy child app 1종 실행
2. 입력 / resize / repaint 확인

### Scenario F: Non-PowerShell Safety

1. bash / wsl / cmd 세션 생성
2. 기본 입력/출력과 resize 확인

### Scenario G: Runtime Regression

1. `tab -> grid`
2. `grid -> tab`
3. workspace switch
4. refresh / reconnect

### Scenario H: Mixed Backend Cohort

1. legacy ConPTY PowerShell 세션 유지
2. 신규 winpty PowerShell 세션 생성
3. 같은 workspace 안에서 공존 확인
4. reconnect / restore / close / restart 정책 확인

### Scenario I: winpty Capability Failure

1. probe 실패 또는 차단 환경 가정
2. fail-fast 오류 메시지 확인
3. telemetry / operator guidance 확인

## Evidence

- browser terminal debug events
- server debug capture
- `windowsPty.backend` 확인
- 필요 시 screenshot
