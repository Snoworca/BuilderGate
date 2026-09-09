// @doculight/editor — 마크다운 라이브 프리뷰 에디터
//
// 핵심은 프레임워크 중립 CodeMirror 6 확장이다 (R33-c). React 결합은
// 얇은 래퍼 한 겹으로 제한한다.

export {
  findMermaidBlocks,
  mermaidBlockField,
  mermaidBlocks,
  mermaidRendererFacet,
  type MermaidBlock,
  type MermaidBlocksConfig,
} from './core/mermaid-blocks';

export { codeBlockField, codeBlocks, findCodeBlocks, type CodeBlock } from './core/code-blocks';
export { findTags, isFrontmatterRange, type TagMatch } from './core/tags';
export { findMathBlocks, renderMath, type MathBlock } from './core/math-blocks';
export { mathBlocks, mathField } from './core/math-decoration';
export { tagDecorations, type TagClick } from './core/tag-decoration';
export { codeHighlight, doculightExtensions, type AttachUpload } from './doculight-extensions';
export { highlightCode, isHighlightable } from './core/code-highlight';
export { pasteUploadExtension } from './core/paste-upload';

export {
  defaultMermaidRenderer,
  getCachedSize,
  isMermaidModuleLoaded,
  renderMermaid,
  setCachedSize,
  type MermaidRenderer,
  type MermaidResult,
  type RenderedSize,
} from './core/mermaid-render';

// vendor 재수출 — 소비자가 vendor 경로를 직접 알 필요가 없게 한다.
// 자체 래퍼(src/react/)로 교체되면 이 줄이 사라진다.
export { AtomicCodeMirrorEditor } from './vendor/atomic-editor/index';
export type {
  AtomicCodeMirrorEditorHandle,
  AtomicCodeMirrorEditorProps,
} from './vendor/atomic-editor/index';
