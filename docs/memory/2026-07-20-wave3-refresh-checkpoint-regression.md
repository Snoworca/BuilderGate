# Wave 3 새로고침 checkpoint 회귀 수정 기록

## 범위

- Requirement: `MIG-BGSTAB-002` AC-4
- 문제: no-cache hard reload 중 legacy screen snapshot 본문이 checkpoint와 다른 쓰기 경로로 재생되어, checkpoint가 복원한 alternate buffer를 뒤늦게 덮을 수 있었다.

## 수정

- `TerminalView`의 authoritative snapshot 본문을 `TerminalWriteCoordinator.submitCompatibility({ type: 'write', kind: 'repair' })`로 전송했다.
  - checkpoint가 이미 시작됐으면 legacy reset/body를 거부한다.
  - legacy body가 먼저 시작됐다면 같은 physical deque에서 완료된 뒤 checkpoint reset/body/parser-tail이 마지막에 적용된다.
- checkpoint transaction/lifecycle 중 stale snapshot의 `set-windows-pty` mutation을 `checkpoint-authority-conflict`로 거부했다.
- `TerminalContainer`는 snapshot/resync 성공 이후에만 Windows PTY metadata를 적용한다. reject, checkpoint supersede, rollback defer 경로는 적용 전에 종료된다.
- 대형 소스 파일 길이에 의존하던 static contract 검사는 실제 control-flow boundary를 기준으로 조정했다.

## 검증 증거

- 실패 테스트 후 구현:
  - checkpoint authority 뒤 stale Windows PTY metadata 거부
  - legacy reset/body 뒤 checkpoint가 final physical mutation이 되는 하나의 deque 순서
  - snapshot 성공 이전 Windows PTY metadata 미적용
- frontend focused contracts: 218/218 통과
- `npm run typecheck`: 통과
- `npm run build`: 통과, production asset stage 완료
- HTTPS Playwright: `poisoned no-cache reload` 1/1 통과 (약 2분 33초)
- 독립 코드 리뷰: Critical/High/Medium/Low `No findings`

## 상태

이 기록은 `MIG-BGSTAB-002` 전체 완료가 아니라 AC-4 hard reload retained-state 복구 회귀의 완료 증거다. 같은 requirement의 promotion, responder handoff, rollback 및 AI TUI 불변 조건은 별도로 계속 추적한다.
