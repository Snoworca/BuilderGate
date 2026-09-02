// 언어가 붙은 펜스의 코드 하이라이팅 (`CON-ARCH-005` AC-6 · `FR-EDITOR-007` AC-6).
//
// 커서가 블록 밖이면 색을 입힌 코드로 대체하고, 블록에 닿으면 원문을 그대로
// 노출한다 — 다른 라이브 프리뷰 요소와 같은 규칙이다.
//
// mermaid 펜스는 가져가지 않는다. 두 확장이 같은 블록을 대체하면 어느 쪽이
// 이기는지가 등록 순서에 달리고, 그 순서는 어디에도 적혀 있지 않다.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

import { highlightCode, isHighlightable } from './code-highlight.js';
import { selectionTouches } from './selection-touches.js';

export interface CodeBlock {
  /** 펜스를 포함한 블록 시작 */
  from: number;
  /** 펜스를 포함한 블록 끝 */
  to: number;
  /** 펜스를 제외한 코드 */
  code: string;
  language: string;
}

const ENSURE_PARSE_BUDGET_MS = 200;

/** 다이어그램이 소유한 언어. 여기서 가져가면 두 확장이 같은 자리를 다툰다. */
const OWNED_ELSEWHERE = new Set(['mermaid']);

/**
 * 구문 트리에서 색을 칠할 펜스만 골라낸다.
 *
 * 문서 전체 트리를 확보한 뒤 순회한다 — 부분 파싱 상태에서 순회하면 뒤쪽
 * 블록이 영구히 원문으로 남는다.
 */
export function findCodeBlocks(state: EditorState): CodeBlock[] {
  const tree =
    ensureSyntaxTree(state, state.doc.length, ENSURE_PARSE_BUDGET_MS) ?? syntaxTree(state);
  const blocks: CodeBlock[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;

      const info = node.node.getChild('CodeInfo');
      if (info === null) return;

      const language = state.doc.sliceString(info.from, info.to).trim();
      // 언어가 없으면 추측하지 않는다 — 엉뚱한 색이 코드의 뜻을 잘못 읽게
      // 만든다. 그 판정의 주인은 `isHighlightable` 하나다.
      if (!isHighlightable(language) || OWNED_ELSEWHERE.has(language)) return;

      const text = node.node.getChild('CodeText');
      blocks.push({
        from: node.from,
        to: node.to,
        code: text === null ? '' : state.doc.sliceString(text.from, text.to),
        language,
      });
    },
  });

  return blocks;
}

class CodeWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly language: string,
  ) {
    super();
  }

  eq(other: CodeWidget): boolean {
    return other.code === this.code && other.language === this.language;
  }

  toDOM(): HTMLElement {
    const host = document.createElement('pre');
    host.className = 'dl-code';
    host.dataset.language = this.language;
    // 색이 오기 **전에** 원문을 넣어 둔다. 비워 두면 하이라이터가 도는
    // 동안 코드가 사라져 보이고, 느린 환경에서는 그것이 깜빡임이 아니라
    // 「내용이 없다」로 읽힌다.
    host.textContent = this.code;

    void highlightCode(this.code, this.language).then((html) => {
      host.innerHTML = html;
    });

    return host;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // 읽기 전용에서는 원문을 드러내지 않는다 — 드러낼 이유가 편집인데
  // 편집이 불가능하기 때문이다.
  const revealable = !state.readOnly;

  for (const block of findCodeBlocks(state)) {
    if (revealable && selectionTouches(state, block.from, block.to)) continue;
    ranges.push(
      Decoration.replace({
        widget: new CodeWidget(block.code, block.language),
        block: true,
      }).range(block.from, block.to),
    );
  }

  return Decoration.set(ranges, true);
}

export const codeBlockField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(decorations, tr) {
    // 읽기 전용 토글은 compartment 재구성이라 문서도 선택도 바꾸지 않는다.
    // 직접 감지하지 않으면 모드를 바꿔도 화면이 그대로 남는다.
    const readOnlyChanged = tr.startState.readOnly !== tr.state.readOnly;
    if (!tr.docChanged && tr.selection === undefined && !readOnlyChanged) {
      return decorations.map(tr.changes);
    }
    return buildDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function codeBlocks(): Extension {
  return [codeBlockField];
}
