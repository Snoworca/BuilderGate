# T-PH004-04 Clipboard GREEN 통합 보고

FR-BGSTAB-021의 programmatic clipboard owner를 TerminalView coordinator 하나로 통합했다.

- 선택된 Ctrl+C, tab context, Grid context, 등록 프리셋이 같은 coordinator admission을 사용한다.
- 미선택 Ctrl+C는 xterm의 SIGINT 경로를 유지한다.
- native Ctrl+V는 xterm textarea paste event 소유권을 유지해 중복 입력을 막는다.
- 비동기 clipboard read 중 session/view 교체가 발생하면 payload 없이 `context-changed`로 거절한다.
- copy write 실패는 selection을 지우지 않으며 성공한 현재 target만 focus한다.
- programmatic paste는 기존 input barrier, outbox, multiline, debug redaction을 재사용한다.

검증은 unit 22/22, strict HTTPS E2E 8/8, 전체 HTTPS E2E 21 pass/5 mobile-only skip/0 fail, typecheck/build 통과다. 전체 lint의 기존 42 errors/18 warnings는 변경 범위 밖 baseline으로 분리했고 scoped lint error는 0이다. 독립 까칠한 reviewer의 최종 판정은 `No findings`다.
