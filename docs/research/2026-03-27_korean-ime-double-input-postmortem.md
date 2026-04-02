# 한글 이중 입력 포스트모템

> **최초 증상**: 한글 "안녕하세요" 입력 시 "안녕녕하하세세요.요." 표시
> **오진**: IME composition 이중 전송
> **진짜 원인**: React StrictMode WebSocket 이중 연결 -> PTY 출력 2번 전달
> **상태**: 수정 완료

---

## 오진의 경과

| 시도 | 접근 | 결과 |
|------|------|------|
| 1차 | `attachCustomKeyEventHandler`에 `isComposing` 가드 | 효과 없음 |
| 2차 | `compositionstart/end` 추적 + `onData` 차단 | 한글 입력 자체가 안 됨 |
| 3차 | TF팀 결성 -> `windowsPty: { backend: 'conpty' }` | 한글 개선 but Backspace 깨짐 |
| 4차 | capture-phase composition 이벤트 | 한글 입력 더 깨짐 |

**모든 시도가 잘못된 원인을 타겟**하고 있었음.

---

## 전환점: 진단 로그

### 1단계: onData 횟수 확인

```javascript
term.onData((data) => {
  console.log(`[IME-DIAG] onData text="${data}"`);
  console.trace('[IME-DIAG] callstack');
});
```

**결과**: `onData`는 **정확히 1번**만 호출됨
-> xterm.js IME 처리는 정상. 문제는 입력이 아닌 **출력** 측

### 2단계: PTY 출력(write) 횟수 확인

```javascript
write: (data) => {
  if (한글 포함) console.log(`[PTY-OUT] text="${data}"`);
  xtermRef.current?.write(data);
}
```

**결과**: `[PTY-OUT]`이 **2번** 출력 -- 동일 데이터가 2번 write됨

### 3단계: 재현 조건 특정

- 새 세션 -> **정상** (1번)
- 새로고침 후 세션 재연결 -> **이중** (2번)

---

## 근본 원인

### React StrictMode WebSocket 이중 연결

React 18 StrictMode는 개발 모드에서 useEffect를 **mount -> cleanup -> remount** 합니다.

```
1. Mount:   connect() -> WS1 생성 -> 서버에 연결 -> subscribe 전송
2. Cleanup: WS1.close() -- 하지만 서버에서 WS1 즉시 제거 안 됨 (async)
3. Remount: connect() -> WS2 생성 -> 서버에 연결 -> subscribe 전송
```

**서버 상태**: subscriber Set에 `{WS1, WS2}` 공존 (WS1은 닫히는 중)
**클라이언트**: WS1.onmessage와 WS2.onmessage **둘 다** 활성 상태

```
PTY 출력 "안"
  -> 서버가 WS1에 전송 -> WS1.onmessage -> handleMessage -> write("안")  [1차]
  -> 서버가 WS2에 전송 -> WS2.onmessage -> handleMessage -> write("안")  [2차]
```

### 왜 한글이 특히 심하게 보였나

영문도 이중이지만 PTY echo가 동일 위치에 같은 문자를 2번 쓰면 시각적으로 차이 없음.
한글은 IME **composition overlay** + **이중 echo** 합성으로 더 심하게 깨져 보임.

---

## 수정 내용 (2건)

### 수정 1: Stale WebSocket 메시지 차단 (핵심)

**파일**: `frontend/src/contexts/WebSocketContext.tsx`

```typescript
// Before
ws.onmessage = handleMessage;

// After
ws.onmessage = (event) => {
  if (wsRef.current !== ws) return; // Stale connection guard
  handleMessage(event);
};
```

### 수정 2: 중복 구독 시 버퍼 flush 방지 (보조)

**파일**: `server/src/ws/WsRouter.ts`

```typescript
const alreadySubscribed = subs.has(ws);
subs.add(ws);
if (!alreadySubscribed) {
  this.sessionManager.flushBufferToWs(id, ws);
}
```

---

## 교훈

1. **증상이 가리키는 곳이 원인이 아닐 수 있다** -- "한글이 깨진다" -> IME 문제로 보이지만 실제로는 WebSocket 이중 연결
2. **진단 로그가 가장 빠른 길** -- 추측으로 5번 실패, 로그 2번으로 해결
3. **입력과 출력을 분리하여 추적** -- onData(입력)는 정상, write(출력)이 이중 -> 문제 구간 즉시 특정
4. **React StrictMode는 네트워크 리소스에 주의** -- 컴포넌트 이중 마운트뿐 아니라 WebSocket/SSE 같은 영속 연결도 이중 생성됨

---

## xterm.js CompositionHelper 내부 동작 (참고)

xterm.js 소스 코드 분석 결과, IME 처리는 정상이었음:

- `CompositionHelper.keydown()`: keyCode 229(Process)이면 `return false` -> xterm 기본 키 처리 건너뜀
- `CompositionHelper.compositionend()`: `_finalizeComposition(true)` -> setTimeout(0)으로 textarea 값 읽어서 `triggerDataEvent()` -> `onData` 발생
- `_handleAnyTextareaChanges()`: `_isComposing`이 true이면 아무것도 안 함

xterm.js v6의 IME 처리는 정확히 1번만 `onData`를 발생시키며, 이중 전송하지 않음.
