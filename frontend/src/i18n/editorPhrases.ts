import { EditorState, type Extension } from '@codemirror/state';
import { t, type MessageKey } from './i18n.ts';

/**
 * FR-I18N-003 AC-3: CodeMirror draws its built-in panels, and the vendored
 * search panel and table menu, through `state.phrase(<English source>)`. This
 * table maps each English source phrase to a catalog key; phrases not listed
 * stay English. `$` is CodeMirror's own substitution marker.
 */
const PHRASE_KEYS = {
  'Find': 'codemirror.find',
  'Search': 'codemirror.search',
  'Previous match': 'codemirror.previousMatch',
  'Next match': 'codemirror.nextMatch',
  'Close': 'codemirror.closePanel',
  '9999+ matches': 'codemirror.matchesCapped',
  'No matches': 'codemirror.noMatches',
  '1 match': 'codemirror.oneMatch',
  '$ matches': 'codemirror.matches',
  'Insert row above': 'codemirror.table.insertRowAbove',
  'Insert row below': 'codemirror.table.insertRowBelow',
  'Delete row': 'codemirror.table.deleteRow',
  'Insert column left': 'codemirror.table.insertColumnLeft',
  'Insert column right': 'codemirror.table.insertColumnRight',
  'Delete column': 'codemirror.table.deleteColumn',
  'Replace': 'codemirror.replaceField',
  'all': 'codemirror.all',
  'by word': 'codemirror.byWord',
  'close': 'codemirror.close',
  'match case': 'codemirror.matchCase',
  'next': 'codemirror.next',
  'previous': 'codemirror.previous',
  'regexp': 'codemirror.regexp',
  'replace': 'codemirror.replace',
  'replace all': 'codemirror.replaceAll',
  'Go to line': 'codemirror.goToLine',
  'current match': 'codemirror.currentMatch',
  'go': 'codemirror.go',
  'on line': 'codemirror.onLine',
  'replaced $ matches': 'codemirror.replacedMatches',
  'replaced match on line $': 'codemirror.replacedMatchOnLine',
  'Diagnostics': 'codemirror.diagnostics',
  'No diagnostics': 'codemirror.noDiagnostics',
  'Control character': 'codemirror.controlCharacter',
  'folded code': 'codemirror.foldedCode',
  'unfold': 'codemirror.unfold',
  'Completions': 'codemirror.completions',
  'Selection deleted': 'codemirror.selectionDeleted',
} as const satisfies Record<string, MessageKey>;

/** Build inside a component or hook (after the catalog is installed), never at module load. */
export function editorPhrases(): Extension {
  const phrases: Record<string, string> = {};
  for (const [source, key] of Object.entries(PHRASE_KEYS)) phrases[source] = t(key);
  return EditorState.phrases.of(phrases);
}
