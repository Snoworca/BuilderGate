# Integration Test Guide

## 목표

`build.js`와 `start.js`가 합쳐졌을 때 production-like 로컬 실행이 실제로 성립하는지 검증한다.

## 사전 조건

- `server`와 `frontend` 의존성 설치 완료
- 로컬 검증 포트 사용 가능
- 브라우저에서 self-signed certificate 경고를 허용할 수 있음

## 권장 검증 순서

1. `node build.js`
2. AGENTS 검증 기준이면 `node start.js --port 2002`
3. `curl -k https://localhost:2002/health`
4. 브라우저에서 `https://localhost:2002/`
5. 비밀번호 `1234`로 로그인
6. workspace/tab 생성
7. terminal output, cwd, websocket 연결 확인

## 포트 규칙

- 기본 launcher fallback:
  - CLI `--port`와 config `server.port`가 모두 없으면 `2222`
- AGENTS 검증:
  - 반드시 `https://localhost:2002`를 사용
  - 따라서 검증 시에는 `node start.js --port 2002` 또는 config `server.port=2002`를 사용

## 필수 통합 시나리오

### 시나리오 1: health + root entry

- Expected:
  - `/health` -> 200 JSON
  - `/` -> HTML 문서
  - `/assets/...` -> static asset

### 시나리오 2: auth + app shell

- Expected:
  - 로그인 화면 렌더링
  - `1234` 로그인 경로가 동작
  - authenticated app shell 렌더링

### 시나리오 3: ws-backed terminal session

- Expected:
  - session 생성 가능
  - terminal output 수신
  - websocket 연결 유지

### 시나리오 4: reserved route protection

- Expected:
  - `/api/...` 는 API route 유지
  - `/ws` upgrade 유지
  - missing asset은 404

## 선택 시나리오

- default fallback run: `node start.js` -> expected `2222`
- alternate port run: `node start.js --port 2444`
- restart after rebuild
- stale public asset cleanup 확인

## 실패 시 우선 점검

1. `server/dist/index.js` 존재 여부
2. `server/dist/public/index.html` 존재 여부
3. `NODE_ENV=production` 주입 여부
4. `cwd=server` 보장 여부
5. production static fallback ordering
