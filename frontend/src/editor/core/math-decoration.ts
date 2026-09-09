import { StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { findMathBlocks, renderMath, type MathBlock } from './math-blocks.js';

/**
 * 수식 데코레이션 (`FR-EDITOR-007` AC-8).
 *
 * 다른 여덟 요소와 같은 규칙이다 — 커서가 없는 자리에서는 구분자를 감추고
 * 렌더 결과를 보여 주며, 커서를 올리면 원문이 드러난다.
 *
 * `StateField` 인 이유는 블록 위젯을 `ViewPlugin` 에서 발행할 수 없기
 * 때문이다 (`mermaid-blocks` 가 같은 이유로 같은 선택을 했다).
 */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(): HTMLElement {
    const host = document.createElement(this.display ? 'div' : 'span');
    host.className = this.display ? 'dl-math dl-math-block' : 'dl-math dl-math-inline';
    // 렌더가 던지지 않는다 — 편집 중의 수식은 거의 항상 깨져 있고, 던지면
    // 타이핑 도중 에디터 전체가 멈춘다.
    host.innerHTML = renderMath(this.tex, this.display);
    return host;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const decorationFor = (block: MathBlock): Range<Decoration> =>
  Decoration.replace({
    widget: new MathWidget(block.tex, block.display),
    block: block.display,
  }).range(block.from, block.to);

const buildDecorations = (state: Parameters<typeof findMathBlocks>[0]): DecorationSet =>
  Decoration.set(
    findMathBlocks(state)
      .filter((block) => !block.revealed)
      .map(decorationFor),
    true,
  );

export const mathField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    // 커서만 움직여도 다시 만든다 — 「커서를 올리면 드러난다」가 선택
    // 변화에 걸려 있기 때문이다.
    if (!tr.docChanged && tr.selection === undefined) return value.map(tr.changes);
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 에디터에 붙일 확장. */
export function mathBlocks(): Extension {
  return [mathField];
}
