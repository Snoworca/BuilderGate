# 역방향 프록시 전환 계획 및 구현

> **변경**: Browser -> Vite(4545) ->proxy-> Backend(4242) 에서 Browser -> Backend(4242) ->proxy-> Vite(4545) 로 전환
> **효과**: ECONNABORTED 해소, CORS 불필요, 단일 진입점

---

## 구조 비교

### Before (Vite가 프록시)

```
Browser --https:4545--> Vite Dev Server
                          |-- /api/*  --proxy--> Backend(4242)
                          |-- /ws     --proxy--> Backend(4242)  <- ECONNABORTED
                          +-- /*      --> React HMR (직접 서빙)
```

### After (백엔드가 프록시)

```
Browser --https:4242--> Express Backend
                          |-- /api/*  --> 직접 처리 (라우트)
                          |-- /ws     --> 직접 처리 (WsRouter)
                          +-- /*      --proxy--> Vite(4545)     <- HMR/정적 에셋만
```

---

## 변경 파일 목록

| 파일 | 변경 내용 |
|------|-----------|
| `server/src/ws/WsRouter.ts` | `public handleUpgrade()` 노출, 생성자에서 `server` 제거 |
| `server/src/index.ts` | http-proxy 프록시 + upgrade 분기 + CSP 완화(개발) |
| `frontend/vite.config.ts` | proxy 제거, HMR `path/clientPort/protocol` 설정 |
| `frontend/src/contexts/WebSocketContext.tsx` | 주석 업데이트 |
| `server/package.json` | `http-proxy` + `@types/http-proxy` |
| `dev.js` | 접속 URL 안내 |

---

## Vite HMR 설정

```typescript
// vite.config.ts
server: {
  port: 4545,
  hmr: {
    path: '/__vite_hmr',    // 명시적 경로 (WS /ws와 충돌 방지)
    port: 4545,             // Vite 서버 포트
    clientPort: 4242,       // 브라우저가 연결할 포트 (백엔드)
    protocol: 'wss',        // HTTPS 백엔드이므로 wss
  },
}
```

---

## CSP 완화 (개발 환경)

백엔드가 Vite를 프록시하면 helmet CSP가 Vite 인라인 스크립트를 차단함.
개발 환경에서만 완화:

```typescript
const isDev = process.env.NODE_ENV !== 'production';
app.use(createSecurityHeadersMiddleware({
  enableHSTS: true,
  ...(isDev && {
    cspDirectives: {
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "wss:", "ws:"],
      workerSrc: ["'self'", "blob:"],
      // ... 나머지 기본값 유지
    }
  })
}));
```

---

## Upgrade 이벤트 분기

```typescript
httpsServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', ...).pathname;
  if (pathname === '/ws') {
    wsRouter.handleUpgrade(req, socket, head);  // BuilderGate WS
  } else if (viteProxy) {
    viteProxy.ws(req, socket, head);            // Vite HMR WS
  } else {
    socket.destroy();
  }
});
```
