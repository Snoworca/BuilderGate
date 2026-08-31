# T-PH004-03 Keyboard·context·native adapter RED 증거

FR-BGSTAB-021의 browser adapter 계약을 실제 HTTPS/PTY/WebSocket 경로에서 먼저 RED로 고정했다.

- strict 8-case 직렬 실행: 3 통과, 계획된 의미 실패 5, 인프라 실패 0
- 전체 26-case 직렬 진단: 12 통과, mobile-only 5 skip, 9 실패
- 전체 진단의 9 실패는 coordinator 미통합 5건과 좁은 PowerShell prompt test parser 4건으로 분리했다.
- 각 테스트는 전용 workspace/session을 만들고 성공·실패 경로 모두에서 삭제를 보장한다.
- 대상 session frame을 재조립해 exact payload equality를 검사하고, late-read 구간은 input frame 0개를 요구한다.
- clipboard payload는 debug event 전체 JSON 직렬화에 나타나지 않아야 한다.

GREEN 통합 뒤 같은 strict 범위는 8/8, 전체 범위는 21 pass/5 mobile-only skip/0 fail이다. 최초 reviewer finding 5건과 재리뷰 finding 3건, prompt 후보 최신성 finding 1건을 모두 반영했으며 최종 판정은 `No findings`다.
