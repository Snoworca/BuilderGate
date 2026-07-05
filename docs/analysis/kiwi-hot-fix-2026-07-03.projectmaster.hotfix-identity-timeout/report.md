---
run_id: 2026-07-03.projectmaster.hotfix-identity-timeout
mode: normal
input_source: natural-language
fix_files: [server/src/types/config.types.ts, server/src/schemas/config.schema.ts, server/src/utils/processTreeTerminator.ts, server/src/types/ws-protocol.ts, server/src/services/SessionManager.ts, server/src/test-runner.ts]
regression_pass: true
review_iter: 1
sync_delegated: true
sync_run_id: 2026-07-03.projectmaster.bgstab.sync-0630
---

## kiwi-hot-fix 완료 보고

### 1. 플래그 / 비용
Normal 모드. 추가 플래그 없음.

### 2. 입력 요약
자연어 증상 + 실측 재현 문서(`docs/analysis/kiwi-planner-2026-07-03.projectmaster.p0-native-perf/soak-attempt-2026-07-03.md`) — FR-BGSTAB-019 soak 시도 중 발견된 버그.

### 3. Root cause
1초 타임아웃(`readProcessStartIdentity`, PowerShell/Get-CimInstance) + 재시도 전무(`scheduleProcessStartIdentityCapture`) + 오류 원인 불문 null 뭉개기 → 부하 상황에서 osStartIdentity가 영구 null로 남아 enforce의 taskkill 자체가 스킵됨(`processTreeTerminator.ts:421`). 실측: Start-Process 분리 손자 프로세스(cmd.exe+ping.exe)가 세션 삭제 후에도 생존, `skipped-unverified` 텔레메트리 확인.

### 4. 회귀 테스트 (TDD)
신규: `testSessionManagerRetriesAsyncStartIdentityCaptureAfterTransientFailure` — 첫 호출 null, 두 번째 성공 시뮬레이션. **RED 확인**: "expected at least 2 identity probe attempts, saw 1" (재시도 없는 기존 코드에서 결정적 실패).

### 5. 적용된 fix
- `readProcessStartIdentity`: 하드코딩 `timeout:1000` → 주입 가능 `timeoutMs`(기본 3000)
- `session.processCleanup.identityProbeTimeoutMs`: 신규 config 필드(zod, int, min100/max60000, default3000) — 기존 gracefulWaitMs/forceWaitMs 형제 패턴 준수
- `scheduleProcessStartIdentityCapture` → `attemptProcessStartIdentityCapture`+`handleProcessStartIdentityResult` 재작성: 최대 3회 재시도(backoff 200/400ms), 매 시도 전 `current!==data||finalized` 가드 재검사, 재시도 타이머는 `finalizeSession`에서 clearTimeout
- `SessionCleanupTelemetry`: `identityCaptureSucceeded/Retried/Failed` 카운터 3종 추가
- 기존 테스트 2개 갱신(타임아웃 값 1000→3000, reject 시나리오를 재시도 소진 시나리오로)

### 6. 정형 검사 + 까칠 리뷰
- 정형 검사(Sonnet, F1~F4): CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 5(전부 기존 컨벤션 준수, 조치 불요)
- 까칠 리뷰(Opus, P1~P7): **CRITICAL 0 / HIGH 0** → 게이트 통과. P2(타이머 누수) 특별 검증 결과 **CLEAN**(finalizeSession clearTimeout 확인, 세션 재사용 race도 객체 아이덴티티 비교로 방어됨).
- **잔존 MEDIUM 4건(정보성, 차단 아님)**:
  - P1: 재시도 소진 시에도 여전히 skipped-unverified로 귀결 — "신원 미확보 시 kill 스킵" 정책 자체는 불변
  - P2: 즉시-삭제 race는 재시도로도 무력화됨(재시도 여유 시간 전에 삭제되면 동일하게 leak)
  - P4: 재시도가 부하 상황에서 CIM/PowerShell 부하를 최대 3배로 증폭
  - P6: 정상 종료 프로세스와 진짜 실패가 `identityCaptureFailed` 카운터에서 혼동됨

### 7. 회귀 테스트 실행 결과
전체 서버 스위트 **315/315 PASS**(기준선 314 + 신규 1), `tsc --noEmit` 0 errors. 독립 재실행으로 재확인 완료.

### 8. kiwi-srs-sync 위임 결과
run_id: `2026-07-03.projectmaster.bgstab.sync-0630`. 6개 CU 전부 **update → PERF-BGSTAB-002**로 분류(평가자 CRITICAL 0/HIGH 0 양쪽 통과). PERF-BGSTAB-002에 Implementation Notes 3건 + trace 6건 + evidence 1건, FR-BGSTAB-019에 선행조건/잔존한계/미결정책질문 note 3건(AC/Status 불변), FR-BGSTAB-009에 교차참조 note 1건(AC/Status/Stability 불변). **주의**: 당초 계획한 "신규 AC 추가"는 speckiwi의 구조화 테이블 보호로 거부되어 Implementation Notes 기록으로 전환(정보 손실 없음). `validate_spec` 최종 PASS.

### 9. 잔존 finding (사후 검토 권고)
- 재시도 소진/즉시삭제 race의 근본 해소는 이번 fix 범위 밖 — enforce 모드에서 미검증 시 PID-tree fallback kill 허용 여부는 별도 정식 SRS 결정 필요(FR-BGSTAB-019 Implementation Notes에 미결 질문으로 기록됨)
- `identityProbeTimeoutMs`의 config-override 경로(비기본값 주입) 전용 테스트 부재(sync 평가자 MEDIUM)
- 세션 삭제 시 진행 중 신원조회 프로세스(powershell.exe)는 취소 불가 — 타임아웃 상향으로 orphaned probe 잔존 시간이 늘어남(LOW)

### 10. 메타
run-id: 2026-07-03.projectmaster.hotfix-identity-timeout / 코드 변경 6파일 / 리뷰 1 iter / 전체 315/315 PASS / sync 위임 완료. 커밋은 별도 단계(사용자 결정).
