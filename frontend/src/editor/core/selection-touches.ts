import type { EditorState } from '@codemirror/state';

/**
 * 커서(또는 선택)가 이 범위에 닿아 있는가 — 닿아 있으면 원문을 드러낸다.
 *
 * 라이브 프리뷰의 아홉 요소가 모두 같은 판정을 쓴다 (`FR-EDITOR-007`). 요소마다
 * 사본을 두면 한쪽만 경계 규칙이 바뀌어도 아무도 알아채지 못한 채 요소별로
 * 다르게 드러나기 시작한다.
 *
 * **경계를 포함한다.** 커서가 범위의 첫 자리나 끝 자리에 있으면 닿은 것이다 —
 * 블록 위젯을 클릭하면 커서가 그 두 끝 중 하나로 가므로, 경계를 빼면 클릭이
 * 만드는 자리를 정확히 놓친다.
 *
 * `src/vendor/atomic-editor/table-widget.ts` 에도 같은 술어가 하나 더 있다.
 * 그쪽은 vendor 경계 때문에 이 모듈을 import 하지 않으며, 그 사유는 그 자리
 * 주석에 적혀 있다. 이 규칙을 고치면 그쪽도 함께 고쳐야 한다.
 */
export const selectionTouches = (state: EditorState, from: number, to: number): boolean =>
  state.selection.ranges.some((range) => range.from <= to && range.to >= from);
