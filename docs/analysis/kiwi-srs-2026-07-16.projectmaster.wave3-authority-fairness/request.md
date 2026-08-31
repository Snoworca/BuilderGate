# Wave 3 SRS 요청

- Target: `wave-3`
- Scope: `BGSTAB`
- Source: GitHub `#8`~`#14`, Orca terminal absorption research, Wave 1 G1 architectural-migration decision, Wave 2 completion evidence
- Goal: 기존 사용자 buffer 설정과 UI를 보존한 채 `TerminalResourcePolicy`, browser sole writer, retained server authority, authority promotion/rollback, fair delivery와 hidden authoritative recovery를 구현 가능한 요구사항으로 분해한다.
- Exclusions: UI 시각/label/layout 변경, product default 숫자 변경, binary/split 기본화, xterm engine 교체, legacy 물리 삭제
- Constraint: `C:\Work\git-none\orca`는 읽기 전용이며 로컬 IPC 상수는 BuilderGate WAN/WebSocket 환경에 그대로 복사하지 않는다.

