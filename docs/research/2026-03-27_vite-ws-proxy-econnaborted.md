# Vite WebSocket Proxy ECONNABORTED 에러 분석

> **발생 환경**: `node ./dev.js` -> `http://localhost:4545` 접속 후 사용 중
> **증상**: `[vite] ws proxy error: Error: write ECONNABORTED` 로그가 끊임없이 반복
> **분석일**: 2026-03-27

---

## 에러 재현 흐름

```
1. 프론트엔드가 wss://localhost:4545/ws?token=... 으로 WebSocket 연결 시도
2. Vite dev server가 upgrade 요청을 수신
3. Vite 내부 http-proxy가 백엔드(https://localhost:4242)로 포워딩 시도
4. 토큰 누락/헤더 변조/TLS 핸드셰이크 실패 등으로 백엔드가 소켓 즉시 파괴
5. Vite 프록시가 이미 닫힌 소켓에 write 시도 -> ECONNABORTED
```

---

## 근본 원인 (6개 식별)

### WS-1. Vite 프록시의 TLS WebSocket 업그레이드 처리 결함 (CRITICAL)

**파일**: `frontend/vite.config.ts:23-28`

- Vite의 `http-proxy`는 `ws: true`로 WebSocket 업그레이드를 처리하지만, HTTPS 백엔드에 대한 자체서명 인증서 + 소켓 상태 관리가 불완전
- `secure: false`로 인증서 검증은 우회하지만, 업그레이드 과정에서 TLS 소켓 상태가 비정상적으로 닫히면 프록시가 이를 감지하지 못하고 이미 닫힌 소켓에 write 시도

### WS-2. 서버 소켓 즉시 파괴 (drain 없음) (HIGH)

**파일**: `server/src/ws/WsRouter.ts:42-72`

- HTTP 응답을 write한 직후 `socket.destroy()` 호출
- 응답 데이터가 TCP 버퍼에서 flush되기 전에 소켓이 파괴됨

### WS-3. 프록시 경유 시 토큰 유실 가능성 (HIGH)

**파일**: `frontend/src/contexts/WebSocketContext.tsx:53-60`

- 토큰을 URL 쿼리 파라미터로 전달
- `http-proxy`의 일부 버전에서 WebSocket 업그레이드 시 쿼리 스트링이 정상 전달되지 않는 이슈 존재

### WS-4. 프록시 연결에 Keep-Alive/Heartbeat 부재 (HIGH)

- 서버의 heartbeat는 WebSocket 연결 성공 후에만 동작
- Vite 프록시의 기본 idle timeout(60~120초) 내에 데이터 교환이 없으면 프록시가 연결을 끊음

### WS-5. HTTP Keep-Alive가 WebSocket 업그레이드에 미적용 (MEDIUM)

- `keepAliveTimeout`은 일반 HTTP 요청에만 적용되며, WebSocket 업그레이드 소켓에는 무관

### WS-6. 프록시의 WebSocket 헤더 변조 가능성 (MEDIUM)

- `changeOrigin: true` 설정으로 `Host` 헤더가 변경됨
- WebSocket 업그레이드에 필수적인 헤더가 변조/누락 가능

---

## 해결: 역방향 프록시 전환

**현재**: Browser -> Vite(4545) ->proxy-> Backend(4242) (ECONNABORTED)
**변경**: Browser -> Backend(4242) ->proxy-> Vite(4545) (에러 없음)

- WebSocket은 백엔드가 직접 처리 (프록시 안 거침)
- API도 Express가 직접 처리
- Vite는 정적 에셋/HMR만 프록시
