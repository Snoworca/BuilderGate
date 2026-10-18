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

## 4. 압축 풀기 (FR-FOP-007, FR-FEX-027)

지원 형식은 `.zip`, `.tar`, `.tar.gz`, `.tgz` 이고, 확장자로 판정한다.
압축 풀기는 파일 작업(IR-FOP-001·002)의 한 종류이므로, 진행·결정·취소·완료는 copy·move 와 같은 WebSocket 이벤트와 REST 경로를 쓴다.

### 4.1 사전 계산 — `POST /api/sessions/:id/files/extract/precount` (JWT)

요청: `{ "path": "uploads/bundle.tar.gz", "mode": "smart" | "here" }`

- `path` 는 기존 파일 API 규칙으로 해석한다. 세션 밖이거나 차단된 경로는 오류 응답(403 등)이다.
- `mode` 가 없거나 다른 값이면 `400 INVALID_INPUT` 이다.

응답 200 (풀 수 있을 때):

```json
{ "format": "tar.gz", "entryCount": 1234, "unpackedBytes": 5242880, "packedBytes": 1048576,
  "singleTopFolder": "bundle", "targetName": "bundle (2)", "refusal": null }
```

- `singleTopFolder`: 모든 엔트리가 최상위 폴더 하나 아래에 있으면 그 이름이고, 아니면 `null` 이다.
- `targetName`:
  - `smart` 이면 지금 만들 폴더 이름이다. `singleTopFolder` 가 있으면 그 이름, 없으면 확장자를 뺀 아카이브 이름이다. 그 이름이 이미 있으면 FR-FOP-004 이름(`이름 (2)`)이 된다.
  - `here` 이면 아카이브가 있는 폴더의 이름이다.
- `unpackedBytes` 는 파일 엔트리가 선언한 크기의 합이다. FR-FEX-027 AC-5 의 확인 바 기준(1 GiB, 1만 개)은 `unpackedBytes` 와 `entryCount` 로 판단한다.

응답 200 (풀 수 없을 때): `{ "refusal": { "code": "ARCHIVE_TOO_LARGE" | "ARCHIVE_UNSUPPORTED" | "ARCHIVE_CORRUPT", "reason": "..." } }`

- 이 경우 다른 필드는 없다.
- `reason` 은 경로를 담지 않은 영어 문장이다. 예: `the archive is encrypted`, `split (multi-disk) ZIP archives are not supported`, `the unpacked size is more than 1000 times the archive size (compression ratio)`

### 4.2 작업 시작 — `POST /api/file-jobs` (JWT)

```json
{ "operation": "extract", "sourceSessionId": "…", "sources": ["/abs/uploads/bundle.tar.gz"], "mode": "smart", "destPath": "/abs/uploads" }
```

- `sources` 는 절대 경로 하나다. 둘 이상이면 `400` 이다.
- `mode` 는 필수다(`smart` | `here`).
- `destPath` 는 선택이고, 없으면 아카이브가 있는 폴더다.
- 지원하지 않는 확장자는 `415 ARCHIVE_UNSUPPORTED` 이다.
- 응답은 `202 { jobId }` 이다.

동작:

- **사전 계산:** 작업은 먼저 4.1 과 같은 사전 계산을 한다. 그동안 진행 이벤트의 `phase` 는 `scanning` 이고, `totalEntries` 가 늘어난다.
- **거부 조건:** 사전 계산에서 아래 중 하나라도 걸리면 아무것도 쓰지 않고 `failed` 로 끝난다.
  - 엔트리 수가 `fileManager.maxExtractEntries`(기본 100000)를 넘는다.
  - 풀린 크기가 `fileManager.maxExtractBytes`(기본 10 GiB)를 넘는다.
  - 압축 비율이 1000 을 넘는다.
  - 암호화되었거나, 분할(multi-disk)되었거나, 지원하지 않는 압축 방식의 ZIP 이다.
  - 아카이브가 손상되었다.
- **smart:** 새 폴더 하나를 만들고 그 안에 푼다. 폴더 이름은 4.1 의 `targetName` 규칙과 같다. 최상위 폴더가 하나뿐이면 그 폴더가 곧 새 폴더이고, 이중으로 중첩하지 않는다. 기존 폴더는 바꾸지 않는다.
  - 같은 아카이브 안에서 이름이 겹친 엔트리는 건너뛰고 `skipped` 에 적는다.
- **here:** `destPath` 에 바로 푼다. 이미 있는 이름이면 copy 와 같은 결정 이벤트를 보낸다.
  - 파일끼리 겹치면 선택지는 `overwrite` · `rename` · `skip` 이다.
  - 파일과 폴더가 만나거나, 그 이름이 링크면 선택지는 `rename` · `skip` 이다. 링크를 따라가 쓰지 않는다.
  - 폴더끼리 겹치면 묻지 않고 합친다.
  - `applyToAll` 은 copy 와 같게 동작한다.
- **쓰기:** 파일 엔트리는 같은 폴더의 숨김 임시 파일(`.bgupload-<hex>.part`)에 쓴다.
  - 다 쓴 뒤에만 그 이름에 놓는다. 덮어쓰기가 아니면 배타적으로 놓는다(하드 링크, 지원하지 않으면 `COPYFILE_EXCL` 복사).
  - 임시 파일은 업로드와 같이 `server/data/upload-temp.json` 에 기록하고, 서버를 시작할 때 지운다.
  - 파일과 폴더의 수정 시각을 아카이브 값으로 되돌린다. here 로 풀 때 대상 폴더 자신의 시각은 바꾸지 않는다.
- **선언 크기 초과:** 엔트리가 선언한 크기보다 많은 바이트를 내면, 그 엔트리의 임시 파일을 지우고 작업은 `ARCHIVE_TOO_LARGE` 로 실패한다. 이미 놓은 엔트리는 남는다.
- **읽기 오류:** 쓰는 도중 압축 해제나 아카이브 읽기가 실패하면, 그 엔트리의 임시 파일을 지우고 `ARCHIVE_CORRUPT` 로 실패한다.
- **취소:** 쓰던 엔트리의 임시 파일만 지운다. 이미 놓은 엔트리는 남긴다(FR-FOP-005).

### 4.3 완료 이벤트 — `file-job:done` 의 추가 필드 (extract 만)

```json
{ "jobId": "…", "outcome": "completed", "processedEntries": 12, "affectedDirectories": ["/abs/uploads"],
  "createdPaths": ["/abs/uploads/bundle (2)"],
  "skipped": [{ "path": "../evil.txt", "reason": "entry path leaves the target folder" }],
  "errorCode": "ARCHIVE_TOO_LARGE", "errorReason": "…" }
```

- `createdPaths`: smart 는 만든 폴더 하나이고, here 는 처음 놓은(또는 처음 들어간) 최상위 항목 하나다. 아무것도 놓지 않았으면 빈 배열이다.
- `skipped`: 쓰지 않은 엔트리의 이름(아카이브에 적힌 그대로)과 이유다. 사용자가 결정 이벤트에서 고른 건너뛰기는 여기에 넣지 않는다. 이유 문장은 다음 중 하나다.
  - `entry path leaves the target folder`
  - `entry path is absolute`
  - `entry name is not allowed`(NUL, Windows 예약 이름, `:`, 끝의 점·공백)
  - `links are not extracted`(심볼릭 링크, 하드 링크)
  - `device and pipe entries are not extracted`
  - `path is blocked`(차단 경로, 차단 확장자)
  - `another entry already has this name`
  - `a file and a folder of this name meet`
- `errorCode`·`errorReason`: 실패했을 때만 있다. `errorReason` 은 아카이브 거부일 때만 있으며, 4.1 의 `reason` 과 같은 문장이다.
