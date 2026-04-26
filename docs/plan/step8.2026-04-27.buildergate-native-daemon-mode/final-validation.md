# BuilderGate 네이티브 기본 데몬 모드 최종 검증 템플릿

## Traceability Gate

| 항목 | 목표 | 결과 |
| --- | --- | --- |
| FR-8-001부터 FR-8-017 | 100% Phase 매핑 | 대기 |
| AC-8-001부터 AC-8-020 | 100% test/scenario 매핑 | 대기 |
| TEST-8-001부터 TEST-8-023 | 100% 실행 또는 명시적 사유 기록 | 대기 |
| NFR-8-001부터 NFR-8-012 | 100% architecture/phase 반영 | 대기 |
| IR-8-001부터 IR-8-003 | 100% command/API response contract 반영 | 대기 |
| DR-8-001부터 DR-8-003 | 100% data/env contract 반영 | 대기 |
| CON-8-001부터 CON-8-009 | 100% 제약 반영 | 대기 |

## Quality Gate

| 게이트 | 목표 | 결과 |
| --- | --- | --- |
| Unit tests | 관련 테스트 100% 통과 | 대기 |
| Integration tests | daemon/foreground/stop/readiness/TOTP/sentinel 통과 | 대기 |
| Build tests | `dist/bin` output, PM2 absence, bundled Node 통과 | 대기 |
| Docs tests | required keywords 포함, PM2 forbidden pattern 0개 | 대기 |
| Review loop | 각 Phase 코드 리뷰 `No findings` | 대기 |

## Final Manual Validation

```powershell
node tools/start-runtime.js -p 2002
curl -k https://localhost:2002/health
node stop.js
curl -k https://localhost:2002/health
npm run build:daemon-exe
```

## 완료 조건

- [ ] 기본 실행이 daemon이다.
- [ ] `--foreground`와 `--forground`만 foreground다.
- [ ] PM2 호출/설치/dependency/docs 안내가 없다.
- [ ] TOTP daemon QR은 parent detach 전에 출력되고 child duplicate QR은 없다.
- [ ] native stop은 foreground를 종료하지 않고 valid daemon만 graceful shutdown한다.
- [ ] strict config failure가 default fallback으로 숨겨지지 않는다.
- [ ] `dist/bin` 산출물과 EXE 옆 config 정책이 유지된다.
- [ ] orphan app/sentinel process가 없다.
