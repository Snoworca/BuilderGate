# Integration Test Guide

## 목적

이 계획의 통합 테스트는 단순히 "입력이 보인다"를 확인하지 않는다. 입력이 각 경계에서 silent drop 없이 통과했는지 확인한다.

## 테스트 준비

1. BuilderGate HTTPS 서버를 `https://localhost:2002`에서 실행한다.
2. local test password는 `1234`.
3. Chrome/Edge에서 한국어 IME를 활성화한다.
4. debug capture를 켤 수 있는 localhost 환경이어야 한다.

## Debug capture 시작

브라우저 console:

```js
await window.__buildergateTerminalDebug.start('<sessionId>')
```

서버 debug:

```http
GET /api/sessions/debug-capture/<sessionId>
```

## 기대 이벤트 흐름

정상 빠른 입력:

```text
compositionstart/update/end or keydown
-> xterm_data_emitted
-> ws_input_sent
-> server input
-> raw_output
```

replay/restore 중 입력:

```text
xterm_data_emitted
-> terminal_input_queued
-> queued_input_flushed
-> ws_input_sent
-> server input
```

server replay pending 중 입력:

```text
ws_input_sent
-> input_queued
-> ack_ok
-> output_flushed
-> input_flushed
-> server input
-> ready_sent
```

coalesced input:

```text
transport_input_coalesced
  inputSeqStart=N
  inputSeqEnd=M
-> ws_input_sent
  inputSeqStart=N
  inputSeqEnd=M
-> server input
  inputSeqStart=N
  inputSeqEnd=M
```

실패지만 관측 가능한 입력:

```text
*_input_rejected
reason = InputRejectedReason from 00-4.protocol-contracts.md
```

정확한 canonical reason 목록과 closed-state mapping은 `00-4.protocol-contracts.md`를 따른다.

앱이 관측한 입력의 silent drop은 실패다. 브라우저/IME/xterm이 event 자체를 만들지 않은 경우는 helper textarea event tape와 residual risk로 분류한다.

## 자동 테스트 묶음

```powershell
git diff --check
npm --prefix server run test
npm --prefix frontend run build
npm --prefix frontend exec playwright test tests/e2e/terminal-korean-ime.spec.ts --project "Desktop Chrome"
npm --prefix frontend exec playwright test tests/e2e/terminal-keyboard-regression.spec.ts --project "Desktop Chrome"
npm --prefix frontend exec playwright test tests/e2e/terminal-paste.spec.ts --project "Desktop Chrome"
```

결정적 queue/sequencer 테스트:
- frontend unit test runner를 추가한 경우 해당 script를 함께 실행한다.
- unit runner가 없으면 Playwright에서 debug hook 또는 test-only barrier toggle로 FIFO, TTL, overflow, Enter timeout safety를 검증한다.

## 수동 테스트 기록 양식

```text
Date:
Build/tag:
Browser:
OS:
Shell:
Backend:
Input reliability mode:

Case 1 안녕하세요 Space:
  runs:
  failures:
  debug anomalies:

Case 2 코딩을 합시다 Enter:
  runs:
  failures:
  debug anomalies:

Case 3 Backspace mixed:
  runs:
  failures:
  debug anomalies:

Case 4 Arrow 이동 후 한글 입력:
  runs:
  failures:
  debug anomalies:

Case 5 Space 위치 회귀:
  runs:
  failures:
  debug anomalies:

Case 6 Space/Enter/Arrow keydown commit 선행:
  runs:
  failures:
  debug anomalies:

Case 7 grid/tab switch while composing:
  runs:
  failures:
  debug anomalies:

Verdict:
```
