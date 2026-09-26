// FR-MDE-017 -- syntax diagnostics for JSON, JSONL and YAML files.
//
// The checks are pure functions over the text (testable without a DOM); the
// CodeMirror linter adapter at the bottom wraps them thinly. Diagnostics are
// only shown: nothing here touches saving (AC-5).
//
// This module must load under `node --experimental-strip-types`.
//
// @req FR-MDE-017

import { jsonLanguage, jsonParseLinter } from '@codemirror/lang-json';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { EditorState, type Extension, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface LineDiagnostic {
  /** 1-based line number. */
  line: number;
  message: string;
}

export type DataFileKind = 'json' | 'jsonl' | 'yaml';

type RangeDiagnostic = Pick<Diagnostic, 'from' | 'to' | 'message'>;

const checkJson = jsonParseLinter();

/** The phrases jsonParseLinter reads a position out of. */
const POSITIONED_MESSAGE = /at position \d+|at line \d+ column \d+/;

/** Where the JSON grammar's error recovery first gave up, or null. */
function firstJsonSyntaxErrorAt(doc: Text): number | null {
  let found: number | null = null;
  jsonLanguage.parser.parse(doc.toString()).iterate({
    enter(node) {
      if (found !== null) return false;
      if (node.type.isError) found = node.from;
      return undefined;
    },
  });
  return found;
}

// jsonParseLinter reads only `view.state.doc`. It finds the error, but takes
// its position from the parse error message, and V8 names no position for an
// "Unexpected token" error -- the linter then puts it at 0, on line 1, however
// far down the broken value is. Such a diagnostic is moved to where the JSON
// grammar found the error.
function diagnoseJson(doc: Text): RangeDiagnostic[] {
  const state = EditorState.create({ doc });
  return checkJson({ state } as EditorView).map(({ from, to, message }) => {
    if (POSITIONED_MESSAGE.test(message)) return { from, to, message };
    const at = firstJsonSyntaxErrorAt(doc);
    return at === null ? { from, to, message } : { from: at, to: at, message };
  });
}

// One record per non-blank line; the body as a whole is never parsed as one
// JSON document (AC-2).
function diagnoseJsonl(doc: Text): RangeDiagnostic[] {
  const out: RangeDiagnostic[] = [];
  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n);
    if (line.text.trim() === '') continue;
    try {
      JSON.parse(line.text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      out.push({ from: line.from, to: line.to, message: error.message });
    }
  }
  return out;
}

// Error nodes of the lang-yaml syntax tree, at most one per line: the parser
// can emit several adjacent error nodes for one mistake.
function diagnoseYaml(doc: Text): RangeDiagnostic[] {
  const tree = yamlLanguage.parser.parse(doc.toString());
  const out: RangeDiagnostic[] = [];
  const seenLines = new Set<number>();
  tree.iterate({
    enter(node) {
      if (!node.type.isError) return;
      const lineNumber = doc.lineAt(node.from).number;
      if (seenLines.has(lineNumber)) return;
      seenLines.add(lineNumber);
      out.push({ from: node.from, to: node.to, message: 'YAML 문법 오류' });
    },
  });
  return out;
}

const DIAGNOSERS: Readonly<Record<DataFileKind, (doc: Text) => RangeDiagnostic[]>> = {
  json: diagnoseJson,
  jsonl: diagnoseJsonl,
  yaml: diagnoseYaml,
};

function toLines(text: string, diagnose: (doc: Text) => RangeDiagnostic[]): LineDiagnostic[] {
  const doc = EditorState.create({ doc: text }).doc;
  return diagnose(doc).map(({ from, message }) => ({ line: doc.lineAt(from).number, message }));
}

// @req FR-MDE-017
export function lintJson(text: string): LineDiagnostic[] {
  return toLines(text, diagnoseJson);
}

// @req FR-MDE-017
export function lintJsonl(text: string): LineDiagnostic[] {
  return toLines(text, diagnoseJsonl);
}

// @req FR-MDE-017
export function lintYaml(text: string): LineDiagnostic[] {
  return toLines(text, diagnoseYaml);
}

/** Which checker a file gets, from its name; null for none. */
export function dataFileKindFor(filePath: string): DataFileKind | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jsonl')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return null;
}

// @req FR-MDE-017
/** The CodeMirror linter and its gutter for a data file kind; empty for null. */
export function dataFileLintExtension(kind: DataFileKind | null): Extension {
  if (kind === null) return [];
  const diagnose = DIAGNOSERS[kind];
  return [
    linter((view) => diagnose(view.state.doc).map((d) => ({ ...d, severity: 'error' as const }))),
    lintGutter(),
  ];
}
