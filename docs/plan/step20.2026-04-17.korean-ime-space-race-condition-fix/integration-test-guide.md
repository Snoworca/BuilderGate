# Integration Test Guide

## 목표

한글 IME `Space` race fix가 실제 사용자 입력 경로에서 유효한지 확인한다.

## 자동 테스트

1. `frontend/tests/e2e/terminal-korean-ime.spec.ts`
2. `frontend/tests/e2e/terminal-keyboard-regression.spec.ts`

## 수동 테스트 환경

- 브라우저: Chrome 계열
- OS: Windows
- 셸 1: PowerShell
- 셸 2: WSL bash
- 입력기: 한국어 IME
- 대상 URL: `https://localhost:2002`

## 수동 시나리오

### 시나리오 A. 기본 재현 문장

1. PowerShell 열기
2. `안녕하세요 ` 입력
3. `코딩을 합시다` 입력

Expected:

- `안녕하세  요` 형태가 나오지 않는다
- `코딩  을 합시다` 형태가 나오지 않는다

### 시나리오 B. IME + Backspace

1. 한글 조합 중 Backspace 입력
2. 최종 줄 상태 확인

Expected:

- 수동 `\x7f` 경로로 인한 이상한 커서 이동/공백 분리가 없다

### 시나리오 C. WSL bash

1. WSL bash 열기
2. 시나리오 A/B 반복

Expected:

- PowerShell과 같은 증상이 재발하지 않는다

### 시나리오 D. 증폭 요인 확인

1. resize 직후 입력
2. workspace switch 직후 입력
3. reconnect/refresh 직후 입력

Expected:

- 1차 IME fix 이후에도 증상이 없어야 한다
- 만약 이 구간에서만 재발하면 backend/replay/ConPTY 후속 이슈로 분리

## 실패 시 판단 기준

- 평상시에도 재발 → frontend guard fix 미완료
- resize/reconnect 직후에만 재발 → backend/replay hardening 후속 검토

