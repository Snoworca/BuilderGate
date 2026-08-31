# T-PH003-03 Remount adapter·HTTPS RED 계약 보고

- Requirement: `REL-BGSTAB-009`
- Task: `T-PH003-03`
- 판정: 의도된 RED 계약 확립 완료
- production code 변경: 없음
- 독립 최종 재리뷰: `No findings`

## 결과

Wave 2의 다음 GREEN 구현이 임의의 국소 수정으로 빠져나가지 못하도록 14개 계약을 고정했다.

- TerminalView·TerminalContainer의 6개 단위 RED는 `createTerminalViewRestoreAdapter`와 `createTerminalContainerRestoreAdapter` production seam을 실제 호출하도록 작성했다. bound scope/identity, public event, remount/stale callback, coordinator command, terminal write 순서와 cleanup을 검증하므로 빈 export나 이름만 있는 함수로는 통과할 수 없다.
- HTTPS E2E 2개는 `https://localhost:2222`의 실제 WebSocket을 거쳐 같은 세션의 재연결 generation, old/current repair·replay token, timer/listener/transaction ownership을 검증한다.
- WsRouter RED는 fake/stub 없이 실제 로그인, 임시 PowerShell 세션, 실제 `ws` client 2개와 PTY 출력을 사용한다. replay barrier와 repair barrier 뒤의 출력 및 normal output을 비교하고, 모든 실행에서 WebSocket을 닫고 세션 DELETE `204`를 확인한다.
- SessionManager RED는 atomic authority revision, pending write bounded rejection, split CSI/OSC/DCS/ST/CAN/SUB parser tail, pending tail의 exact snapshot sequence 결합을 고정한다.
- send-policy RED는 coalescing이 snapshot sequence를 가로지를 때 UTF-8 source segment offset과 chunk identity를 잃지 않아야 한다는 계약을 고정한다.

## RED 증거

- server dedicated: 6개 실행, 6개 고유 semantic failure, todo/skip/infra failure 0
- frontend unit: 58개 중 기존 52개 PASS, 계획된 adapter RED 6개만 FAIL
- Desktop Chrome HTTPS E2E: 2개 실행, 2개 계획 semantic failure, infra failure 0
- sidecar test case: 14/14 symbol·REQ·AC 매핑 일치

현재 RED는 결함을 숨기는 실패가 아니다. server는 sequence/token/segment/parser authority가 아직 없어서 실패하고, frontend는 production adapter seam과 generation/ownership debug metadata가 아직 없어서 실패한다. 이 계약들은 후속 `T-PH003-04` GREEN의 구현 경계다.

## 회귀·품질 검증

- server `npm run build`: PASS
- server `npm test`: PASS
- frontend 기존 recovery/scheduler baseline: 44/44 PASS
- frontend `npm run typecheck`: PASS
- task-scoped ESLint: 0 errors, 0 warnings
- scoped `git diff --check`: PASS
- server lint: 구성된 script/config가 없어 N/A
- 임시 `Wave2 restore metadata RED*` 세션 잔여: 0

독립 까칠 리뷰는 세 차례 수행했다. 초기 fake/stub·regex-only·고정 sleep·무한 pending 문제를 제거했고, 2차에서 symbol-existence-only adapter RED, 입력 cap, E2E token 상관관계 문제를 다시 발견해 수정했다. 같은 리뷰어의 최종 S1~S4 판정은 `No findings`다.

파일별 SHA-256과 명령별 상세 결과는 `red-evidence.json`, 리뷰 이력은 `tdd-review.json`에 기록했다.

Verification: Tier 2 automated checks and sub-agent review completed.
