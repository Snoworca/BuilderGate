# BuilderGate

코딩 에이전트 병렬 운용을 위한 웹 기반 통합 개발 환경. 상세 비전은 [PRD.md](./PRD.md) 참조.

## 목적

브라우저 하나로 다수의 셸 세션을 관리하고, 파일 탐색/편집하며, 세션 간 에이전트 명령을 중계한다. 최종 목표는 원격에서 N개 코딩 에이전트를 동시 운용하여 병렬 개발을 수행하는 것.

- 웹 터미널 (다중 세션/탭, PTY 기반)
- Mdir 스타일 파일 매니저 + 마크다운/코드 뷰어
- Task 관리자 + MCP 통합 (예정)
- 세션 간 에이전트 오케스트레이션 (예정)

## Quick Start

```bash
node dev.js          # 서버(4242) + 프론트(4545) 동시 실행
```

브라우저에서 `http://localhost:4545` 접속. 서버 상태 확인: `curl -k https://localhost:4242/health`
- 비밀번호 1234
- 코드 수정하면 자동으로 갱신됨

## Tech Stack

- **Backend**: Node.js + Express + TypeScript, node-pty, JWT auth
- **Frontend**: React 18 + TypeScript, Vite, xterm.js
- **Communication**: SSE (server→client) + HTTP POST (client→server)
- **Config**: `server/config.json5` (JSON5 + Zod validation)

## Project Structure

```
server/src/
  services/SessionManager.ts   # PTY 세션 관리 + SSE 브로드캐스트
  services/FileService.ts      # 파일 탐색/CRUD
  services/AuthService.ts      # JWT 인증
  routes/sessionRoutes.ts      # REST API
  routes/fileRoutes.ts         # 파일 API

frontend/src/
  hooks/useSession.ts          # 세션 상태
  hooks/useSSE.ts              # SSE 연결
  hooks/useTabManager.ts       # 탭 상태 머신
  components/Terminal/          # xterm.js 래퍼
  components/FileManager/       # Mdir 스타일 파일 매니저
  components/Viewer/            # Markdown + Code 뷰어
```

## Rules

- **`kill {pid}`** 또는  **`taskkill /F /IM node.exe` 절대 금지** — dev.js가 hot reload로 자동 재시작함
- **스크린샷 저장 경로**: `.playwright-mcp/` (루트에 png 파일 두지 말 것)
- **보안**: HTTPS + JWT + 2FA(선택) + 파일 경로 보안. localhost 전용

## API (주요)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/sessions` | 세션 생성 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |
| POST | `/api/sessions/:id/input` | PTY 입력 |
| GET | `/api/sessions/:id/stream` | SSE 스트림 |
| GET | `/api/sessions/:id/files` | 파일 목록 |
| GET | `/health` | 상태 확인 |
