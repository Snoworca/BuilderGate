import type { Extension } from '@codemirror/state';

import { highlightCode, isHighlightable } from './core/code-highlight.js';
import { codeBlocks } from './core/code-blocks.js';
import { mathBlocks } from './core/math-decoration.js';
import { pasteUploadExtension, type AttachUpload } from './core/paste-upload.js';
import { mermaidBlocks } from './core/mermaid-blocks.js';
import { tagDecorations, type TagClick } from './core/tag-decoration.js';
import { wikiLinks, type WikiLinkSuggestion } from './vendor/atomic-editor/wiki-links.js';

/**
 * DocuLight 가 vendor 에디터 위에 얹는 확장 **전부**.
 *
 * vendor 편집기 파일을 고치지 않고 여기서 얹는 이유는 그쪽이 상류에서
 * 내려오는 코드이기 때문이다 — 고치면 다음 병합에서 이 변경이 조용히
 * 사라지거나 충돌한다.
 *
 * 묶음을 하나로 두는 것은 「제품이 실제로 쓰는 에디터 설정」이 한 곳에만
 * 있게 하기 위해서다. 화면마다 확장을 골라 붙이면 어느 화면에서 무엇이
 * 되는지가 갈리고, 그 갈림은 요구 대비 판정을 무의미하게 만든다.
 */
/**
 * 읽기 화면의 코드 하이라이팅 (`CON-ARCH-005` AC-6).
 *
 * 확장 묶음이 이것을 함께 낸다 — 소비자가 따로 가져다 쓰면 어떤 화면에서
 * 색이 붙고 어떤 화면에서 안 붙는지가 갈린다.
 */
export const codeHighlight = { highlightCode, isHighlightable };

export function doculightExtensions(
  options: {
    onTagClick?: TagClick;
    onAttach?: AttachUpload;
    /** `[[` 뒤의 후보를 어디서 받아 오는가 (`CON-EDITOR-002` AC-1). */
    suggestWikiLinks?: (query: string) => Promise<WikiLinkSuggestion[]>;
    /** 위키링크를 눌렀다 — 그 문서를 여는 일은 셸이 한다. */
    onOpenWikiLink?: (target: string) => void;
    /**
     * 그 이름이 실제 문서인가 (`SEC-WORKSPACE-006`).
     *
     * **없는 문서와 권한 없는 문서를 가르지 않는다** — 둘 다 `null` 이다.
     * 여기서 상태를 하나 더 만들면 편집기가 그 값으로 다른 class 를 붙이고,
     * 그 class 가 곧 사유를 알린다.
     */
    resolveWikiLink?: (target: string) => Promise<{ target: string; label: string } | null>;
  } = {},
): Extension[] {
  return [
    // mermaid 를 **먼저** 얹는다. 두 확장이 같은 펜스를 대체하지 않도록
    // 코드 쪽이 mermaid 언어를 걸러 내지만, 순서까지 맞춰 두면 그 거름이
    // 뚫려도 다이어그램이 이긴다.
    mermaidBlocks(),
    codeBlocks(),
    mathBlocks(),
    tagDecorations(options.onTagClick),
    // 후보를 받아 올 곳이 없어도 얹는다 — 입력·데코레이션은 후보와 무관하게
    // 동작해야 하고, 빼 두면 그 자리에서만 `[[` 가 평범한 글자가 된다.
    wikiLinks({
      ...(options.suggestWikiLinks === undefined ? {} : { suggest: options.suggestWikiLinks }),
      ...(options.onOpenWikiLink === undefined ? {} : { onOpen: options.onOpenWikiLink }),
      ...(options.resolveWikiLink === undefined ? {} : { resolve: options.resolveWikiLink }),
    }),
    // 업로드 콜백이 없으면 그 확장을 붙이지 않는다 — 붙여 두고 아무것도
    // 안 하면 붙여넣기가 조용히 삼켜진다.
    ...(options.onAttach === undefined ? [] : [pasteUploadExtension(options.onAttach)]),
  ];
}

export type { TagClick, AttachUpload, WikiLinkSuggestion };
