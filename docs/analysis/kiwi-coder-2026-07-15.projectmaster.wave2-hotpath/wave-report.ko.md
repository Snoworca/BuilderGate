# Wave 2 완료 보고서 — Terminal hot path 및 복구 안정화

- 실행 ID: `2026-07-15.projectmaster.wave2-hotpath`
- 대상: `wave-2`
- 계획: `docs/plans/2026-07-15.projectmaster.wave2-hotpath.plan.md`
- 관련 요구사항: `PERF-BGSTAB-009`, `REL-BGSTAB-008`, `REL-BGSTAB-009`, `FR-BGSTAB-021`
- 결과: 4개 Phase, 20개 Task 완료

## 완료 결과

Wave 2는 Orca의 얕고 분절된 출력 처리, 명시적 stale/resync, generation ownership 원칙을 BuilderGate의 현재 WebSocket·다중 client·server authority 범위에 맞게 흡수했다. Binary data plane, split activation, retained-state authority 이전은 아직 수행하지 않았으며 각각 후속 Wave 경계를 보존했다.

### PH-001 — Segmented UTF-8 scheduler

- 문자열 queue와 code-point별 반복 인코딩을 encoded `Uint8Array` segment·head offset 기반 deque로 교체했다.
- 한 ingress당 encoding 최대 1회, UTF-8 continuation boundary slice, bounded compaction, terminal별 단일 in-flight write와 callback ordering을 보존했다.
- PH-003 FIFO probe 통합 뒤 최종 production scheduler를 `wave2-integrated-segmented-byte-deque-v2`로 다시 고정했다.
- Canonical benchmark artifact content digest: `sha256:5f240e44e429b189f943cf2efe258601d8733efc15dfb50057bca68113950697`.

### PH-002 — Explicit screen-repair resync

- screen-repair overflow의 giant direct flush를 제거하고 affected client view만 stale로 전환하는 bounded fresh-snapshot transaction을 도입했다.
- snapshot-covered prefix는 retained queue byte/chunk cap을 소비하지 않으며 post-snapshot tail만 exactly-once 순서로 drain한다.
- `repairToken + replayToken + snapshotSeq` authority barrier, incomplete parser non-ready, timeout/reoverflow/reconnect-required와 redacted accounting을 적용했다.
- 7-bit ESC뿐 아니라 xterm이 해석하는 8-bit C1 CSI/OSC/DCS/SOS/PM/APC와 ST/CAN/SUB 분할까지 추적하여 incomplete parser snapshot의 조기 ready와 영구 non-ready를 모두 차단했다.
- Wave 2의 production unified 경로와 standalone split limitation은 유지했다. Split client-group routing 관련 14개 characterization은 Wave 3 TODO이며 현재 실행 실패가 아니다. Output socket 부재 시 control authority fallback은 정상 snapshot/ACK 뒤 non-TODO 회귀로 유지했다.

### PH-003 — Bounded remount restore

- live output, local/provisional restore, authoritative snapshot과 tail drain을 하나의 generation-safe coordinator로 직렬화했다.
- 동일 xterm FIFO completion probe, bounded timer/listener/input/output ownership, replacement connection/session/view/xterm generation fence를 적용했다.
- reload/remount 뒤 speculative mutation이 authoritative server snapshot보다 뒤에 쓰이지 않도록 mutation fence와 input barrier를 통합했다.
- Safe-send가 합친 normal output은 UTF-8 byte 경계의 `sourceSegments`로 원래 `screenSeq/chunkId`를 보존하며, 모든 segment를 선검증한 뒤에만 복구 큐에 원자적으로 승인한다.

### PH-004 — Generation-safe clipboard

- copy settlement와 programmatic paste를 하나의 target-aware coordinator로 통합했다.
- copy 성공 뒤 동일 selection·동일 generation일 때만 selection을 지우고, 실패·selection/target 변경에서는 보존한다.
- tab/Grid/registered preset paste는 one admission path를 사용하며 native Ctrl+V와 selection 없는 Ctrl+C SIGINT는 기존 xterm owner adapter 계약을 유지한다.
- clipboard 원문은 debug/telemetry에 남기지 않고 byte count·source·outcome만 기록한다.
- E2E는 test-owned clipboard workspace를 정리하고 tab/Grid view mode를 시작 상태로 복원한다.

## 최종 검증

| 구분 | 결과 |
| --- | --- |
| Server full build/test | PASS, exit 0 |
| Server strict repair 계약 | 5/5 PASS |
| Server restore metadata/C1/source segment | 15/15 PASS |
| Standalone split characterization | 7 PASS, 14 documented TODO, 0 fail |
| Frontend full unit | 339/339 PASS |
| NO_RENDER benchmark | 3/3 PASS, exact gates 및 canonical artifact 검증 |
| Frontend typecheck | PASS |
| Frontend production build/staging | PASS; 기존 Vite chunk-size warning만 존재 |
| HTTPS recovery/remount E2E | 4/4 PASS (`https://localhost:2222`) |
| HTTPS clipboard strict E2E | 9/9 PASS |
| HTTPS clipboard full E2E | 22 PASS, 5 mobile-only skip, 0 fail |
| Registered preset E2E 최종 재실행 | 14 PASS, 5 mobile-only skip, 0 fail |
| Wave task-scoped ESLint | 0 errors, 0 warnings |

Repository 전체 lint는 Wave 시작 전부터 존재한 `42 errors / 18 warnings` 기준선 때문에 실패한다. `WebSocketContext`의 기존 `set-state-in-effect` 1건과 fast-refresh 3건은 이전 task evidence에서 baseline으로 독립 확인했으며, Wave 최종 gate는 변경된 terminal hot-path·복구·clipboard 구현과 해당 test 파일로 범위를 고정해 0 errors / 0 warnings를 확인했다.

## 최종 회귀에서 추가로 잡은 문제

1. Fresh snapshot으로 덮인 prefix가 cap 검사보다 늦게 분류되어 false reoverflow하던 문제를 수정했다. Near-cap retained tail + 큰 covered prefix 회귀가 과거 구현에서 실패하고 현재 통과한다.
2. PH-003 뒤 scheduler source가 바뀌었는데 PH-001 benchmark digest가 남아 있던 provenance 불일치를 최종 통합 후보로 재기록했다.
3. HTTPS AC-4 test의 합성 `session:ready`에 `snapshotSeq`가 빠진 오류를 고쳐 production exact identity와 일치시켰다.
4. Reconnect 뒤 늦은 snapshot 검증을 old routed generation에 묶어, failed runtime 폐기 또는 replacement generation fence와 함께 ACK 0·화면 mutation 0을 검증한다.
5. Clipboard/preset E2E가 persistent Grid mode를 다음 test/user state에 누수하지 않도록 초기 view mode를 보존·복원한다.
6. `TerminalHandle`/runtime proxy에 남아 있던 dormant `pasteInput` 우회 경로를 제거하고 모든 programmatic paste를 generation-aware coordinator로 단일화했다.
7. Grid에서 지연된 clipboard read 중 active pane이 바뀌어도 old target이 유효하던 race를 primary pointerdown synchronous fence와 context generation으로 차단했다. 이전·새 pane 입력 0과 observable `context-changed` 거부를 HTTPS E2E로 검증했다.
8. `screen-snapshot` wire에 동일 payload를 `data`와 `serializedData`로 중복 전송하던 경로를 제거하고 단일 payload 계약을 initial/refresh 회귀로 고정했다.
9. Normal output의 identity 때문에 safe-send coalescing이 사실상 꺼지던 문제를 `sourceSegments`로 해결했다. Unicode byte offset, split surrogate non-coalescing, 전체 segment 선승인으로 identity loss·invalid boundary·부분 복구를 막았다.
10. Partial escape tracker가 8-bit C1 control을 complete로 오판하던 화면 깨짐 경로를 수정했다. C1 ST가 CSI/ESC-intermediate를 포함한 모든 non-ground 상태를 abort하는 xterm parity도 completion 단독 authority assertion으로 고정했다.
11. Wave 2 plan/sidecar/PM hash와 worklog drift를 공식 workflow repair로 정리했다. 최종 doctor는 current artifact drift 0이며, 남은 진단은 2026-05-22 legacy pipeline schema warning 4건뿐이다.

## 리뷰와 범위 판정

- 각 Phase는 계획에 지정된 `구현 → 테스트 → 까칠한 리뷰 → 수정 → 재리뷰`를 수행했고 최종 `No findings`를 받았다.
- Snapshot-covered cap 회귀, benchmark provenance, HTTPS generation fence와 view-mode 격리도 별도 독립 재리뷰에서 `No findings`를 받았다.
- 모든 Phase 뒤 최종 통합 reviewer가 full unit/server focused/E2E/SRS/workflow evidence를 독립 재실행·대조했고 최종 판정은 정확히 `No findings`였다.
- UI 시각·label·layout, 설정 default, native Ctrl+V owner, server retained-state authority 및 split activation은 변경하지 않았다.
- TUI 사용자 입력이 session을 `running`으로 바꾸는 경로를 추가하지 않았다.

## Wave 3 인계

Wave 3는 현재 TODO로 남긴 split client-group routing과 control/output 물리 분리, fair per-session scheduler, Settings-backed queue policy를 다룬다. Wave 2에서 임시 split 구현이나 binary protocol을 끼워 넣지 않았으므로, Wave 3는 현재 unified authority와 regression corpus를 기준으로 strict TDD를 시작할 수 있다.

Verification: Tier 2 automated checks and sub-agent review completed.
