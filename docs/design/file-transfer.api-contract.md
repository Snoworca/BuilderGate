# 파일 전송 API 계약 (file-transfer, #139)

서버와 프런트엔드가 함께 따르는 계약이다. 요구사항은 `docs/spec/42.file-explorer.srs.md` 의
FR-FEX-022~026, `docs/spec/43.file-operations.srs.md` 의 FR-FOP-006 이다. 시안은
`docs/design/file-explorer-upload-download.html` 이다.

경로는 모두 세션 작업 폴더 기준 상대 경로이고, 기존 파일 API 와 같은 규칙으로 해석한다.
오류 응답은 기존 `AppError.toJSON()` 형식(`{ error: { code, message } }`)을 따른다.

## 1. 업로드 (FR-FEX-023)

### 1.1 사전 검사 — `POST /api/sessions/:id/files/upload/check` (JWT)

요청:

```json
{ "dir": "src/components", "files": [{ "path": "a.png", "size": 1200 }, { "path": "assets/b.svg", "size": 300 }] }
```

- `dir` 은 대상 폴더다. `path` 는 그 아래의 상대 경로이며, 폴더 업로드에서는 하위 폴더를 포함한다.

응답 200:

```json
{
  "conflicts": [{ "path": "a.png", "existing": { "size": 900, "modified": "ISO8601", "isDirectory": false }, "decisions": ["overwrite", "rename", "skip"] }],
  "rejected": [{ "path": "x.exe", "code": "PATH_BLOCKED" }]
}
```

- 종류가 다르면(파일과 폴더) `decisions` 는 `["rename", "skip"]` 이다(FR-FOP-004 AC-7).
- `rejected` 의 코드는 `PATH_TRAVERSAL`, `PATH_BLOCKED`, `INVALID_UPLOAD_PATH`, `FILE_TOO_LARGE` 중 하나다.
- 폴더 업로드에서는 대상 위치의 최상위 이름 하나가 같으면 충돌이다(폴더 안 파일들은 그 결정을 따른다).
  같은 이름의 폴더에 `overwrite` 를 고르면 안의 파일을 합치되, 겹치는 파일은 덮어쓴다.

### 1.2 전송 — `PUT /api/sessions/:id/files/upload?dir=<dir>&path=<path>&conflict=<fail|overwrite|rename|skip>` (JWT)

- 본문은 원시 바이트 스트림이다(`Content-Type: application/octet-stream`, `Content-Length` 필수).
- 전역 JSON body 파서와 body 크기 제한이 이 경로를 막지 않아야 한다.
- 기본 `conflict=fail` 이다. 이름이 있으면 본문을 쓰지 않고 `409 FILE_ALREADY_EXISTS` 를 답한다.
- `rename` 은 FR-FOP-004 규칙의 이름(`이름 (2).확장자`)을 만든다. `skip` 은 아무것도 쓰지 않고 `{ skipped: true }` 를 답한다.
- 응답 200: `{ "name": "a (2).png", "path": "src/components/a (2).png", "size": 1200, "skipped": false }`
- 오류 코드:
  - `400 INVALID_UPLOAD_PATH`: `..`, 절대 경로, NUL, Windows 예약 이름
  - `403 PATH_TRAVERSAL` / `403 PATH_BLOCKED`: 링크의 realpath 가 세션 밖이거나 차단 경로·확장자
  - `413 FILE_TOO_LARGE`: `fileManager.maxUploadFileSize`, 기본 2 GiB(2147483648), 범위 1 MiB~100 GiB
  - `429 UPLOAD_BUSY`: 세션당 동시 6개 초과
- 임시 파일은 대상 폴더 안의 `.bgupload-<random>.part` 이다.
  - 목록 API 와 검색 결과에 나오지 않는다.
  - 마지막 바이트를 받은 뒤 `rename` 으로 제자리에 놓는다. 덮어쓰기면 기존 파일을 교체한다.
  - 요청이 끊기거나(`req` 의 `aborted`/`close`), 쓰기 오류가 나거나, 크기가 초과되면 임시 파일을 지운다.
- 진행 중인 임시 파일 경로는 `server/data/upload-temp.json` 에 기록한다. 서버를 시작할 때 그 목록의 파일을 지우고 목록을 비운다(FR-FEX-023 AC-6).
- 중간 폴더가 없으면 대상 폴더 안에서 만든다.

## 2. ZIP 다운로드 (FR-FEX-025)

### 2.1 사전 계산 — `POST /api/sessions/:id/files/zip/precount` (JWT)

요청: `{ "paths": ["src/editor", "src/App.tsx"] }`

응답 200:

```json
{ "name": "components.zip", "fileCount": 1234, "totalBytes": 5242880, "excluded": [".git", "node_modules"], "skippedBlocked": 2 }
```

- 이름 규칙: 경로가 디렉터리 하나면 `{그 이름}.zip`, 아니면 `{공통 부모 폴더 이름}.zip` 이다. 세션 루트면 루트 폴더 이름을 쓴다.
- `.git`, `node_modules`, 차단 경로, 차단 확장자는 개수와 크기에서 뺀다. 심볼릭 링크는 따라가지 않고 건너뛴다.

### 2.2 토큰 — `POST /api/sessions/:id/files/zip/token` (JWT)

요청: `{ "paths": [...] }`

응답 200: `{ "token", "url": "/api/downloads/<token>", "name", "jobId" }`

- 토큰은 기존 `DownloadTokenStore` 를 확장한 것이다. 한 번만 쓸 수 있고 60초 동안 유효하며, `kind: 'zip'` 과 해석된 경로 목록에 묶인다.

### 2.3 스트림 — `GET /api/downloads/<token>` (토큰만, JWT 없음)

- `kind: 'zip'` 이면 경로를 다시 검증한 뒤 ZIP 을 스트리밍한다.
  - deflate 를 쓰고, 가능하면 level 1 이다.
  - 응답 헤더: `Content-Type: application/zip`, `Content-Disposition`(기존 `contentDisposition()`), `nosniff`, `no-store`.
  - `Content-Length` 는 없다.
- 엔트리 경로는 선택 항목 이름부터 시작한다(`editor/...`, `App.tsx`).
- 읽을 수 없는 엔트리는 빼고, 마지막에 `_skipped.txt` 엔트리에 그 경로와 이유를 적는다. 빠진 것이 없으면 이 엔트리를 만들지 않는다.

### 2.4 진행·취소 — `GET /api/sessions/:id/files/zip/jobs/:jobId` · `DELETE …/:jobId` (JWT)

- GET 은 `{ "state": "pending"|"streaming"|"done"|"cancelled"|"failed", "sentBytes": n, "totalBytes": n }` 를 답한다. `sentBytes` 는 압축 전 원본 기준이다.
- DELETE 는 스트림을 끊고 `cancelled` 로 만든다.
- 끝난 job 은 60초 뒤 지운다. 모르는 jobId 는 404 다.

## 3. 프런트엔드 흐름 요약

- 업로드: 고르기·드롭 → `check` → 충돌이 있으면 FR-FOP-006 모달(남은 개수 체크박스) → `PUT` 을 동시 3개까지 보낸다.
  - `XMLHttpRequest` 의 `upload.onprogress` 로 진행률을 받는다(fetch 는 업로드 진행을 주지 않는다).
  - 파일마다 실패하면 1회 자동으로 다시 보낸다.
- ZIP: `precount` 를 보낸다.
  - 1 GiB 이하이고 1만 개 이하이며 1초 이내에 끝나면, 곧바로 `token` 을 받고 링크를 클릭한다(기존 `startFileDownload` 와 같은 방식).
  - 그렇지 않으면 확인 바를 띄우고, [받기]를 누를 때 `token` 을 받는다.
  - 진행률은 `jobs/:jobId` 를 500ms 간격으로 폴링한다. 취소는 `DELETE` 다.
