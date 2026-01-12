# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Web Shell** (CodeName: ProjectMaster) - A web-based shell interface for Claude AI to execute shell commands with real-time output streaming.

- **Status**: MVP (Pilot phase)
- **Architecture**: Full-stack Node.js + React with TypeScript
- **Communication**: SSE (Server→Client) + HTTP POST (Client→Server)

## Development Commands

### Backend (server/)

```bash
cd server
npm install          # Install dependencies
npm run dev          # Development with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled version (node dist/index.js)
```

Server runs on `http://localhost:4242`

### Frontend (frontend/)

```bash
cd frontend
npm install          # Install dependencies
npm run dev          # Vite dev server with HMR
npm run build        # TypeScript check + Vite production build
npm run lint         # ESLint validation
npm run preview      # Preview production build
```

Frontend runs on `http://localhost:3000` with API proxy to backend.

### Full Stack Development

Run both in separate terminals:
```bash
# Terminal 1
cd server && npm run dev

# Terminal 2
cd frontend && npm run dev
```

Open `http://localhost:3000` in browser.

## Architecture

### Communication Pattern

```
Frontend (React)                    Backend (Express)
     │                                    │
     │──── POST /api/sessions ───────────>│  Create session
     │<─── Session JSON ──────────────────│
     │                                    │
     │──── GET /api/sessions/:id/stream ─>│  SSE connection
     │<═══ SSE: output, status events ════│  Real-time streaming
     │                                    │
     │──── POST /api/sessions/:id/input ─>│  Send command (fire-and-forget)
     │                                    │
```

### Key Backend Components

- **SessionManager** (`server/src/services/SessionManager.ts`): Core service managing session lifecycle, PTY processes, and SSE client connections
- **sessionRoutes** (`server/src/routes/sessionRoutes.ts`): REST API endpoints
- **config** (`server/src/utils/config.ts`): JSON5-based configuration loader

### Key Frontend Components

- **useSession** (`frontend/src/hooks/useSession.ts`): Session state management hook
- **useSSE** (`frontend/src/hooks/useSSE.ts`): SSE connection and event handling
- **TerminalView** (`frontend/src/components/Terminal/TerminalView.tsx`): xterm.js wrapper
- **api** (`frontend/src/services/api.ts`): HTTP client for REST endpoints

### Data Flow

1. User creates session → POST creates PTY process with UUID
2. Frontend opens SSE stream → receives buffered output + live events
3. User types command → POST to input endpoint → writes to PTY
4. PTY outputs → Backend broadcasts via SSE → Frontend renders in xterm.js
5. Idle detection (200ms) → status change broadcast

## API Reference

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create new session |
| GET | `/api/sessions/:id` | Get session details |
| DELETE | `/api/sessions/:id` | Delete session and kill PTY |
| POST | `/api/sessions/:id/input` | Send input to PTY |
| POST | `/api/sessions/:id/resize` | Resize terminal (cols, rows) |
| GET | `/api/sessions/:id/stream` | SSE stream for output/status |
| GET | `/health` | Health check |

### SSE Events

- `output`: Shell output data `{ data: string }`
- `status`: Session status change `{ status: 'running' | 'idle' }`
- `error`: Error messages `{ message: string }`

## Configuration

Backend configuration via `server/config.json5`:

```json5
{
  server: { port: 4242 },
  pty: {
    termName: "xterm-256color",
    cols: 80,
    rows: 24,
    maxBufferSize: 65536,
    idleTimeout: 200,
    // Windows-specific: "conpty" or "winpty"
    windowsBackend: "conpty"
  }
}
```

## Session Status Indicators

- 🔴 Red (`#EF4444`): Command running
- 🟢 Green (`#22C55E`): Idle, waiting for input

## TypeScript Interfaces

Shared interfaces are defined in:
- Backend: `server/src/types/index.ts`
- Frontend: `frontend/src/types/index.ts`

Key types: `Session`, `SessionStatus`, `CreateSessionRequest`, `InputRequest`, `ResizeRequest`

## Vite Proxy Configuration

Frontend proxies `/api/*` requests to backend via `vite.config.ts`:
```typescript
proxy: {
  '/api': {
    target: 'http://localhost:4242',
    changeOrigin: true
  }
}
```

## Security Notice

This application is designed for **localhost only**. Exposing to public networks poses serious security risks as it provides shell access without authentication.
