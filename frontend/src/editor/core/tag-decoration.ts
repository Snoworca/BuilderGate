import { StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { findTags, type TagMatch } from './tags.js';

/**
 * 태그 데코레이션 (`FR-EDITOR-007` AC-10 · AC-11 · 원장 `R151`).
 *
 * 커서가 없는 줄에서는 칩으로 그리고, 커서를 올리면 `#` 를 포함한 원문이
 * 드러난다 — 다른 아홉 요소와 같은 규칙이다.
 *
 * 클릭했을 때 무엇이 열리는지는 **여기서 정하지 않는다.** 조항이 정한 것은
 * 「좌측 검색 탭이 활성되고 질의가 채워진다」인데, 그 두 자리는 셸이
 * 소유한다 — 에디터가 그것을 직접 만지면 에디터가 셸의 구조를 알게 된다.
 * 대신 콜백 하나를 받는다.
 */
export interface TagClick {
  (name: string): void;
}

class TagWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly onClick: TagClick | undefined,
  ) {
    super();
  }

  eq(other: TagWidget): boolean {
    return other.name === this.name;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'dl-tag';
    chip.dataset.tag = this.name;
    chip.textContent = `#${this.name}`;
    // 버튼 역할을 주는 이유는 이것이 실제로 눌리는 것이기 때문이다 —
    // 눌리는데 역할이 없으면 키보드로는 닿지 못한다.
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;

    const fire = () => this.onClick?.(this.name);
    chip.addEventListener('click', fire);
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fire();
    });

    return chip;
  }

  ignoreEvent(): boolean {
    // 위젯이 이벤트를 삼키게 둔다 — 삼키지 않으면 클릭이 커서 이동으로도
    // 읽혀 칩을 누르는 순간 그 칩이 원문으로 풀린다.
    return false;
  }
}

/** 커서가 이 자리에 닿아 있는가 — 닿아 있으면 원문을 그대로 둔다. */
const revealed = (
  ranges: readonly { from: number; to: number }[],
  tag: TagMatch,
): boolean => ranges.some((range) => range.from <= tag.to && range.to >= tag.from);

const decorationFor = (tag: TagMatch, onClick: TagClick | undefined): Range<Decoration> =>
  Decoration.replace({ widget: new TagWidget(tag.name, onClick) }).range(tag.from, tag.to);

export function tagDecorations(onClick?: TagClick): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) =>
      Decoration.set(
        findTags(state.doc.toString())
          .filter((tag) => !revealed(state.selection.ranges, tag))
          .map((tag) => decorationFor(tag, onClick)),
        true,
      ),
    update(value, tr) {
      if (!tr.docChanged && tr.selection === undefined) return value.map(tr.changes);
      return Decoration.set(
        findTags(tr.state.doc.toString())
          .filter((tag) => !revealed(tr.state.selection.ranges, tag))
          .map((tag) => decorationFor(tag, onClick)),
        true,
      );
    },
    provide: (self) => EditorView.decorations.from(self),
  });

  return [field];
}
