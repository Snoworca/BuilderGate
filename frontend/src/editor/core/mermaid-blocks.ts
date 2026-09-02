// ```mermaid 펜스의 라이브 프리뷰.
//
// 커서가 블록 밖이면 다이어그램 위젯으로 대체하고, 블록에 닿으면 원문을
// 그대로 노출한다. 판정 단위는 블록 전체다 (기능 요청서 §3.2 "멀티라인 블록").
//
// 블록 위젯은 ViewPlugin 에서 발행할 수 없다 — CM6 는 StateField 또는 필수
// facet 에서 나올 것을 요구한다. vendor 의 `image-blocks.ts` 와 같은 구조다.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorState,
  Facet,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';

import {
  defaultMermaidRenderer,
  getCachedSize,
  renderMermaid,
  setCachedSize,
  type MermaidRenderer,
} from './mermaid-render';
import { selectionTouches } from './selection-touches.js';

export interface MermaidBlock {
  /** 펜스를 포함한 블록 시작 */
  from: number;
  /** 펜스를 포함한 블록 끝 */
  to: number;
  /** 펜스를 제외한 다이어그램 소스 */
  code: string;
}

export interface MermaidBlocksConfig {
  /** 렌더 경계 주입. 생략하면 mermaid 를 동적 import 한다. */
  renderer?: MermaidRenderer;
}

export const mermaidRendererFacet = Facet.define<MermaidRenderer, MermaidRenderer>({
  combine: (values) => (values.length ? values[values.length - 1] : defaultMermaidRenderer),
});

const ENSURE_PARSE_BUDGET_MS = 200;

/**
 * 구문 트리에서 mermaid 펜스만 골라낸다.
 *
 * 문서 전체 트리를 확보한 뒤 순회한다 — 부분 파싱 상태에서 순회하면 뒤쪽
 * 블록이 영구히 원문으로 남는다 (vendor `inline-preview.ts` 가 같은 이유로
 * `ensureSyntaxTree` 를 쓴다).
 */
export function findMermaidBlocks(state: EditorState): MermaidBlock[] {
  const tree =
    ensureSyntaxTree(state, state.doc.length, ENSURE_PARSE_BUDGET_MS) ?? syntaxTree(state);
  const blocks: MermaidBlock[] = [];

  tree.iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;

      const info = node.node.getChild('CodeInfo');
      if (!info) return;
      if (state.doc.sliceString(info.from, info.to).trim() !== 'mermaid') return;

      const text = node.node.getChild('CodeText');
      blocks.push({
        from: node.from,
        to: node.to,
        code: text ? state.doc.sliceString(text.from, text.to) : '',
      });
    },
  });

  return blocks;
}

let widgetSeq = 0;

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly readOnly: boolean,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.readOnly === this.readOnly;
  }

  /**
   * 바깥 컨테이너가 세로 여백을 갖고, 그 안에 다이어그램의 시각 상자를 둔다.
   *
   * CM6 는 블록 위젯의 높이를 `getBoundingClientRect` 로 재는데 그 값은 `margin`
   * 을 빼고 `padding` 은 넣는다. 여백을 시각 상자의 `margin` 으로 두면 heightmap
   * 이 DOM 보다 그만큼 짧아지고, 이 블록 아래의 모든 줄에서 클릭이 눌린 줄보다
   * 아래 줄로 라우팅된다. `.cm-atomic-table` 이 같은 이유로 `padding` 을 쓴다.
   *
   * 시각 상자에 직접 `padding` 을 줄 수는 없다 — 테두리와 배경이 있어 상자가
   * 그만큼 커져 보인다. 그래서 여백만 갖는 컨테이너를 하나 덧댄다.
   */
  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div');
    host.className = 'dl-mermaid-block';

    const box = document.createElement('div');
    box.className = 'dl-mermaid';
    host.append(box);

    // 마운트 시점에 이전 렌더 크기를 잡아 둔다 — 렌더 완료 후 높이가 자라면
    // 스크롤 앵커와 충돌한다.
    const cached = getCachedSize(this.code);
    if (cached) box.style.minHeight = `${cached.h}px`;

    void this.paint(box, view.state.facet(mermaidRendererFacet));
    return host;
  }

  private async paint(box: HTMLElement, renderer: MermaidRenderer): Promise<void> {
    const result = await renderMermaid(this.code, `dl-mermaid-${widgetSeq++}`, renderer);

    if ('error' in result) {
      box.classList.add('dl-mermaid-error');
      box.textContent = result.error;
      return;
    }

    box.innerHTML = result.svg;

    const svg = box.querySelector('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.height > 0) setCachedSize(this.code, { w: rect.width, h: rect.height });
  }

  /**
   * 읽기 전용에서는 CM6 의 마우스 처리를 막아 캐럿이 블록 안으로 들어가지
   * 않게 한다. 편집 모드에서는 클릭으로 원문이 열리는 것이 라이브 프리뷰의
   * 정상 동작이므로 CM6 에 넘긴다.
   *
   * (반환값 `true` 가 "에디터는 이 이벤트에서 손을 뗀다"는 뜻이다.)
   */
  ignoreEvent(event: Event): boolean {
    if (!this.readOnly) return false;
    return event.type === 'mousedown' || event.type === 'click';
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];

  // 읽기 전용에서는 원문을 드러내지 않는다 — 드러낼 이유가 편집인데
  // 편집이 불가능하기 때문이다. 선택은 여전히 가능하므로(복사 등) 선택
  // 위치로 판정하면 클릭만으로 원문이 튀어나온다.
  const revealable = !state.readOnly;

  for (const block of findMermaidBlocks(state)) {
    if (revealable && selectionTouches(state, block.from, block.to)) continue;
    ranges.push(
      Decoration.replace({
        widget: new MermaidWidget(block.code, state.readOnly),
        block: true,
      }).range(block.from, block.to),
    );
  }

  return Decoration.set(ranges, true);
}

export const mermaidBlockField = StateField.define<DecorationSet>({
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

/** 블록 바로 바깥의 위치. 문서가 블록뿐이면 나갈 곳이 없어 null 이다. */
function positionOutside(state: EditorState, block: MermaidBlock): number | null {
  if (block.from > 0) return block.from - 1;
  if (block.to < state.doc.length) return block.to + 1;
  return null;
}

/**
 * 읽기 전용을 빠져나올 때 선택을 mermaid 블록 밖으로 밀어낸다.
 *
 * 읽기 전용에서 다이어그램을 클릭하면 화면은 그대로지만 선택은 블록 안에
 * 남는다. 그 상태로 편집 모드로 돌아가면 사용자가 편집을 의도한 적 없는
 * 블록이 갑자기 원문으로 열린다. 전이 시점에 선택을 밖으로 옮겨 막는다.
 */
const escapeBlockOnReadOnlyExit = EditorState.transactionFilter.of((tr) => {
  // 모드 전환은 compartment 재구성으로 온다. 필터 안에서 `tr.state` 를 읽으면
  // 상태 계산이 필터를 다시 부르므로, 재구성 여부와 이전 상태만 본다.
  // 그래서 판정은 "읽기 전용이었고 재구성이 일어났다"까지다 — 재구성 뒤에도
  // 여전히 읽기 전용이면 선택을 옮겨도 화면은 달라지지 않으므로 무해하다.
  if (!tr.startState.readOnly || !tr.reconfigured || tr.docChanged) return tr;

  const head = tr.newSelection.main.head;
  const block = findMermaidBlocks(tr.startState).find((b) => head >= b.from && head <= b.to);
  if (!block) return tr;

  const anchor = positionOutside(tr.startState, block);
  return anchor === null ? tr : [tr, { selection: { anchor } }];
});

export function mermaidBlocks(config: MermaidBlocksConfig = {}): Extension {
  return [
    mermaidBlockField,
    escapeBlockOnReadOnlyExit,
    config.renderer ? mermaidRendererFacet.of(config.renderer) : [],
  ];
}
