# T-PH002-05 Phase 리뷰 지적 수정 보고

## 결과

`REL-BGSTAB-008`의 AC-2, AC-4, AC-6, AC-7, AC-10에 걸친 Phase 리뷰 지적을 TDD로 수정했다. 이전 recovery suffix가 새 visible resync에 섞이는 safe-send 경합을 차단하고, snapshot에 이미 포함된 late chunk가 큐 상한을 거짓 초과하는 문제를 제거했다.

## 수정 내용

### 1. recovery output identity와 정확한 supersession

- 모든 정상 output frame은 서버 세션별 단조 증가 `chunkId`와 실제 `screenSeq`를 전달한다.
- fresh snapshot recovery suffix만 해당 `replayToken`을 함께 전달한다.
- direct screen-repair suffix의 `repairToken`은 WebSocket payload에 노출하지 않고 safe-send transport metadata에만 보존한다.
- 큐 취소는 동일 session의 정확한 superseded `replayToken` 또는 `repairToken` frame만 제거한다.
- normal live output, 현재 recovery token, 다른 session output은 보존한다.
- recovery 또는 서로 다른 sequence output은 coalesce하지 않는다. 동일하거나 sequence가 없는 normal output은 기존 coalesce 성능 경로를 유지한다.
- 세션을 제거할 때 session-local output ordinal 상태도 함께 해제한다.

### 2. 프런트 output admission

- active resync에서 recovery output은 현재 `replayToken`과 stable `chunkId`가 모두 일치해야 한다.
- tokenless output은 ready 전에는 유효한 `screenSeq + chunkId`가 모두 있어 snapshot coverage를 판정할 수 있을 때만 normal live로 수용한다.
- sequence가 없는 degraded/legacy tokenless output은 정확한 matching replay ready가 latch된 뒤에만 수용한다.
- production `TerminalContainer.onOutput`가 이 분류기를 직접 사용하도록 연결해 helper-only 공백을 없앴다.

### 3. covered late chunk 경계

- duplicate `chunkId`는 최초 admission 시점에 기록한다.
- accepted snapshot의 `screenSeq` 이하인 late chunk는 byte/chunk accounting과 overflow 판정 전에 제거한다.
- 큐가 정확히 N byte/N chunk일 때 covered N+1이 들어와도 기존 uncovered tail을 해제하거나 terminal failure로 전이하지 않는다.

## TDD 증거

- 서버 RED: exact recovery predicate 부재 및 old replay tail 잔존.
- 서버 RED: exact direct-repair predicate 부재 및 old direct repair tail 잔존.
- 서버 RED: session ordinal map이 `clearSessionState` 뒤에도 남음.
- 프런트 RED: cap 경계의 covered late chunk가 기존 held tail을 보존하지 못함.
- GREEN 증거는 [fix-evidence.json](./fix-evidence.json)에 정리했다.

## 자동 검증

- server full `npm test`: exit 0
- server screen-repair: 24/24 pass
- server supersession: 3/3 pass
- split characterization: 8 pass, 0 fail, 기존 TODO 13
- frontend visible/container unit: 34/34 pass
- frontend 전체 unit: 278/278 pass
- frontend typecheck/build: pass
- task-scoped ESLint: 0 finding
- Playwright AC-4/AC-8: 2/2 pass
- `git diff --check`: pass

Playwright 최초 실행의 AC-4 실패는 새 recovery protocol에 필요한 `chunkId`를 fault fixture가 누락한 것이 원인이었다. production이 해당 frame을 stale로 거부한 것은 의도된 동작이므로 fixture에 안정적인 covered/tail chunk identity를 추가했고 같은 E2E가 통과했다.

## 리뷰

동일 독립 Phase reviewer가 수정분을 재검토했고 최종 verdict는 정확히 `No findings`였다.

Verification: Tier 2 automated checks and sub-agent review completed.
