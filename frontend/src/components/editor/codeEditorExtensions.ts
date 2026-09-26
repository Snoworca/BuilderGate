// The code-mode editor's CodeMirror bundle, the global line-wrap preference,
// and the lazy grammar load -- everything CodeFileEditor needs that can be
// built and tested without a DOM.
//
// Nothing from the markdown editor comes in except its theme: no live preview,
// no table or image widgets, no list/emphasis input helpers, no markdown
// language. Colours come from the vendored theme's CSS variables only.
//
// This module must load under `node --experimental-strip-types`, so relative
// imports carry `.ts` and languages.ts (whose import chain is extensionless)
// is reached through a dynamic import only.
//
// @req FR-MDE-014

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  type LanguageSupport,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import {
  atomicEditorTheme,
  atomicMarkdownHighlight,
} from '../../editor/vendor/atomic-editor/atomic-theme.ts';
import { dataFileLintExtension, type DataFileKind } from './dataFileLint.ts';
import {
  CSV_COLUMN_COLOR_COUNT,
  csvColumnClass,
  splitDelimitedColumns,
  type ColumnDelimiter,
} from './csvColumns.ts';

/** The one localStorage key holding the wrap preference for every code file. */
export const WRAP_PREFERENCE_KEY = 'buildergate.codeEditor.lineWrap';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Whether code files open wrapped. Off unless the user turned it on. */
export function readWrapPreference(storage: PreferenceStorage | null = defaultStorage()): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(WRAP_PREFERENCE_KEY) === 'true';
  } catch {
    // Blocked storage (private mode, sandbox) reads as the default.
    return false;
  }
}

/** Stores the wrap preference. A storage failure only loses the preference. */
export function writeWrapPreference(
  value: boolean,
  storage: PreferenceStorage | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.setItem(WRAP_PREFERENCE_KEY, value ? 'true' : 'false');
  } catch (error) {
    console.warn('[code-editor] could not store the line-wrap preference', error);
  }
}

/** The wrap extension alone, for a compartment reconfigure. */
export function wrapExtension(wrap: boolean): Extension {
  return wrap ? EditorView.lineWrapping : [];
}

/** The grammar extension alone, for a compartment reconfigure. */
export function languageExtension(language: LanguageSupport | null): Extension {
  return language ?? [];
}

// The vendored theme is tuned for a gutter-less reader: it hides
// `.cm-gutters` and makes the active line transparent, and sets a proportional
// body font. Code mode undoes those three, at higher precedence so its rules
// mount after (and win over) the vendored ones. Colours stay var()-only, from
// tokens the vendored stylesheet already defines under the panel's light theme.
const codeFontTheme = Prec.highest(EditorView.theme({
  '&': { fontFamily: 'var(--atomic-editor-font-mono, ui-monospace, monospace)' },
  '.cm-scroller': {
    fontFamily: 'var(--atomic-editor-font-mono, ui-monospace, monospace)',
    lineHeight: '1.5',
  },
  // Room between the text and the editor's edges (user request 2026-09-26):
  // the vendored reader sets the content and lines to zero padding.
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 16px 0 10px' },
  '.cm-gutterElement': { padding: '0 6px 0 10px' },
  // The gutter is sticky, so text scrolled sideways passes under it and it has
  // to be opaque. The editor itself is transparent over the document panel, so
  // the gutter takes the panel's background (--editor-doc-bg, EditorWindow.css)
  // and stays right in both themes without a colour of its own.
  '.cm-gutters': {
    display: 'flex',
    backgroundColor: 'var(--editor-doc-bg)',
    color: 'var(--atomic-editor-fg-faint)',
    borderRight: '1px solid var(--atomic-editor-border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--atomic-editor-bg-panel)',
  },
}));

// FR-MDE-017 -- CSV/TSV column colours cycle through the theme's highlight
// tokens, so they follow the editor theme and need no colour literals.
const CSV_COLUMN_TOKENS = ['keyword', 'string', 'number', 'function', 'type', 'property'] as const;

const csvColumnTheme = EditorView.theme(Object.fromEntries(
  Array.from({ length: CSV_COLUMN_COLOR_COUNT }, (_, index) => [
    `.${csvColumnClass(index)}`,
    { color: `var(--atomic-editor-hl-${CSV_COLUMN_TOKENS[index % CSV_COLUMN_TOKENS.length]})` },
  ]),
));

const csvColumnMarks = Array.from({ length: CSV_COLUMN_COLOR_COUNT }, (_, index) =>
  Decoration.mark({ class: csvColumnClass(index) }));

// @req FR-MDE-017
/** Colours each column of the visible CSV/TSV lines; empty for null. */
export function csvColumnExtension(delimiter: ColumnDelimiter | null): Extension {
  if (delimiter === null) return [];
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    // A fold can split one line across two visible ranges; each line is
    // decorated once so the builder's ranges stay in order.
    let lastLine = 0;
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        pos = line.to + 1;
        if (line.number <= lastLine) continue;
        lastLine = line.number;
        splitDelimitedColumns(line.text, delimiter).forEach((span, index) => {
          if (span.to > span.from) {
            builder.add(line.from + span.from, line.from + span.to, csvColumnMarks[index % CSV_COLUMN_COLOR_COUNT]);
          }
        });
      }
    }
    return builder.finish();
  };
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  }, { decorations: (instance) => instance.decorations });
  return [plugin, csvColumnTheme];
}

// Words already in the document, offered alongside any language completions.
const documentWordCompletion = EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]);

export interface CodeEditorOptions {
  wrap: boolean;
  language: LanguageSupport | null;
  /** When given, wrap is placed in it so the view can toggle it in place. */
  wrapCompartment?: Compartment;
  /** When given, the grammar is placed in it so it can arrive after mount. */
  languageCompartment?: Compartment;
  /** JSON/JSONL/YAML syntax diagnostics (FR-MDE-017); mount-time. */
  dataFile?: DataFileKind | null;
  /** CSV/TSV column colouring (FR-MDE-017); mount-time. */
  columnDelimiter?: ColumnDelimiter | null;
}

export interface CodeEditorBundle {
  extensions: Extension[];
  /** Names of what the bundle carries, so it can be inspected without a DOM. */
  features: readonly string[];
}

export function buildCodeEditorExtensions(options: CodeEditorOptions): CodeEditorBundle {
  const wrap = wrapExtension(options.wrap);
  const language = languageExtension(options.language);

  const parts: [string, Extension][] = [
    ['lineNumbers', lineNumbers()],
    ['highlightActiveLineGutter', highlightActiveLineGutter()],
    ['highlightSpecialChars', highlightSpecialChars()],
    ['history', history()],
    ['foldGutter', foldGutter()],
    ['drawSelection', drawSelection()],
    ['dropCursor', dropCursor()],
    ['allowMultipleSelections', EditorState.allowMultipleSelections.of(true)],
    ['indentOnInput', indentOnInput()],
    ['syntaxHighlight', syntaxHighlighting(atomicMarkdownHighlight)],
    ['bracketMatching', bracketMatching()],
    ['closeBrackets', closeBrackets()],
    ['wordCompletion', [autocompletion(), documentWordCompletion]],
    ['rectangularSelection', rectangularSelection()],
    ['crosshairCursor', crosshairCursor()],
    ['highlightActiveLine', highlightActiveLine()],
    ['highlightSelectionMatches', highlightSelectionMatches()],
    ['search', search({ top: true })],
    [
      'searchKeymap',
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
    ],
    ['theme', [atomicEditorTheme, codeFontTheme]],
    ['lineWrap', options.wrapCompartment ? options.wrapCompartment.of(wrap) : wrap],
    ['language', options.languageCompartment ? options.languageCompartment.of(language) : language],
    ['dataFileLint', dataFileLintExtension(options.dataFile ?? null)],
    ['csvColumns', csvColumnExtension(options.columnDelimiter ?? null)],
  ];

  return {
    extensions: parts.map(([, extension]) => extension),
    features: parts.map(([name]) => name),
  };
}

/** What loadLanguageSupport needs from a language description. */
export type LanguageDescriber = (
  id: string | null,
) => { load: () => Promise<LanguageSupport> } | null;

async function defaultDescriber(): Promise<LanguageDescriber> {
  const { languageDescriptionFor } = await import('../../editor/languages.ts');
  return languageDescriptionFor;
}

/**
 * The grammar for a language id from resolveEditorMode, or null to stay in
 * plain text: for a null or unknown id, and for a loader that fails -- the
 * file must stay editable either way, so this never rejects.
 */
export async function loadLanguageSupport(
  id: string | null,
  describe?: LanguageDescriber,
): Promise<LanguageSupport | null> {
  if (id === null) return null;
  try {
    const description = (describe ?? await defaultDescriber())(id);
    if (description === null) return null;
    return await description.load();
  } catch (error) {
    console.warn(`[code-editor] grammar "${id}" failed to load; editing as plain text`, error);
    return null;
  }
}
