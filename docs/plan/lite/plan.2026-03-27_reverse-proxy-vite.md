---
title: 역방향 프록시 전환 — 백엔드가 Vite를 프록시
project: BuilderGate
date: 2026-03-27
type: fix
tech_stack: Node.js/Express/TypeScript + React/Vite/TypeScript + ws + node-pty
code_path: C:\Work\git\_Snoworca\ProjectMaster
---

# 역방향 프록시 전환 — 백엔드가 Vite를 프록시

## 1. 의도 및 요구사항

### 1.1 목적
Vite의 http-proxy가 HTTPS 백엔드로의 WebSocket 업그레이드를 불안정하게 처리하여 ECONNABORTED 에러가 반복 발생하므로, 프록시 방향을 반전하여 백엔드(Express)가 단일 진입점 역할을 하도록 전환한다.

### 1.2 배경
- 현재 구조: Browser → Vite(4545) →proxy→ Backend(4242). Vite의 http-proxy가 /ws, /api를 백엔드로 프록시
- 문제: Vite 프록시가 HTTPS+WebSocket 업그레이드 시 TLS 소켓 상태 관리 실패 → ECONNABORTED 반복
- 추가 문제: 프록시 경유 시 JWT 토큰 유실 가능성, 프록시 idle timeout, 서버의 socket.destroy() drain 없음
- 목표 구조: Browser → Backend(4242) →proxy→ Vite(4545). WebSocket은 프록시 없이 직접 처리

### 1.3 기능 요구사항
- FR-1: 백엔드(Express)가 개발 환경에서 비-API/비-WS 요청을 Vite dev server(http://localhost:4545)로 프록시한다
- FR-2: Vite HMR WebSocket(경로: `/__vite_hmr`)을 백엔드가 Vite로 포워딩한다 (livereload 동작 보장)
- FR-3: BuilderGate WebSocket(`/ws`)은 프록시 없이 WsRouter가 직접 처리한다
- FR-4: Vite의 기존 /api, /ws 프록시 설정을 제거한다
- FR-5: 브라우저 접속 URL이 https://localhost:4242 로 통합된다 (4545 직접 접속 불필요)

### 1.4 비기능 요구사항
- NFR-1: 프로덕션 빌드 시 Vite 프록시 코드가 활성화되지 않아야 한다 (개발 환경 전용)
- NFR-2: Vite HMR livereload가 코드 수정 시 정상 동작해야 한다

### 1.5 제약사항
- 백엔드는 HTTPS(자체서명 인증서), Vite dev server는 HTTP로 운영
- WsRouter 생성자가 현재 `server.on('upgrade')`를 직접 등록하므로 리팩토링 필요
- `http-proxy` 패키지를 서버에 새로 설치 (http-proxy-middleware 대신 저수준 http-proxy 사용 — upgrade 핸들링이 명확)

## 2. 현행 코드 분석

### 2.1 영향 범위
| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| server/src/index.ts | 수정 | Vite 프록시 추가, upgrade 이벤트 통합 분기, WsRouter 생성자 호출 변경 |
| server/src/ws/WsRouter.ts | 수정 | setupUpgradeHandler → public handleUpgrade, 생성자에서 server 파라미터 제거, authService 인스턴스 변수화, 미사용 import 제거 |
| frontend/vite.config.ts | 수정 | proxy 설정 전체 제거, HMR 경로 명시 |
| frontend/src/contexts/WebSocketContext.tsx | 수정 | getWsUrl() 주석 업데이트 (로직 동일) |
| server/package.json | 수정 | http-proxy + @types/http-proxy 의존성 추가 |
| dev.js | 수정 | 접속 URL 안내 메시지 변경 |

**WsRouter 생성자 호출부 전수조사**: `new WsRouter()`는 `server/src/index.ts:273` **한 곳에서만** 호출됨 (Grep 확인). `SessionManager.ts`, `workspaceRoutes.ts`는 인스턴스 참조만 사용 — 생성자 변경 영향 없음.

### 2.2 재사용 가능 코드
- WsRouter의 `noServer: true` + `wss.handleUpgrade()` 패턴 그대로 유지
- api.ts의 `API_BASE = '/api'` (상대 경로) — 변경 불필요
- WebSocketContext의 `getWsUrl()`은 `window.location.host` 사용 → 포트 변경에 자동 대응

### 2.3 주의사항
- WsRouter에서 `server.on('upgrade')` 직접 등록을 **반드시 제거** — index.ts의 통합 분기와 중복 실행 방지
- Vite 7 HMR WebSocket: `hmr.path`를 `/__vite_hmr`로 명시하여 `/ws`와 경로 충돌 방지
- `http-proxy`의 `ws()` 메서드로 upgrade 요청 직접 포워딩 — http-proxy-middleware보다 제어 명확

## 3. 구현 계획

## Phase 1: 서버 인프라 변경 (WsRouter 리팩토링 + 의존성)

- [x] Phase 1-1: `server/package.json`에 `http-proxy`(dependencies) + `@types/http-proxy`(devDependencies) 추가 후 `cd server && npm install` 실행 `FR-1`
- [x] Phase 1-2: `WsRouter.ts` — 클래스 상단에 `private authService: AuthService` 필드 선언 추가. 생성자 시그니처를 `constructor(authService: AuthService, sessionManager: SessionManager)`로 변경 (server 파라미터 제거). 생성자 본문에서 `this.authService = authService` 할당 추가, `this.setupUpgradeHandler(server, authService)` 호출 제거 `FR-3`
- [x] Phase 1-3: `WsRouter.ts` — `private setupUpgradeHandler(server, authService)` 메서드를 `public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void`로 변환. 메서드 본문에서 `server.on('upgrade', ...)` 래핑을 제거하고 콜백 내부 로직만 유지. `/ws` 경로 체크(`if (url.pathname !== '/ws')`) 제거 (index.ts에서 분기). `authService.verifyToken()` → `this.authService.verifyToken()`으로 변경 `FR-3`
- [x] Phase 1-4: `WsRouter.ts` — 상단의 `import https from 'https';` 제거 (더 이상 사용되지 않음) `FR-3`

- **테스트:**
  - (정상) `cd server && npx tsc --noEmit` — 컴파일 에러 없음
  - (예외) handleUpgrade에 빈 토큰 전달 시 401 응답 확인: `curl -k --include -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" "https://localhost:4242/ws"` → `HTTP/1.1 401 Unauthorized` 응답

## Phase 2: 백엔드에 Vite 프록시 + upgrade 분기 추가

- [x] Phase 2-1: `index.ts` — 상단에 `import httpProxy from 'http-proxy';` 추가. `startServer()` 함수 내에서 `setupRoutes()` 호출 부근에 아래 코드 배치 `FR-1`:
  ```typescript
  // Vite dev server proxy (development only)
  let viteProxy: ReturnType<typeof httpProxy.createProxyServer> | null = null;
  if (process.env.NODE_ENV !== 'production') {
    viteProxy = httpProxy.createProxyServer({
      target: 'http://localhost:4545',
      ws: true,
    });
    viteProxy.on('error', (err, _req, res) => {
      console.warn('[ViteProxy]', err.message);
      if (res && 'writeHead' in res) {
        (res as any).writeHead?.(502);
        (res as any).end?.('Vite dev server unavailable');
      }
    });
  }
  ```
- [ ] Phase 2-2: `index.ts` — `setupRoutes()` 호출 뒤, 에러 핸들러보다 앞에 Vite 프록시 fallback 미들웨어 등록 `FR-1`:
  ```typescript
  if (viteProxy) {
    app.use((req, res) => {
      viteProxy!.web(req, res);
    });
  }
  ```
- [ ] Phase 2-3: `index.ts` — WsRouter 생성자 호출 변경: `new WsRouter(httpsServer, authService, sessionManager)` → `new WsRouter(authService, sessionManager)` `FR-3`
- [ ] Phase 2-4: `index.ts` — `httpsServer.listen()` 전에 upgrade 이벤트 통합 분기 핸들러 등록 `FR-2` `FR-3`:
  ```typescript
  httpsServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`).pathname;
    if (pathname === '/ws') {
      // BuilderGate WebSocket → WsRouter 직접 처리
      wsRouter.handleUpgrade(req, socket, head);
    } else if (viteProxy) {
      // 개발 환경: Vite HMR 등 기타 WebSocket → Vite로 포워딩
      viteProxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  });
  ```

- **테스트:**
  - (정상) https://localhost:4242 접속 시 Vite가 서빙하는 React 앱이 로드됨
  - (정상) `curl -k https://localhost:4242/api/auth/status` → Express 라우트가 처리 (프록시 아님)
  - (정상) /ws WebSocket 연결이 WsRouter에 의해 직접 처리됨 — 브라우저 콘솔에서 `[WS] Connected` 확인
  - (예외) Vite dev server를 종료한 상태에서 https://localhost:4242 접속 시 502 응답 반환, 서버 프로세스는 생존

## Phase 3: Vite 설정 변경 + 프론트엔드 정리

- [ ] Phase 3-1: `vite.config.ts` — `server.proxy` 객체 전체 삭제 (/api, /ws 프록시 모두 제거) `FR-4`
- [ ] Phase 3-2: `vite.config.ts` — `server.hmr` 설정을 `{ path: '/__vite_hmr', port: 4545 }`로 변경. `server.host` 미설정 또는 `localhost`(기본값)인지 확인하고 유지 `FR-2`
- [ ] Phase 3-3: `WebSocketContext.tsx:55` — 주석 `// Use same host/port as the page (Vite proxy handles /ws → backend)` → `// Same origin — backend serves both API and frontend assets` 로 변경 `FR-5`
- [ ] Phase 3-4: `dev.js` — 서버 시작 후 (setTimeout 내부) `console.log('Open https://localhost:4242 in your browser');` 메시지 추가 `FR-5`

- **테스트:**
  - (정상) 프론트엔드 소스 파일(예: App.tsx) 수정 후 저장 → 브라우저에서 HMR livereload 동작 (페이지 새로고침 없이 변경 반영)
  - (정상) https://localhost:4242 에서 WebSocket 연결 성공, 터미널 입출력 정상
  - (예외) https://localhost:4545 직접 접속 시 앱은 로드되나 API/WS 요청 실패 (예상 동작)

## 4. 검증 기준
- [ ] 빌드 성공: `cd server && npx tsc --noEmit` 에러 없음
- [ ] ECONNABORTED 에러 로그가 더 이상 발생하지 않음
- [ ] https://localhost:4242 에서 React 앱 로드 + WebSocket 연결 + 터미널 동작 확인
- [ ] Vite HMR livereload 동작 확인 (프론트엔드 코드 수정 시 브라우저 자동 반영)
- [ ] 요구사항 전수 매핑:
  - FR-1 → Phase 2-1, 2-2
  - FR-2 → Phase 2-4, 3-2
  - FR-3 → Phase 1-2, 1-3, 2-3, 2-4
  - FR-4 → Phase 3-1
  - FR-5 → Phase 3-3, 3-4
  - NFR-1 → Phase 2-1의 `process.env.NODE_ENV !== 'production'` 분기
  - NFR-2 → Phase 3 테스트의 HMR 동작 확인
