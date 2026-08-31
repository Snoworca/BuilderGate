# Orca 터미널 개선 Wave 1 완료 보고

## 결론

Wave 1을 완료했다. BuilderGate의 문제가 단일 브라우저 렌더링 버그가 아니라 다음 세 계층의 구조적 불일치임을 실제 실행 증거로 확정했다.

1. production은 `unified`인데 일부 split 전용 test/SRS 기대가 분리되어 있다.
2. Browser-visible retained history와 server가 새로고침 뒤 복구할 수 있는 범위가 다르고, server snapshot에는 2 MiB 직렬화 경계가 있다.
3. terminal 성능 병목은 renderer 하나가 아니라 analyzer, output scheduling, slow-client pressure와 metric provenance를 분리해 측정해야 한다.

G1은 사용자의 명시적 지시에 따라 `architectural migration`을 선택했다. 다만 이 결정은 UI 변경, server authority 즉시 승격, product buffer/default 숫자 변경 또는 legacy 삭제를 승인하지 않는다.

## 완료 범위

| Phase | Requirement | 결과 | 최종 리뷰 |
| --- | --- | --- | --- |
| PH-001 | `REL-BGSTAB-006` | production unified, standalone split mismatch와 SRS drift를 raw artifact로 봉인 | `No findings` |
| PH-002 | `OBS-BGSTAB-004` | 실제 브라우저 새로고침 6경계, ordered loss 분석, server 2 MiB 경계, test workspace ownership guard | `No findings` |
| PH-003 | `PERF-BGSTAB-008` | actual-seam 1,224 raw sample, 408 summary group, exact SessionManager metric source | `No findings` |
| PH-004 | `MIG-BGSTAB-001` | exact two-value G1 gate, stable authority contract, closure-aware activation | `No findings` |

Wave 1의 25개 task는 모두 완료됐다.

## 핵심 증거

### Split drift

- Artifact: `docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/split-characterization.json`
- Canonical content digest: `d54487ef941f53c165dcc0c1878ea62e5cda1f5843fcca3c3e84294cd6999fda`
- Production `https://localhost:2222/ws`: runtime/wire 모두 `unified`
- Standalone split handshake: 16개 중 3개 통과, 13개 실패를 mismatch evidence로 보존
- 이 단계에서 split을 기본화하지 않았다.

### Refresh retained-state boundary

- Artifact: `docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/retained-state-characterization.json`
- Canonical content digest: `ebdd8e5296cadb047eb8ad2c46a0c91d630fe5ac0a9d0f31baf308530d969e1f`
- 실제 browser refresh matrix와 xterm public buffer capture 사용
- Ordered retained-range 분석으로 expected eviction과 range 내부 loss/reorder/change를 분리
- `serializeHeadlessTerminal()`의 2 MiB 직전/정확/초과 경계를 actual server seam에서 검증
- TC-7004 cleanup은 exact workspace ID, name, owner token이 모두 맞아야 삭제하도록 제한
- Raw terminal text는 artifact에 저장하지 않았다.

### Performance characterization

- Raw: `benchmark-raw-samples.json`, digest `d82398218a04418de9a3bbf6b38a124a5f05ceaa7aa2f008dc5dc625dbcdc146`
- Summary: `benchmark-summary.json`, digest `bb63c56be66e04b9ec05a2a72aa736ac4d3baa6b08820003686f23c4eeafa583`
- Raw sample 1,224건, summary 408그룹
- `NO_RENDER`, `NO_ANALYZER`, `NO_NETWORK`, `ONE_CLIENT_SLOW` 모드와 1/8/32/54 session × 1/2/8 client 조합
- Event-loop raw 480건은 모두 같은 `SessionManager.getObservabilitySnapshot().eventLoopDelay.mean/p99` source이며 benchmark 전용 대체 source는 0건
- Raw 순서를 역전해도 percentile/seeded CI 408/408이 canonical exact match

## G1 결정과 stable authority 계약

### 결정

- Decision: `architectural migration`
- Decision record: `docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline/g1-decision-record.json`
- SHA-256: `5a3d552a81a5f8ad7baa464ab3c008375b82f13e4496497974c8e44a5e7c0fc0`
- Gate test: 7/7 통과

첫 리뷰에서 T4 decision만으로 Wave 1을 완료·Wave 2를 활성화할 수 있는 조기 활성화 결함을 발견했다. Strict TDD로 다음 두 평가를 분리했다.

- `evaluateG1Decision()`: 결정 유효성만 판정하고 `pending-wave1-closure` / `eligible-after-wave1-closure`를 반환한다.
- `evaluateG1Activation()`: T-PH004-05=`No findings`, MIG=`implemented`, Wave 1=`completed` 외부 증거가 모두 있을 때만 Wave 2를 `eligible`로 반환한다.

Post-closure activation record의 SHA-256은 `57730e850560164234fb5624d76b5d2c090b686f5a1471f09c22f2b596a9226a`이다.

### Stable authority Requirement

SpecKiwi가 exact ID `REL-BGSTAB-007`을 할당했고 `Target=wave-3`, `Status=planned`, `Stability=stable`로 등록했다.

- 새 numeric 10,000 상수를 만들지 않는다.
- 기존 사용자 의미 설정 `resourceLimits.terminal.scrollbackLines`를 server/browser의 canonical policy source로 사용한다.
- `pty.scrollbackLines`는 canonical key가 없을 때만 observable legacy migration source가 된다.
- Retention policy와 checkpoint chunk/in-flight/socket/write-slice budget을 분리한다.
- 2 MiB transport 경계가 retained history를 empty success로 축소할 수 없다.
- Server-surviving refresh/reconnect/remount만 이 계약의 보장 범위다. Server restart, PTY 종료와 offline-only 복구는 별도 stable persistence 계약 전에는 보장하지 않는다.
- Local cache는 provisional이며 parity, rollback과 별도 deletion Requirement 전에는 물리 삭제하지 않는다.

## 검증

- Gate test: 7/7 PASS
- PH-002 unit/live/synthetic/ownership/server-boundary: 모두 PASS
- PH-003 server 14/14, frontend 16/16, typecheck/lint PASS
- SpecKiwi strict + fail-on-warning: error 0, warning 0
- SpecKiwi links: 162개 검사, broken 0
- Mandatory Phase reviews: PH-001~PH-004 모두 최종 `No findings`
- 관련 diff와 artifact JSON 구조를 재검사했다.

Verification: Tier 2 automated checks and sub-agent review completed.

## Wave 2 활성화

Wave 1 closure event와 post-closure activation re-evaluation을 완료했으며 Wave 2는 `in_progress`다. Active Target은 `wave-2`로 전환했다.

Wave 2 범위는 다음 네 가지 비파괴 correctness 작업이다.

1. 코드포인트별 `TextEncoder.encode()` 제거와 segmented UTF-8 scheduler
2. giant repair flush 제거와 explicit stale/resync
3. remount/restore buffer bounded화 및 snapshot → drain → ready barrier
4. `pasteInput` facade, copy promise와 clipboard exactly-once ownership

Wave 2에서는 기존 UI 시각 요소, server authority, product resource default와 legacy code를 변경하지 않는다.
