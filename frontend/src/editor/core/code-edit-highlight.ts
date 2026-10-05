// Colours a fence that is being edited when CodeMirror has no parser for its language
// (`FR-MDE-026` AC-3) — Elixir, GraphQL, Zig, Terraform and the rest of shiki's grammars.
//
// CodeMirror colours the languages it parses itself. For the others the source would be
// one colour while editing and coloured again once the cursor left, so the same shiki
// tokens the reading view uses are laid over the source as marks. Tokenizing is
// asynchronous: until fresh tokens arrive the previous ones for that block are kept
// (clamped to the block), so typing does not make the block flicker to plain text.

import { syntaxTree } from '@codemirror/language';
import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { ThemedToken } from 'shiki';

import { codeMirrorParses } from './code-block-languages.ts';
import { isHighlightable, tokenizeCode } from './code-highlight.ts';

const tokensArrived = StateEffect.define<null>();
const CACHE_LIMIT = 64;
/** Diagrams are drawn by `mermaid-blocks`, not coloured as code. */
const OWNED_ELSEWHERE = new Set(['mermaid']);

function markFor(token: ThemedToken): Decoration | null {
  const style = token.htmlStyle as Record<string, string> | undefined;
  const color = style?.color ?? token.color;
  if (!color) return null;
  const dark = style?.['--shiki-dark'];
  return Decoration.mark({
    class: 'dl-shiki-token',
    attributes: { style: dark ? `color:${color};--shiki-dark:${dark}` : `color:${color}` },
  });
}

class CodeEditHighlight {
  decorations: DecorationSet;
  private readonly cache = new Map<string, ThemedToken[][]>();
  private readonly latestByBlock = new Map<number, ThemedToken[][]>();
  private readonly pending = new Set<string>();
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.decorations = this.build();
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged
      || update.viewportChanged
      || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(tokensArrived)))
    ) {
      this.decorations = this.build();
    }
  }

  destroy(): void {
    this.destroyed = true;
  }

  private request(key: string, code: string, language: string, blockFrom: number): void {
    if (this.pending.has(key)) return;
    this.pending.add(key);
    void tokenizeCode(code, language).then((tokens) => {
      this.pending.delete(key);
      if (this.destroyed || tokens === null) return;
      this.cache.set(key, tokens);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
      this.latestByBlock.set(blockFrom, tokens);
      this.view.dispatch({ effects: tokensArrived.of(null) });
    });
  }

  private build(): DecorationSet {
    const { state } = this.view;
    const tree = syntaxTree(state);
    const ranges: Range<Decoration>[] = [];
    for (const visible of this.view.visibleRanges) {
      tree.iterate({
        from: visible.from,
        to: visible.to,
        enter: (node) => {
          if (node.name !== 'FencedCode') return undefined;
          const info = node.node.getChild('CodeInfo');
          const text = node.node.getChild('CodeText');
          if (info === null || text === null) return false;
          const language = state.doc.sliceString(info.from, info.to).trim();
          if (!isHighlightable(language) || OWNED_ELSEWHERE.has(language.toLowerCase()) || codeMirrorParses(language)) {
            return false;
          }
          const code = state.doc.sliceString(text.from, text.to);
          const key = `${language}\u0000${code}`;
          let tokens = this.cache.get(key);
          if (tokens === undefined) {
            this.request(key, code, language, node.from);
            tokens = this.latestByBlock.get(node.from);
          }
          if (tokens === undefined) return false;
          for (const line of tokens) {
            for (const token of line) {
              const from = text.from + token.offset;
              const to = Math.min(from + token.content.length, text.to);
              if (from >= to || from >= text.to) continue;
              const mark = markFor(token);
              if (mark) ranges.push(mark.range(from, to));
            }
          }
          return false;
        },
      });
    }
    return Decoration.set(ranges, true);
  }
}

export function codeEditHighlight(): Extension {
  return ViewPlugin.fromClass(CodeEditHighlight, { decorations: (plugin) => plugin.decorations });
}
