# Final Validation Checklist

## Static Validation

- [ ] `git diff --check`
- [ ] frontend/server `ws-protocol.ts` message union 일치
- [ ] printable input 원문이 debug log에 저장되지 않음
- [ ] `manual_input_forwarded` 의존 테스트가 새 event model로 정리됨
- [ ] feature flag/rollback 경로 존재
- [ ] `inputSeqStart`/`inputSeqEnd` 생성자는 `TerminalContainer.InputSequencer` 하나뿐임
- [ ] telemetry detail은 primitive flat field이며 nested input metadata를 쓰지 않음
- [ ] byte budget/byte telemetry는 UTF-8 byte length 기준임

## Server Validation

- [ ] `npm --prefix server run test`
- [ ] replay pending 중 input queue/flush 테스트 통과
- [ ] stale ACK에서 queued input 미flush 테스트 통과
- [ ] replay refresh에서 queued input 보존 테스트 통과
- [ ] timeout/overflow explicit reject 테스트 통과
- [ ] timeout에서 Enter 포함 input 미flush 테스트 통과
- [ ] `input:rejected` message contract 테스트 통과
- [ ] coalesced input sequence range protocol 테스트 통과

## Frontend Validation

- [ ] `npm --prefix frontend run build`
- [ ] helper textarea는 transient replay/restore 중 disabled 되지 않음
- [ ] captureAllowed/transportReady debug state가 기록됨
- [ ] input outbox TTL/overflow/context mismatch 테스트 통과
- [ ] paste 중복 방지 유지
- [ ] closed/error/session-missing/workspace-or-session-changed 상태에서는 queue하지 않고 reject함
- [ ] WS ingress validation이 invalid payload/sequence를 PTY에 쓰지 않고 reject함
- [ ] TerminalView queue와 TerminalContainer outbox entry가 enqueue 당시 `sessionGeneration`을 저장하고 flush 시 검증함
- [ ] frontend deterministic test runner 또는 Playwright debug hook 기반 FIFO/TTL test가 존재함
- [ ] `input:rejected`가 debug capture에 기록됨
- [ ] Space/Enter/Arrow로 composition이 finalize되어 xterm data가 compositionend보다 먼저 emit되는 케이스가 fallback 후보로 오분류되지 않음
- [ ] compositionend timer는 generation guard를 가져 새 composition 상태를 false로 덮어쓰지 않음
- [ ] settle/deferred-repair/fallback observation timer도 `compositionSeq`와 `sessionGeneration` guard를 가짐
- [ ] synthetic IME tests는 helper textarea value 갱신과 xterm delayed read 경로를 검증함

## E2E Validation

- [ ] `terminal-korean-ime.spec.ts`
- [ ] `terminal-keyboard-regression.spec.ts`
- [ ] `terminal-paste.spec.ts`
- [ ] `terminal-authority.spec.ts`
- [ ] `grid-equal-mode.spec.ts`

## Manual Release Gate

- [ ] Windows Korean IME 빠른 입력 10회 반복 누락 0회
- [ ] Space/Enter/Backspace 혼합 누락 0회
- [ ] Arrow 이동 후 한글 입력 깨짐 0회
- [ ] 한글 입력 직후 Space가 직전 문자 앞에 들어가는 현상 0회
- [ ] grid/tab/resize/replay 경계 입력 누락 0회
- [ ] debug capture에서 silent drop event 없음
- [ ] reject event가 있으면 정상 입력 경로가 아닌 timeout/overflow/context mismatch로 설명 가능

## Residual Risk

아래는 이번 계획으로도 완전 제거를 보장하지 못한다.

- 브라우저/Windows IME 자체가 composition event를 생성하지 않는 경우
- ConPTY/PowerShell/PSReadLine 내부에서 입력 echo/redraw가 지연되어 손실처럼 보이는 경우
- 매우 긴 reconnect 상태에서 사용자가 Enter 포함 명령을 계속 입력하는 경우

다만 최종 상태에서는 이들도 silent loss가 아니라 관측 가능한 capture/transport/server/pty/redraw 범주로 분류되어야 한다.
