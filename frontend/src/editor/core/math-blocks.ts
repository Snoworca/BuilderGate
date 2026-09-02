import type { EditorState } from '@codemirror/state';
import katex from 'katex';

import { selectionTouches } from './selection-touches.js';
import { maskVerbatim } from './verbatim.js';

/**
 * 수식 (`FR-EDITOR-007` AC-8).
 *
 * 라이브 프리뷰의 아홉 요소 중 하나이며, 다른 여덟과 같은 규칙을 따른다 —
 * 커서가 없는 자리에서는 구분자를 감추고 렌더한 결과를 보여 주며, 커서를
 * 올리면 원문이 드러난다.
 *
 * 찾는 일만 여기서 한다. 칠하는 일은 CodeMirror 확장이 하고, 그 둘을 갈라
 * 두면 「무엇을 수식으로 볼 것인가」를 에디터 없이 확인할 수 있다.
 */

export interface MathBlock {
  from: number;
  to: number;
  /** `$` 를 뺀 알맹이. */
  tex: string;
  /** `$$` 인가 — 참이면 블록, 거짓이면 문장 안의 인라인. */
  display: boolean;
  /** 커서가 이 자리에 있어 원문을 그대로 두어야 하는가. */
  revealed: boolean;
}

/**
 * 숫자만으로 된 것은 수식이 아니다 — `$5` 는 금액이다.
 *
 * 금액 표기를 수식으로 잡으면 가격표를 쓴 문서가 전부 깨지고, 그 깨짐은
 * 문서를 읽을 때까지 드러나지 않는다.
 */
const DIGITS_ONLY = /^[\d\s.,]*$/;

const isMeaningful = (tex: string) => tex.trim() !== '' && !DIGITS_ONLY.test(tex);

/**
 * 문서의 수식들.
 *
 * `$$` 를 먼저 훑고 남은 자리에서 `$` 를 훑는다 — 순서를 뒤집으면 `$$` 의
 * 여는 두 글자가 빈 인라인 수식으로 잡힌다.
 */
export function findMathBlocks(state: EditorState): MathBlock[] {
  const doc = state.doc.toString();
  // **가리고 찾는다.** 찾은 뒤 걸러 내면 펜스 안의 `$$` 가 이미 뒤쪽을
  // 먹어 치워, 바로 다음에 오는 진짜 수식이 통째로 사라진다.
  const searchable = maskVerbatim(doc);
  const found: MathBlock[] = [];
  const taken: Array<[number, number]> = [];

  for (const [pattern, display] of [
    // 여는 `$$` 뒤와 닫는 `$$` 앞에 붙은 공백만 허용하고, 알맹이에 홑
    // `$` 가 남아 있으면 수식이 아니다 — `$$ 와 $ 와 $$$` 같은 문장이
    // 통째로 수식이 되면 그 문장이 화면에서 사라진다.
    [/\$\$([^$]+?)\$\$/g, true],
    // 인라인 수식의 경계 규칙 넷. 하나라도 빼면 금액·셸 변수 표기가
    // 수식이 되고, 그러면 그 문장이 통째로 화면에서 사라진다.
    //
    // ① 여는 `$` **앞**이 글자·숫자면 아니다 — `USD$50`.
    // ② 여는 `$` **뒤**가 공백이면 아니다.
    // ③ 닫는 `$` **앞**이 공백이면 아니다 — `$5 와 $10`.
    // ④ 닫는 `$` **뒤**가 글자·숫자면 아니다 — `$5-$10` · `$5와$10` ·
    //    `echo $A$B` 가 전부 여기서 걸린다. 앞의 셋만으로는 못 잡는다.
    [/(?<![\p{L}\p{N}])\$(?!\s)([^$\n]*?)(?<!\s)\$(?![\p{L}\p{N}])/gu, false],
  ] as const) {
    for (const match of searchable.matchAll(pattern)) {
      const from = match.index!;
      const to = from + match[0].length;
      if (taken.some(([a, b]) => from < b && to > a)) continue;
      if (!isMeaningful(match[1]!)) continue;

      taken.push([from, to]);
      found.push({
        from,
        to,
        tex: doc.slice(from + (display ? 2 : 1), to - (display ? 2 : 1)),
        display,
        revealed: selectionTouches(state, from, to),
      });
    }
  }

  return found.sort((a, b) => a.from - b.from);
}

/**
 * KaTeX 렌더.
 *
 * **던지지 않는다.** 편집 중의 수식은 거의 항상 깨져 있고 — 사용자가
 * 글자를 하나씩 치는 중이므로 — 던지면 타이핑 도중 에디터 전체가 멈춘다.
 * 깨진 동안에는 원문을 그대로 보여 주는 것이 사용자가 기대하는 바다.
 */
export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    return tex;
  }
}
