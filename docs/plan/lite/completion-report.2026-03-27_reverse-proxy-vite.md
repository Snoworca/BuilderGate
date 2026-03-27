# 완료 보고서

## 1. 요약
| 항목 | 값 |
|------|-----|
| 프로젝트 | BuilderGate |
| 계획 문서 | plan.2026-03-27_reverse-proxy-vite.md |
| 총 Phase 수 | 3 |
| 완료된 Phase | 3 |
| 총 개선 반복 횟수 | 1 (CSP 완화, HMR clientPort 추가) |
| 빌드 검증 | `tsc --noEmit` 통과 |

## 2. 테스트 결과
| 항목 | 결과 |
|------|------|
| 빌드 성공 | ✅ `tsc --noEmit` 에러 없음 |
| ECONNABORTED 에러 | ✅ **0건** (서버 로그에서 확인) |
| React 앱 로드 (4242) | ✅ Playwright로 https://localhost:4242 접속, title="BuilderGate" |
| API 라우트 직접 처리 | ✅ `/health`, `/api/auth/login` — Express에서 직접 처리 확인 |
| WebSocket 직접 연결 | ✅ `[WS] Connected` — 프록시 없이 WsRouter가 직접 처리 |
| PTY 입출력 | ✅ `echo PROXY_TEST_OK` → 출력 수신 확인 (node ws 클라이언트) |
| 터미널 재시작 | ✅ 재시작 API 200 응답, PowerShell 프롬프트 정상 표시 |
| Vite HMR | ✅ CSP 에러 해소, `wss://localhost:4242/__vite_hmr` 경로로 연결 |
| CSP 인라인 스크립트 | ✅ 개발 환경에서 `unsafe-inline` 허용으로 Vite 정상 동작 |

## 3. 변경 파일 목록
| 파일 | 변경 내용 |
|------|-----------|
| server/src/ws/WsRouter.ts | `import https` 제거, `authService` 인스턴스 변수화, `public handleUpgrade()` 메서드 노출, 생성자에서 `server` 파라미터 제거 |
| server/src/index.ts | `http-proxy` import, 개발환경 Vite 프록시 생성, fallback 미들웨어, upgrade 분기 핸들러, WsRouter 생성자 호출 변경, 개발환경 CSP 완화 |
| frontend/vite.config.ts | `/api`, `/ws` 프록시 제거, HMR path/clientPort/protocol 설정 |
| frontend/src/contexts/WebSocketContext.tsx | getWsUrl() 주석 업데이트 |
| server/package.json | `http-proxy` + `@types/http-proxy` 의존성 추가 |
| dev.js | `Open https://localhost:4242` 안내 메시지 추가 |

## 4. 계획 대비 추가 변경사항
계획에 없었지만 테스트 과정에서 발견되어 추가한 항목:

1. **CSP 완화 (개발 환경)**: 백엔드가 Vite를 프록시하면 helmet의 CSP 헤더가 Vite 인라인 스크립트와 HMR WebSocket을 차단함. `scriptSrc: "'unsafe-inline'"`, `connectSrc: "wss:", "ws:"`, `workerSrc: "blob:"` 추가
2. **HMR clientPort/protocol**: Vite HMR 클라이언트가 `wss://localhost:4545`로 직접 연결을 시도하므로, `clientPort: 4242`, `protocol: 'wss'` 설정 추가

## 5. 기존 버그 (이번 변경과 무관)
- Workspace 생성 직후 `workspaces/null/tabs` 에러: 프론트엔드 상태에서 워크스페이스 ID가 즉시 반영되지 않는 기존 이슈. 페이지 새로고침 후 정상 동작

## 6. Phase별 평가 점수
| Phase | 제목 | 최종 점수 | 반복 횟수 |
|-------|------|-----------|-----------|
| 1-3 통합 | 역방향 프록시 전환 | 90점 | 1회 |

> 이 점수는 lite 기준(90점/4기준/2인)이며, plan-driven-coder-v2 기준(95점/7기준/4인)과 직접 비교할 수 없습니다.
