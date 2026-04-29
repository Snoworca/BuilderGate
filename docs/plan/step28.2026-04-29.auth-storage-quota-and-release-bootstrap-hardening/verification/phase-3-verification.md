---
title: Phase 3 Verification
date: 2026-04-29
type: verification
---

# Phase 3 Verification

## 자동 테스트

```powershell
node --test tools/daemon/build-daemon-exe.test.js
npm run test:docs
git diff --check
```

## Artifact 검사

각 target 산출물에서 다음을 확인한다.

| 항목 | 기대값 |
|---|---|
| root `config.json5` | 존재 |
| `auth.password` | `""` |
| `auth.jwtSecret` | `""` |
| `server/config.json5` | 부재 |
| macOS app runtime `config.json5` | bootstrap-safe |

## 필수 케이스

| ID | Given | When | Then |
|---|---|---|
| TC-028-3A | source `server/config.json5`에 non-empty password | release profile build | output `config.json5`는 empty password |
| TC-028-3B | explicit include user config option | local build | source config 복사 허용 |
| TC-028-3C | artifact에 non-empty password | release workflow inspection | job 실패 |

## 2026-04-29 실행 결과

- `node --test tools/daemon/build-daemon-exe.test.js`: 통합 daemon test bundle 안에서 통과
- `.github/workflows/release.yml`에 artifact upload 전 bootstrap-safe config inspection step 추가
- `node tools/build-daemon-exe.js --profile win-amd64 --skip-runtime-install`: 통과, output `config.json5`는 `auth.password: ""`, `auth.jwtSecret: ""`
