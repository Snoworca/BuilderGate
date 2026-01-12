# Claude Web Shell

Claude AI 전용 웹 기반 쉘 인터페이스입니다.

## Features

- 다중 쉘 세션 관리
- 실시간 출력 스트리밍 (SSE)
- 세션 상태 표시 (작업 중: 빨간색, 대기 중: 초록색)
- xterm.js 기반 터미널 에뮬레이터

## Quick Start

### Prerequisites

- Node.js 18+
- npm

### Installation & Run

#### 1. Backend

```bash
cd server
npm install
npm run dev
```

서버가 http://localhost:4242 에서 실행됩니다.

#### 2. Frontend

새 터미널에서:

```bash
cd frontend
npm install
npm run dev
```

프론트엔드가 http://localhost:3000 에서 실행됩니다.

### Usage

1. 브라우저에서 http://localhost:3000 접속
2. "New Session" 버튼으로 새 쉘 세션 생성
3. 터미널에서 명령어 입력 및 실행

## Tech Stack

### Backend
- Node.js + TypeScript
- Express.js
- node-pty (PTY 프로세스 관리)
- SSE (Server-Sent Events)

### Frontend
- React 18 + TypeScript
- Vite
- xterm.js (터미널 에뮬레이터)

## API

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions` | 세션 목록 조회 |
| POST | `/api/sessions` | 새 세션 생성 |
| DELETE | `/api/sessions/:id` | 세션 삭제 |
| POST | `/api/sessions/:id/input` | 명령 입력 |
| POST | `/api/sessions/:id/resize` | 터미널 크기 조정 |
| GET | `/api/sessions/:id/stream` | SSE 스트림 |

### SSE Events

- `output`: 쉘 출력 데이터
- `status`: 세션 상태 변경 (running/idle)
- `error`: 에러 메시지

## Security Notice

이 애플리케이션은 localhost 전용으로 설계되었습니다.
퍼블릭 네트워크에 노출하면 심각한 보안 위험이 있습니다.

## License

MIT
