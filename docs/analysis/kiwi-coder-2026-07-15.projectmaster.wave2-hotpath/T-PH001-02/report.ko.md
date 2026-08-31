# T-PH001-02 Segmented byte deque와 Uint8Array writer GREEN 보고

- Requirement: `PERF-BGSTAB-009`
- 범위: scheduler, TerminalView thin writer adapter, unit compatibility assertions, NO_RENDER consumer adapter
- UI/default/protocol/authority 변경: 없음

## 구현 결과

- accepted non-empty ingress는 주입 가능 singleton `TextEncoder`로 정확히 한 번 encoding한다.
- queue는 `Uint8Array + headOffset + callbacks` segment를 보존한다.
- flush는 UTF-8 continuation byte를 최대 3바이트 역탐색하고 `subarray()`로 slice한다.
- budget보다 큰 첫 code point는 code point 전체를 한 번 전달하여 무한 정지를 방지한다.
- consumed head는 payload copy 없이 제거하고, leaf compaction allocation은 flush budget 이하로 제한한다.
- 제한 안에서 compact할 수 없는 chunk pressure는 queued+incoming bytes를 포함한 `visible-output-overflow`와 stale로 수렴한다.
- generation/schedule/write token으로 reset 이전 scheduled callback과 async write callback을 무효화하면서 single-flight를 유지한다.
- TerminalView는 xterm의 `string | Uint8Array` write 계약을 그대로 사용하는 thin adapter다.
- NO_RENDER fixture와 기존 문자열 고정 assertion은 delivered UTF-8 bytes/string을 decode-normalize할 뿐 digest, byte, invocation, ordering assertion을 약화하지 않았다.

## TDD 및 검증

초기 RED 재확인:

- unit: exit `1`, pass `20`, fail `4`
- 실패: encoder injection, encoded segment writer, non-compacting overflow, Uint8Array staged writer

최종 GREEN:

- `node --experimental-strip-types --test tests/unit/terminalOutputScheduler.test.ts`: `24/24`, exit `0`
- `npm run typecheck`: exit `0`
- changed-file scoped ESLint: exit `0`, error `0`
- inline edge probe: exit `0`
- `git diff --check`: exit `0`

ESLint는 TerminalView의 기존 cleanup ref 경고 3건을 다시 출력했으나 이번 task diff와 무관하며 error는 없다.

## 독립 리뷰

까칠한 task-level reviewer가 UTF-8 boundary, single code point 진행, encoder 횟수, empty/lone surrogate, compaction/overflow, callback/reset/single-flight/input-yield, TerminalView와 NO_RENDER adapter를 대조했다.

최종 판정: `No findings`

## 비고

공식 workflow validation은 plan/sidecar와 `T-PH001-02 running` 상태를 정상 인식했다. 별도로 오래된 `kiwi/pipeline.jsonl` 4행의 unsupported schema 경고 `SRS-W055`가 있었으나 현재 plan validation과 dependency에는 영향이 없었다.
