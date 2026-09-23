import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// FR-FEX-007 AC-1..8 · FR-FEX-005 AC-5 — how the explorer's window-scoped modal
// is wired: where it is drawn, what it refuses to join, how it holds focus and
// Escape, and that it is the one ConfirmPort/DecidePort the window uses.
//
// What each question offers, what an answer turns into, what Escape means and
// where Tab goes are pure decisions in fileExplorerModalModel.ts, tested by
// fileExplorerModalModel.test.ts. What only source can show is that the modal
// and the window route through them, so these are source guards held to the
// rules fileExplorerWiring.test.ts sets:
//
// - Prose and literals neither trip nor satisfy a check. The scanner is copied
//   from fileExplorerInteractionWiring.test.ts (importing a *.test.ts registers
//   its tests a second time): comments are removed while strings, templates,
//   regex literals and JSX text are respected, and a view with every literal
//   blanked is kept beside it.
// - No empty sets. Every target is named and its existence asserted in every
//   case before its contents are judged. FileExplorerWindowModal.tsx is created
//   by the wiring step, so its absence is a failure, never a pass.
//
// Names that come from the decision module (buildDecisionModal,
// buildDeleteConfirmModal, resolveDecisionAnswer, decideWindowModalKey,
// nextFocusIndex) and the two the plan gives the new module
// (FileExplorerWindowModal, useFileExplorerWindowModal) are pinned. A state
// setter, a prop name or the hook's field names are the wiring step's to choose,
// so they are followed by shape: a value counts as "the modal's" when it is
// bound, directly or through local declarations and a panel prop, to what
// useFileExplorerWindowModal() returned.
//
// The existing in-window row (FileExplorerConfirmBar) keeps only the folder-name
// prompt and the error line; its own guard in fileExplorerInteractionWiring
// still holds it inside the window. This file checks that the delete confirm and
// the job decision have left it (FR-FEX-007 supersedes that part of the row).

const SRC_DIR = new URL('../../src/', import.meta.url);
const FX = 'components/fileExplorer/';

const T = {
  modal: `${FX}FileExplorerWindowModal.tsx`,
  window: `${FX}FileExplorerWindow.tsx`,
  confirmBar: `${FX}FileExplorerConfirmBar.tsx`,
  css: `${FX}FileExplorer.css`,
  // The explorer tab panel's file operations, shared with the editor's tree
  // pane (FR-MDE-012 AC-8): requestDelete is called here with the confirm the
  // panel hands it.
  opsHook: 'hooks/useFileTreeOperations.ts',
} as const;

// Held as a list so that the set can never come out empty.
const TARGETS = [T.modal, T.window, T.confirmBar, T.css] as const;

const MODEL_MODULE = /^\.\/fileExplorerModalModel(?:\.ts)?$/;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface Lexed {
  path: string;
  /** Comments removed, literals kept. */
  code: string;
  /** Comments removed and the inside of every string/template/regex literal blanked. */
  bare: string;
}

// '=>' is tracked as one token so that `() => /re/` starts a regex and
// `() => <div/>` starts JSX; a lone `>` or `<` does neither.
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '=>']);
const REGEX_KEYWORDS = /^(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;
const JSX_PRECEDERS = new Set(['(', ',', '=', ':', '?', '&', '|', '{', '}', ';', '[', '!', '=>']);
const JSX_KEYWORDS = /^(?:return|case|default|yield|await)$/;

/**
 * A small recursive lexer for TS/TSX: code, string/template/regex literals,
 * comments, and JSX (tags, attribute values, children text, `{}` expressions).
 * JSX children text is a literal like any other — blanked in `bare` — and a
 * `//` inside it is text, not a comment. `<` opens JSX only where an
 * expression may start, so `a < b` and `useState<T>(…)` stay code.
 */
function lex(source: string, path: string): Lexed {
  const code: string[] = [];
  const bare: string[] = [];
  const n = source.length;
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  // `<T>x` is a type assertion in .ts; only .tsx has JSX.
  const jsx = path.endsWith('.tsx');

  const put = (ch: string, keepInBare: boolean) => {
    code.push(ch);
    bare.push(keepInBare || ch === '\n' ? ch : ' ');
  };
  const blank = (ch: string) => {
    const s = ch === '\n' ? '\n' : ' ';
    code.push(s);
    bare.push(s);
  };
  const isIdent = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

  const lineComment = () => { while (i < n && source[i] !== '\n') { blank(source[i]); i += 1; } };
  const blockComment = () => {
    blank(source[i]); blank(source[i + 1]); i += 2;
    while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { blank(source[i]); i += 1; }
    if (i < n) { blank('*'); blank('/'); i += 2; }
  };
  const quoted = (q: string, multiline: boolean) => {
    put(q, true);
    i += 1;
    while (i < n && source[i] !== q && (multiline || source[i] !== '\n')) {
      if (source[i] === '\\' && i + 1 < n) { put(source[i], false); put(source[i + 1], false); i += 2; continue; }
      put(source[i], false);
      i += 1;
    }
    if (i < n && source[i] === q) { put(q, true); i += 1; }
  };
  const template = () => {
    put('`', true);
    i += 1;
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\' && i + 1 < n) { put(source[i], false); put(source[i + 1], false); i += 2; continue; }
      if (source[i] === '$' && source[i + 1] === '{') {
        put('$', true); put('{', true); i += 2;
        codeUntilBrace();
        continue;
      }
      put(source[i], false);
      i += 1;
    }
    if (i < n) { put('`', true); i += 1; }
  };
  const regex = () => {
    put('/', true);
    i += 1;
    let inClass = false;
    while (i < n && source[i] !== '\n') {
      const c = source[i];
      if (c === '\\' && i + 1 < n) { put(c, false); put(source[i + 1], false); i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      put(c, false);
      i += 1;
    }
    if (i < n && source[i] === '/') { put('/', true); i += 1; }
    while (i < n && /[a-z]/.test(source[i])) { put(source[i], true); i += 1; }
  };

  /** A JSX element starting at `<`. Returns after its closing tag. */
  const jsxElement = (): 'open' | 'close' | 'self' => {
    put('<', true);
    i += 1;
    const closing = source[i] === '/';
    // Type arguments on a tag (`<Mosaic<string> ...>`) nest angle brackets.
    let angles = 0;
    while (i < n) {
      const c = source[i];
      if (c === '<') { angles += 1; put(c, true); i += 1; continue; }
      if (c === '>' && angles > 0) { angles -= 1; put(c, true); i += 1; continue; }
      if (c === '/' && source[i + 1] === '/') { lineComment(); continue; }
      if (c === '/' && source[i + 1] === '*') { blockComment(); continue; }
      if (c === '"' || c === '\'') { quoted(c, true); continue; }
      if (c === '{') { put('{', true); i += 1; codeUntilBrace(); continue; }
      // `</>` closes a fragment; only an opening tag can self-close.
      if (!closing && c === '/' && source[i + 1] === '>') { put('/', true); put('>', true); i += 2; return 'self'; }
      if (c === '>') {
        put('>', true);
        i += 1;
        if (closing) return 'close';
        jsxChildren();
        return 'open';
      }
      put(c, true);
      i += 1;
    }
    return 'self';
  };
  const jsxChildren = () => {
    while (i < n) {
      const c = source[i];
      if (c === '<') {
        if (jsxElement() === 'close') return;
        continue;
      }
      if (c === '{') { put('{', true); i += 1; codeUntilBrace(); continue; }
      put(c, false);
      i += 1;
    }
  };

  const code_ = (stopAtBrace: boolean) => {
    let depth = 0;
    while (i < n) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === '/' && next === '/') { lineComment(); continue; }
      if (ch === '/' && next === '*') { blockComment(); continue; }
      if (ch === '\'' || ch === '"') { quoted(ch, false); lastSig = ch; lastWord = ''; continue; }
      if (ch === '`') { template(); lastSig = '`'; lastWord = ''; continue; }
      if (ch === '/' && (lastSig === '' || REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.test(lastWord))) {
        regex(); lastSig = '/'; lastWord = ''; continue;
      }
      if (jsx && ch === '<' && (isIdent(next) || next === '>')
        && (lastSig === '' || JSX_PRECEDERS.has(lastSig) || JSX_KEYWORDS.test(lastWord))
        // `<K extends X>(…) =>` and `<T,>(…) =>` are type parameters in TSX.
        && !/^<\s*[A-Za-z_$][\w$]*\s*(?:extends\b|,)/.test(source.slice(i, i + 80))) {
        jsxElement(); lastSig = 'a'; lastWord = ''; continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        if (depth === 0 && stopAtBrace) { put('}', true); i += 1; return; }
        depth -= 1;
      }
      put(ch, true);
      i += 1;
      if (isIdent(ch)) {
        lastWord = isIdent(source[i - 2]) ? lastWord + ch : ch;
        lastSig = ch;
      } else if (!/\s/.test(ch)) {
        lastSig = ch === '>' && lastSig === '=' && source[i - 2] === '=' ? '=>' : ch;
        lastWord = '';
      }
    }
  };
  // Named separately so template() and the JSX readers can recurse into code.
  function codeUntilBrace() { lastSig = '{'; lastWord = ''; code_(true); lastSig = 'a'; lastWord = ''; }

  code_(false);
  return { path, code: code.join(''), bare: bare.join('') };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k += 1) if (text[k] === '\n') line += 1;
  return line;
}

function where(src: Lexed, index: number): string {
  return `${src.path}:${lineOf(src.code, index)}`;
}

/** Index of the bracket that closes the one at `open`, over the blanked view. */
function matchBracket(bare: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let k = open; k < bare.length; k += 1) {
    const c = bare[k];
    if (c in pairs) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return k;
    }
  }
  return -1;
}

/** Index of the unmatched `{` that encloses `index`. */
function enclosingBrace(bare: string, index: number): number {
  let depth = 0;
  for (let k = index; k >= 0; k -= 1) {
    const c = bare[k];
    if (c === '}' || c === ')' || c === ']') depth += 1;
    else if (c === '{' || c === '(' || c === '[') {
      if (depth === 0) {
        if (c === '{') return k;
      } else depth -= 1;
    }
  }
  return -1;
}

/** An expression starting at `start`, ended by a depth-0 `,` `;` or closing bracket. */
function readExpression(bare: string, start: number): { start: number; end: number } {
  let depth = 0;
  let k = start;
  for (; k < bare.length; k += 1) {
    const c = bare[k];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth -= 1;
    } else if ((c === ',' || c === ';') && depth === 0) break;
  }
  return { start, end: k };
}

interface Span { start: number; end: number }

function slice(src: Lexed, span: Span): { code: string; bare: string } {
  return { code: src.code.slice(span.start, span.end), bare: src.bare.slice(span.start, span.end) };
}

/**
 * The initializer of `const|let name =` or the body of `function name(`. With
 * `at`, the declaration whose enclosing block holds `at` and is innermost wins,
 * so a `const d` in one handler never answers for another handler's `d`.
 */
function definitionOf(src: Lexed, name: string, at?: number): Span | null {
  const decls = [...src.bare.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=;]+)?=(?!=)`, 'g'))];
  const scoped = at === undefined ? decls : decls.filter((m) => {
    const open = enclosingBrace(src.bare, m.index);
    return open === -1 || (open <= at && at <= matchBracket(src.bare, open));
  });
  const decl = scoped.sort((a, b) => enclosingBrace(src.bare, b.index) - enclosingBrace(src.bare, a.index))[0];
  if (decl) return readExpression(src.bare, decl.index + decl[0].length);
  const fn = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src.bare);
  if (fn) {
    const brace = src.bare.indexOf('{', matchBracket(src.bare, fn.index + fn[0].length - 1));
    const close = matchBracket(src.bare, brace);
    if (brace !== -1 && close !== -1) return { start: brace, end: close + 1 };
  }
  return null;
}

/**
 * A span plus the definitions of the local functions it names, two levels
 * deep, so that `onClick={() => handleRow(e, row)}` is judged by what
 * handleRow does. Only names that are called, or a span that is a bare name
 * (`onClick={handleRow}`), are followed; a name declared inside the span is a
 * local and is never looked up elsewhere — `const d` in one handler must not
 * resolve to another handler's `const d`.
 */
function expand(src: Lexed, span: Span): Span[] {
  const out: Span[] = [span];
  const seen = new Set<string>();
  let frontier: Span[] = [span];
  for (let level = 0; level < 2; level += 1) {
    const nextFrontier: Span[] = [];
    for (const s of frontier) {
      const text = src.bare.slice(s.start, s.end);
      const locals = new Set([...text.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
      const bareName = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(text);
      const names = bareName ? [bareName[1]] : [...text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
      for (const name of names) {
        if (seen.has(name) || locals.has(name)) continue;
        seen.add(name);
        const def = definitionOf(src, name, s.start);
        if (def && !(def.start >= span.start && def.end <= span.end)) {
          out.push(def);
          nextFrontier.push(def);
        }
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

/** Every `attr={...}` in JSX: the braces' inside, with local handlers expanded. */
function handlerBodies(src: Lexed, attr: string): { at: number; spans: Span[] }[] {
  const out: { at: number; spans: Span[] }[] = [];
  for (const m of src.bare.matchAll(new RegExp(`\\b${attr}\\s*=\\s*\\{`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src.bare, open);
    if (close === -1) continue;
    out.push({ at: m.index, spans: expand(src, { start: open + 1, end: close }) });
  }
  return out;
}

function spansText(src: Lexed, spans: Span[]): { code: string; bare: string } {
  return {
    code: spans.map(s => src.code.slice(s.start, s.end)).join('\n'),
    bare: spans.map(s => src.bare.slice(s.start, s.end)).join('\n'),
  };
}

/** The opening tag text of every `<Name ...>` element. */
function openingTags(src: Lexed, name: string): Span[] {
  const out: Span[] = [];
  for (const m of src.bare.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let depth = 0;
    let k = m.index + m[0].length;
    for (; k < src.bare.length; k += 1) {
      const c = src.bare[k];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    out.push({ start: m.index, end: k + 1 });
  }
  return out;
}

/** The value of `attr=` inside a tag: a quoted literal or the inside of `{}`. */
function attrValue(src: Lexed, tag: Span, attr: string): { code: string; bare: string } | null {
  const text = src.bare.slice(tag.start, tag.end);
  const m = new RegExp(`\\s${attr}\\s*=\\s*`).exec(text);
  if (!m) return null;
  const at = tag.start + m.index + m[0].length;
  const c = src.code[at];
  if (c === '"' || c === '\'') {
    const end = src.code.indexOf(c, at + 1);
    return { code: src.code.slice(at, end + 1), bare: src.bare.slice(at, end + 1) };
  }
  if (c === '{') {
    const close = matchBracket(src.bare, at);
    return slice(src, { start: at + 1, end: close });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function exists(relPath: string): boolean {
  const url = new URL(relPath, SRC_DIR);
  const slash = relPath.lastIndexOf('/');
  const dir = new URL(slash === -1 ? './' : relPath.slice(0, slash + 1), SRC_DIR);
  const base = relPath.slice(slash + 1);
  return existsSync(dir) && readdirSync(dir).includes(base) && statSync(url).isFile();
}

/** Asserts every target exists, naming all the missing ones in one message. */
function requireSources(paths: readonly string[]): void {
  const missing = paths.filter(p => !exists(p));
  assert.deepEqual(missing, [], `target files must exist before their wiring can be checked; missing: ${missing.map(p => `src/${p}`).join(', ')}`);
}

function read(relPath: string): Lexed {
  const raw = readFileSync(new URL(relPath, SRC_DIR), 'utf8');
  const lexed = lex(raw, `src/${relPath}`);
  assert.ok(lexed.bare.trim().length > 0, `src/${relPath} is empty once comments are removed`);
  return lexed;
}

function readCss(relPath: string): string {
  return readFileSync(new URL(relPath, SRC_DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}


function callArgs(src: Lexed, name: string): Span[] {
  const out: Span[] = [];
  for (const m of src.bare.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(src.bare, open);
    if (close !== -1) out.push({ start: open + 1, end: close });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

/** The opening tag that starts at `start` (a `<`), up to its depth-0 `>`. */
function tagAt(src: Lexed, start: number): Span {
  let depth = 0;
  let k = start + 1;
  for (; k < src.bare.length; k += 1) {
    const c = src.bare[k];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) break;
  }
  return { start, end: k + 1 };
}

/** The first argument of a call whose argument list is `args`. */
function firstArg(src: Lexed, args: Span): Span {
  let start = args.start;
  while (start < args.end && /\s/.test(src.bare[start])) start += 1;
  return readExpression(src.bare, start);
}

/** The second argument of a call whose argument list is `args`, or null. */
function secondArg(src: Lexed, args: Span): Span | null {
  const first = firstArg(src, args);
  if (src.bare[first.end] !== ',') return null;
  let start = first.end + 1;
  while (start < args.end && /\s/.test(src.bare[start])) start += 1;
  return start < args.end ? readExpression(src.bare, start) : null;
}

/** Names imported from a module whose specifier matches `from`. */
function importedFrom(src: Lexed, from: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) {
    if (!from.test(m[3])) continue;
    for (const part of m[1].split(',')) {
      const name = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) out.push(name);
    }
  }
  return out;
}

interface CssRule { selector: string; body: string }

function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  const walk = (text: string) => {
    let k = 0;
    while (k < text.length) {
      const open = text.indexOf('{', k);
      if (open === -1) break;
      const selector = text.slice(k, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (selector.startsWith('@')) walk(body);
      else out.push({ selector, body });
      k = j;
    }
  };
  walk(css);
  return out;
}


// ---------------------------------------------------------------------------
// Modal helpers
// ---------------------------------------------------------------------------

/** The tag whose attribute list holds `index`. */
function tagHolding(src: Lexed, index: number): Span | null {
  const open = src.bare.lastIndexOf('<', index);
  return open === -1 ? null : tagAt(src, open);
}

function isSelfClosing(src: Lexed, tag: Span): boolean {
  return src.bare.slice(tag.start, tag.end).endsWith('/>');
}

/** Index of the `</name` that closes the element opened by `tag`, or -1. */
function closingTagOf(src: Lexed, tag: Span, name: string): number {
  if (isSelfClosing(src, tag)) return tag.end;
  const re = new RegExp(`<(/?)${name.replace(/\./g, '\\.')}\\b`, 'g');
  re.lastIndex = tag.end;
  let depth = 1;
  for (let m = re.exec(src.bare); m !== null; m = re.exec(src.bare)) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return m.index;
    } else if (!isSelfClosing(src, tagAt(src, m.index))) depth += 1;
  }
  return -1;
}

/** Every opening tag whose className names `cls` as a whole class. */
function tagsWithClass(src: Lexed, cls: string): { name: string; tag: Span }[] {
  const out: { name: string; tag: Span }[] = [];
  const re = new RegExp(`(?:^|[^\\w-])${cls}(?![\\w-])`);
  for (const m of src.bare.matchAll(/<([A-Za-z][\w.]*)/g)) {
    const tag = tagAt(src, m.index);
    const className = attrValue(src, tag, 'className');
    if (className !== null && re.test(className.code)) out.push({ name: m[1], tag });
  }
  return out;
}

/** Opening tags `<input>` whose type is the literal "checkbox". */
function checkboxTags(src: Lexed): Span[] {
  return [...src.bare.matchAll(/<input\b/g)]
    .map(m => tagAt(src, m.index))
    .filter(tag => /^\{?\s*['"]checkbox['"]\s*\}?$/.test(attrValue(src, tag, 'type')?.code.trim() ?? ''));
}

/**
 * Whether the element at `index` is drawn only inside `{…showApplyToAll && …}`
 * or `{…showApplyToAll ? … : …}`: the JSX expression enclosing it opens on
 * that flag.
 */
function gatedByApplyToAll(src: Lexed, index: number): boolean {
  const open = enclosingBrace(src.bare, index);
  if (open === -1) return false;
  return /^\{\s*!?\s*[\w$.?]*\bshowApplyToAll\s*(?:&&|\?)/.test(src.bare.slice(open, index));
}

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

function mentions(text: string, names: Iterable<string>): boolean {
  for (const name of names) if (new RegExp(`(?<![\\w$])${escapeName(name)}(?![\\w$])`).test(text)) return true;
  return false;
}

/** key → local for each entry of a `{ a, b: c, d = 1, ...rest }` pattern. */
function bindingPairs(pattern: string): { key: string; local: string }[] {
  const out: { key: string; local: string }[] = [];
  for (const raw of pattern.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const rest = /^\.\.\.\s*([A-Za-z_$][\w$]*)$/.exec(part);
    if (rest) {
      out.push({ key: '...', local: rest[1] });
      continue;
    }
    const [keyPart, localPart] = part.includes(':') ? part.split(':') : [part, part];
    const key = keyPart.split('=')[0].trim();
    const local = localPart.split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key) && /^[A-Za-z_$][\w$]*$/.test(local)) out.push({ key, local });
  }
  return out;
}

/** `const NAME = …` and `const { … } = …` inside `span`: the names bound and the initializer. */
function declarationsIn(src: Lexed, span: Span): { names: string[]; init: Span }[] {
  const out: { names: string[]; init: Span }[] = [];
  const text = src.bare.slice(span.start, span.end);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\})\s*(?::[^=;]+)?=(?!=)/g)) {
    const names = m[1] !== undefined ? [m[1]] : bindingPairs(m[2]).map(p => p.local);
    out.push({ names, init: readExpression(src.bare, span.start + m.index + m[0].length) });
  }
  return out;
}

/** `roots` plus every name declared inside `span` from an initializer that mentions one of them. */
function closeOver(src: Lexed, span: Span, roots: Iterable<string>): Set<string> {
  const out = new Set(roots);
  const decls = declarationsIn(src, span);
  for (let changed = true; changed;) {
    changed = false;
    for (const d of decls) {
      if (!mentions(src.bare.slice(d.init.start, d.init.end), out)) continue;
      for (const name of d.names) {
        if (!out.has(name)) {
          out.add(name);
          changed = true;
        }
      }
    }
  }
  return out;
}

interface Derivation {
  /** The body of `export function FileExplorerWindow`. */
  windowSpan: Span;
  /** Everything before it, where the tab panel lives. */
  panelSpan: Span;
  windowNames: Set<string>;
  panelNames: Set<string>;
}

/**
 * Follows what useFileExplorerWindowModal() returned: the names it is bound to
 * inside FileExplorerWindow, the props of <FileExplorerTabPanel> fed from them,
 * and the panel locals declared from those props. `hook` names the returning
 * call, so the same walk also answers for useFileExplorerConfirmBar.
 */
function derive(win: Lexed, hook: string): Derivation {
  const windowFn = /\bexport\s+function\s+FileExplorerWindow\b/.exec(win.bare);
  assert.ok(windowFn !== null, `${win.path}: export function FileExplorerWindow is gone`);
  const windowSpan = { start: windowFn.index, end: win.bare.length };
  const panelSpan = { start: 0, end: windowFn.index };

  const rootsIn = (span: Span) => declarationsIn(win, span)
    .filter(d => new RegExp(`^\\s*${hook}\\s*\\(`).test(win.bare.slice(d.init.start, d.init.end)))
    .flatMap(d => d.names);
  const windowNames = closeOver(win, windowSpan, rootsIn(windowSpan));

  const propKeys = new Set<string>();
  for (const tag of openingTags(win, 'FileExplorerTabPanel')) {
    for (const m of win.bare.slice(tag.start, tag.end).matchAll(/\s([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
      const value = attrValue(win, tag, m[1]);
      if (value !== null && mentions(value.bare, windowNames)) propKeys.add(m[1]);
    }
  }
  const panelRoots = [...rootsIn(panelSpan)];
  const params = /\bfunction\s+FileExplorerTabPanel\s*\(\s*\{/.exec(win.bare);
  if (params !== null) {
    const open = params.index + params[0].length - 1;
    const pattern = win.bare.slice(open + 1, matchBracket(win.bare, open));
    for (const { key, local } of bindingPairs(pattern)) if (propKeys.has(key)) panelRoots.push(local);
  }
  return { windowSpan, panelSpan, windowNames, panelNames: closeOver(win, panelSpan, panelRoots) };
}

/** Whether `text`, found at `at`, is bound to what the hook returned in the part of the file it sits in. */
function isDerived(d: Derivation, at: number, text: string): boolean {
  return mentions(text, at >= d.windowSpan.start ? d.windowNames : d.panelNames);
}

/** The innermost declaration whose initializer holds `index`. */
function declarationHolding(src: Lexed, index: number): Span | null {
  let best: Span | null = null;
  for (const d of declarationsIn(src, { start: 0, end: src.bare.length })) {
    if (d.init.start <= index && index < d.init.end && (best === null || d.init.end - d.init.start < best.end - best.start)) best = d.init;
  }
  return best;
}

/** The value of `key` in the object literal at `args`: `key: value` or the shorthand `key`. */
function propertyValue(src: Lexed, args: Span, key: string): Span | null {
  const text = src.bare.slice(args.start, args.end);
  const m = new RegExp(`(?:^|[{,\\s])${key}\\s*(:|,|\\})`).exec(text);
  if (m === null) return null;
  const keyEnd = args.start + m.index + m[0].length - 1;
  if (m[1] !== ':') return { start: keyEnd - key.length, end: keyEnd };
  let k = keyEnd + 1;
  while (/\s/.test(src.bare[k])) k += 1;
  return readExpression(src.bare, k);
}

function onKeyDownHandlers(src: Lexed): { at: number; code: string; bare: string }[] {
  return handlerBodies(src, 'onKeyDown').map(h => ({ at: h.at, ...spansText(src, h.spans) }));
}

/** The modal's own surface: the element carrying fx-window-modal or role="alertdialog". */
function isModalSurfaceTag(src: Lexed, tag: Span): boolean {
  const className = attrValue(src, tag, 'className');
  if (className !== null && /(?:^|[^\w-])fx-window-modal(?![\w-])/.test(className.code)) return true;
  return /^\{?\s*['"]alertdialog['"]\s*\}?$/.test(attrValue(src, tag, 'role')?.code.trim() ?? '');
}

// ---------------------------------------------------------------------------
// FR-FEX-007 AC-1 — the modal covers the explorer window and nothing else
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-007-AC1-02 FileExplorerWindowModal.tsx 가 존재하고 createPortal 을 쓰지 않으며 FileExplorerWindow.tsx 가 그것을 fx-window-body 안에서 렌더한다', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.doesNotMatch(modal.bare, /\bcreatePortal\b/, `${modal.path}: portals out of the window — it would cover the page, not the explorer`);
  for (const name of ['FileExplorerWindowModal', 'useFileExplorerWindowModal']) {
    assert.match(modal.bare, new RegExp(`\\bexport\\s+(?:function|const)\\s+${name}\\b`), `${modal.path} must export ${name}`);
  }

  const win = read(T.window);
  const imported = importedFrom(win, /^\.\/FileExplorerWindowModal(?:\.tsx)?$/);
  for (const name of ['FileExplorerWindowModal', 'useFileExplorerWindowModal']) {
    assert.ok(imported.includes(name), `${win.path} must import ${name} from ./FileExplorerWindowModal`);
  }

  const d = derive(win, 'useFileExplorerWindowModal');
  const calls = [...win.bare.matchAll(/\buseFileExplorerWindowModal\s*\(/g)];
  assert.equal(calls.length, 1, `${win.path}: expected one useFileExplorerWindowModal() — one modal per window, not one per tab panel`);
  assert.ok(calls[0].index > d.windowSpan.start, `${where(win, calls[0].index)}: useFileExplorerWindowModal() must be called by FileExplorerWindow, not by a tab panel`);
  assert.ok(d.windowNames.size > 0, `${where(win, calls[0].index)}: useFileExplorerWindowModal()'s result is not bound to a name`);

  const tags = openingTags(win, 'FileExplorerWindowModal');
  assert.equal(tags.length, 1, `${win.path}: expected one <FileExplorerWindowModal>`);
  const tag = tags[0];
  assert.ok(tag.start > d.windowSpan.start, `${where(win, tag.start)}: <FileExplorerWindowModal> belongs to FileExplorerWindow, once per window`);
  const fed = [...win.bare.slice(tag.start, tag.end).matchAll(/\s([A-Za-z_$][\w$]*)\s*=\s*\{/g)]
    .some(m => mentions(attrValue(win, tag, m[1])?.bare ?? '', d.windowNames));
  assert.ok(fed, `${where(win, tag.start)}: <FileExplorerWindowModal> is not fed from useFileExplorerWindowModal()`);

  const bodies = tagsWithClass(win, 'fx-window-body');
  assert.equal(bodies.length, 1, `${win.path}: expected one element with class fx-window-body`);
  const close = closingTagOf(win, bodies[0].tag, bodies[0].name);
  assert.ok(close !== -1, `${where(win, bodies[0].tag.start)}: the fx-window-body element is not closed`);
  assert.ok(tag.start > bodies[0].tag.end && tag.start < close,
    `${where(win, tag.start)}: <FileExplorerWindowModal> must be rendered inside the fx-window-body element, so it overlays this window only`);
});

test('TC-REQ-FR-FEX-007-AC1-03 FileExplorer.css: .fx-window-modal 은 position:absolute + inset 0 (fixed 아님), .fx-window-body 는 position:relative — 창 바깥을 덮지 않는다', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(tagsWithClass(modal, 'fx-window-modal').length > 0, `${modal.path}: no element carries the class fx-window-modal, so the rule below styles nothing`);

  const rules = cssRules(readCss(T.css));
  const exact = (cls: string) => rules.filter(r => r.selector.split(',').some(s => s.trim() === cls));
  const position = (body: string) => /(?:^|;)\s*position\s*:\s*([\w-]+)/.exec(body)?.[1] ?? null;

  const modalRules = exact('.fx-window-modal');
  assert.ok(modalRules.length > 0, `${T.css}: no .fx-window-modal rule`);
  const modalPositions = modalRules.map(r => position(r.body)).filter((p): p is string => p !== null);
  assert.deepEqual([...new Set(modalPositions)], ['absolute'], `${T.css}: .fx-window-modal must be position: absolute (found ${JSON.stringify(modalPositions)})`);
  const body = modalRules.map(r => r.body).join(';');
  const zero = (prop: string) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*0(?:px)?\\s*(?:;|$)`).test(body);
  assert.ok(zero('inset') || ['top', 'right', 'bottom', 'left'].every(zero), `${T.css}: .fx-window-modal must cover its container with inset: 0`);

  for (const r of rules.filter(rule => /\.fx-window-modal(?:[\w-]*)/.test(rule.selector))) {
    assert.notEqual(position(r.body), 'fixed', `${T.css}: '${r.selector}' is position: fixed — it would cover the whole page, not the window`);
  }

  const bodyRules = exact('.fx-window-body');
  const bodyPositions = bodyRules.map(r => position(r.body)).filter((p): p is string => p !== null);
  assert.deepEqual([...new Set(bodyPositions)], ['relative'],
    `${T.css}: .fx-window-body must be position: relative, the containing block the modal's inset: 0 resolves against (found ${JSON.stringify(bodyPositions)})`);
});

// ---------------------------------------------------------------------------
// FR-FEX-007 AC-4 — not a member of the global modal band
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-007-AC4-01 모달 파일에 useDialogStack·registerDialogStackEntry·WindowDialog·mode="modal"·document.body 형제 inert 가 없다 — 전역 모달 대역에 등록하지 않는다', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  for (const [re, view, what] of [
    [/\buseDialogStack\b|\bregisterDialogStackEntry\b/, 'bare', 'the dialog stack'],
    [/<WindowDialog\b|<MessageBox\b/, 'bare', 'a page-level dialog component'],
    [/\bmode\s*[=:]\s*\{?\s*['"]modal['"]/, 'code', 'mode="modal"'],
    [/\bdocument\s*\.\s*body\b/, 'bare', 'document.body'],
    [/\binert\b/, 'code', 'inert'],
    [/\baria-modal\b/, 'code', 'aria-modal (it tells assistive tech the whole page is blocked)'],
  ] as const) {
    assert.doesNotMatch(modal[view], re, `${modal.path}: uses ${what} — the modal must block this window only, leaving terminals and editors usable`);
  }
  assert.doesNotMatch(modal.code, /from\s*['"]\.\.\/dialog(?:\/|['"])/, `${modal.path}: imports from ../dialog`);
  assert.match(modal.code, /\srole\s*=\s*\{?\s*['"]alertdialog['"]/, `${modal.path}: the modal surface must carry role="alertdialog"`);

  const win = read(T.window);
  assert.doesNotMatch(win.bare, /\bcreatePortal\b|\buseDialogStack\b|\bregisterDialogStackEntry\b/, `${win.path}: registers with the dialog stack or portals itself`);
  const dialogs = openingTags(win, 'WindowDialog');
  assert.equal(dialogs.length, 1, `${win.path}: expected one <WindowDialog>`);
  assert.equal(attrValue(win, dialogs[0], 'mode')?.code, '"modeless"', `${where(win, dialogs[0].start)}: the explorer window must stay modeless while it asks`);
});

// ---------------------------------------------------------------------------
// FR-FEX-007 AC-2/3 — focus stays in the modal; Escape cancels and stops there
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-007-AC2-02 모달 onKeyDown 이 Tab 을 nextFocusIndex 로 돌리고 마운트 시 첫 컨트롤에 포커스한다', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(importedFrom(modal, MODEL_MODULE).includes('nextFocusIndex'), `${modal.path} must import nextFocusIndex from ./fileExplorerModalModel`);
  const handlers = onKeyDownHandlers(modal);
  assert.ok(handlers.length > 0, `${modal.path}: no onKeyDown — Tab would walk out of the modal into the rows behind it`);
  const trapped = handlers.some(h => /\bnextFocusIndex\s*\(/.test(h.bare) && /['"]Tab['"]/.test(h.code) && /\bpreventDefault\s*\(/.test(h.bare));
  assert.ok(trapped, `${modal.path}: an onKeyDown must take Tab (preventDefault) and move focus with nextFocusIndex`);

  const effects = [...callArgs(modal, 'useEffect'), ...callArgs(modal, 'useLayoutEffect')]
    .map(args => spansText(modal, expand(modal, args)).bare);
  const focusesFirst = effects.some(text => /\.\s*focus\s*\(/.test(text) && (/\[\s*0\s*\]/.test(text) || /\bnextFocusIndex\s*\(/.test(text)));
  const autoFocused = [...modal.bare.matchAll(/<(?:button|IconButton)\b/g)]
    .some(m => /(?:^|[^\w$])0(?![\w$.])/.test(attrValue(modal, tagAt(modal, m.index), 'autoFocus')?.bare ?? ''));
  assert.ok(focusesFirst || autoFocused, `${modal.path}: the first control must take focus when the modal mounts (an effect focusing control [0], or autoFocus on index 0)`);
});

test('TC-REQ-FR-FEX-007-AC3-02 모달 onKeyDown 이 Escape 를 decideWindowModalKey 로 판정하고 stopPropagation 한다(창 단축키로 새지 않음)', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(importedFrom(modal, MODEL_MODULE).includes('decideWindowModalKey'), `${modal.path} must import decideWindowModalKey from ./fileExplorerModalModel`);
  const judged = onKeyDownHandlers(modal).filter(h => /\bdecideWindowModalKey\s*\(/.test(h.bare));
  assert.ok(judged.length > 0, `${modal.path}: no onKeyDown runs decideWindowModalKey — Escape is not the modal's cancel`);
  for (const h of judged) {
    const tag = tagHolding(modal, h.at);
    assert.ok(tag !== null && isModalSurfaceTag(modal, tag), `${where(modal, h.at)}: the Escape handler must sit on the modal surface (fx-window-modal / role="alertdialog"), so a key from any control inside reaches it`);
    assert.match(h.bare, /\bstopPropagation\s*\(/, `${where(modal, h.at)}: keys must stop at the modal — the window's Delete/Ctrl+V shortcuts would otherwise act on the selection behind it`);
    assert.match(h.code, /['"]cancel['"]/, `${where(modal, h.at)}: the handler never acts on decideWindowModalKey's 'cancel'`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-007 AC-5..8 — the buttons and the checkbox come from the model
// ---------------------------------------------------------------------------

test("TC-REQ-FR-FEX-007-AC7-02 결정 분기가 applyToAll 체크박스를 렌더하고 그 값을 resolveDecisionAnswer 로 넘긴다", () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(importedFrom(modal, MODEL_MODULE).includes('resolveDecisionAnswer'), `${modal.path} must import resolveDecisionAnswer from ./fileExplorerModalModel`);
  const boxes = checkboxTags(modal);
  assert.equal(boxes.length, 1, `${modal.path}: expected one checkbox — '더 이상 묻지 않기'`);
  assert.ok(gatedByApplyToAll(modal, boxes[0].start), `${where(modal, boxes[0].start)}: the checkbox must be drawn only when the model's showApplyToAll says so`);
  assert.match(modal.bare, /\bapplyToAllLabel\b/, `${modal.path}: the checkbox label must come from the model's applyToAllLabel`);
  assert.doesNotMatch(modal.code, /더 이상 묻지 않기/, `${modal.path}: hard-codes the checkbox label instead of using applyToAllLabel`);

  const checked = attrValue(modal, boxes[0], 'checked');
  assert.ok(checked !== null, `${where(modal, boxes[0].start)}: the checkbox is not controlled (no checked)`);
  const state = [...checked.bare.matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]);
  const calls = callArgs(modal, 'resolveDecisionAnswer');
  assert.ok(calls.length > 0, `${modal.path}: resolveDecisionAnswer is never called`);
  // The flag may travel from the button to the hook through a callback, so the
  // two ends are checked separately: the button hands the checkbox's value on,
  // and resolveDecisionAnswer receives a value rather than a constant.
  const carried = calls.some(args => {
    const second = secondArg(modal, args);
    if (second === null) return false;
    const text = modal.bare.slice(second.start, second.end);
    return /[A-Za-z_$]/.test(text) && !/^\s*(?:true|false)\s*$/.test(text);
  });
  assert.ok(carried, `${modal.path}: resolveDecisionAnswer's second argument must be the checkbox's value, not a constant`);
  // A helper the click calls counts only when it sits inside the component that
  // holds the checkbox state and so reads it by closure. A module-level helper
  // whose parameter merely shares the state's name (`function answer(e, id,
  // applyToAll)`) proves nothing: the click could pass `false` to it.
  const holders = state
    .map(name => new RegExp(`\\b(?:const|let)\\s*\\[\\s*${escapeName(name)}\\b`).exec(modal.bare))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => {
      const open = enclosingBrace(modal.bare, m.index);
      return open === -1 ? null : { start: open, end: matchBracket(modal.bare, open) };
    })
    .filter((s): s is Span => s !== null && s.end !== -1);
  const insideHolder = (span: Span) => holders.some(h => span.start >= h.start && span.end <= h.end);
  const buttons = [...modal.bare.matchAll(/<(?:button|IconButton)\b/g)].map(m => tagAt(modal, m.index));
  assert.ok(buttons.length > 0, `${modal.path}: no button answers the question`);
  for (const button of buttons) {
    const clicks = handlerBodies(modal, 'onClick').filter(h => h.at > button.start && h.at < button.end);
    const handsOn = clicks.some(h => h.spans.some((span, k) =>
      (k === 0 || insideHolder(span)) && mentions(modal.bare.slice(span.start, span.end), state)));
    assert.ok(handsOn,
      `${where(modal, button.start)}: the answer button must hand the checkbox's value (${state.join('.')}) on with the choice`);
  }
});

test('TC-REQ-FR-FEX-007-AC8-02 삭제 확인 분기에는 checkbox 가 없다', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(importedFrom(modal, MODEL_MODULE).includes('buildDeleteConfirmModal'), `${modal.path} must import buildDeleteConfirmModal from ./fileExplorerModalModel`);
  assert.ok(callArgs(modal, 'buildDeleteConfirmModal').length > 0, `${modal.path}: buildDeleteConfirmModal is never called — the delete confirm is not asked through the modal`);
  const boxes = checkboxTags(modal);
  assert.ok(boxes.length > 0, `${modal.path}: no checkbox at all — nothing here shows the delete branch leaves it out`);
  for (const box of boxes) {
    assert.ok(gatedByApplyToAll(modal, box.start), `${where(modal, box.start)}: a checkbox not gated on showApplyToAll would appear on the delete confirm too`);
  }
  assert.doesNotMatch(modal.code, /\srole\s*=\s*\{?\s*['"](?:checkbox|switch)['"]/, `${modal.path}: a hand-made checkbox (role="checkbox") escapes the showApplyToAll gate`);
});

test('TC-REQ-FR-FEX-007-AC6-02 결정 분기의 버튼이 buildDecisionModal(detail).choices 를 map 해서만 만들어진다 — 선택지 라벨·id 하드코딩 없음(서버가 [rename, skip] 만 보내는 in-place 충돌도 그대로 따른다)', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(importedFrom(modal, MODEL_MODULE).includes('buildDecisionModal'), `${modal.path} must import buildDecisionModal from ./fileExplorerModalModel`);
  assert.ok(callArgs(modal, 'buildDecisionModal').length > 0, `${modal.path}: buildDecisionModal is never called`);
  const maps = [...modal.bare.matchAll(/\.\s*choices\s*\.\s*map\s*\(/g)].map(m => {
    const open = m.index + m[0].length - 1;
    return { start: open, end: matchBracket(modal.bare, open) };
  });
  assert.ok(maps.length > 0, `${modal.path}: the buttons must be drawn by mapping the model's choices`);
  const buttons = [...modal.bare.matchAll(/<(?:button|IconButton)\b/g)].map(m => m.index);
  assert.equal(buttons.length, 1, `${modal.path}: expected one button element, inside the choices map — a hand-written button would offer a choice the server did not`);
  assert.ok(maps.some(span => buttons[0] > span.start && buttons[0] < span.end), `${where(modal, buttons[0])}: the button is not inside the choices map`);

  for (const label of ['덮어쓰기', '이름 바꾸기', '복사하지 않기', '무시', '재시도', '취소', '삭제']) {
    assert.ok(!modal.code.includes(label), `${modal.path}: hard-codes the label '${label}' — labels come from the model`);
  }
  assert.doesNotMatch(modal.code, /['"](?:overwrite|rename|skip|retry)['"]/, `${modal.path}: hard-codes a server choice id — the in-place conflict offers only [rename, skip], and the model is what knows`);
});

// ---------------------------------------------------------------------------
// FR-FEX-007 AC-5 · FR-FEX-005 AC-5 — the modal is the window's ConfirmPort and DecidePort
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-007-AC5-03 answerDecision 이 cancel-job 답을 fileJobApi.cancel(jobId) 로, decide 답을 fileJobApi.decide 로 보낸다', () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.match(modal.bare, /\bDecidePort\b/, `${modal.path}: the hook must provide a DecidePort`);
  assert.ok(importedFrom(modal, /^\.\/fileExplorerPorts(?:\.ts)?$/).includes('DecidePort'), `${modal.path} must take DecidePort from ./fileExplorerPorts`);

  const win = read(T.window);
  const d = derive(win, 'useFileExplorerWindowModal');
  const decides = [...win.bare.matchAll(/\bfileJobApi\s*\.\s*decide\s*\(/g)];
  assert.ok(decides.length > 0, `${win.path}: fileJobApi.decide is never called — a decision never reaches the server`);
  const ok = decides.some(m => {
    const fn = declarationHolding(win, m.index);
    if (fn === null) return false;
    const { code, bare } = slice(win, fn);
    if (!/['"]cancel-job['"]/.test(code)) return false;
    if (!/\bfileJobApi\s*\.\s*cancel\s*\(\s*[\w$.]*\bjobId\s*\)/.test(bare)) return false;
    // The question itself must be put to the window modal.
    return [...bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g)]
      .some(call => call[1] !== 'fileJobApi' && isDerived(d, fn.start, call[1]));
  });
  assert.ok(ok, `${win.path}: the decision handler must ask the window modal, send 'cancel-job' to fileJobApi.cancel(jobId) and a decision to fileJobApi.decide`);
});

test("TC-REQ-FR-FEX-005-AC5-02 requestDelete 에 넘기는 ConfirmPort 가 창 범위 모달의 confirm 이고, FileExplorerConfirmBar 의 FileExplorerPrompt 에 'confirm-delete'·'decide' 종류가 더는 없다(승계)", () => {
  requireSources(TARGETS);
  const modal = read(T.modal);
  assert.ok(importedFrom(modal, /^\.\/fileExplorerPorts(?:\.ts)?$/).includes('ConfirmPort'), `${modal.path} must take ConfirmPort from ./fileExplorerPorts`);

  requireSources([T.opsHook]);
  const win = read(T.window);
  const ops = read(T.opsHook);
  const modalNames = derive(win, 'useFileExplorerWindowModal');
  const barNames = derive(win, 'useFileExplorerConfirmBar');

  // useFileTreeOperations calls requestDelete with the confirm it was given,
  // untouched: its own `confirm` parameter, declared nowhere else.
  const opsFn = /\bexport\s+function\s+useFileTreeOperations\s*\(\s*\{/.exec(ops.bare);
  assert.ok(opsFn !== null, `${ops.path}: export function useFileTreeOperations({ … }) is gone`);
  const paramsOpen = opsFn.index + opsFn[0].length - 1;
  const params = ops.bare.slice(paramsOpen + 1, matchBracket(ops.bare, paramsOpen));
  assert.match(params, /(?:^|[,\s])confirm\s*(?:,|$)/, `${ops.path}: useFileTreeOperations must take confirm as its own parameter, unrenamed`);
  assert.doesNotMatch(ops.bare, /\b(?:const|let|var|function)\s+confirm\b|[{,]\s*confirm\s*[,}]\s*=(?!=)/, `${ops.path}: declares another confirm — requestDelete's could be something other than the one handed in`);
  const opsDeletes = callArgs(ops, 'requestDelete');
  assert.ok(opsDeletes.length > 0, `${ops.path}: requestDelete is never called`);
  for (const args of opsDeletes) {
    const value = propertyValue(ops, args, 'confirm');
    assert.ok(value !== null, `${where(ops, args.start)}: requestDelete gets no confirm`);
    assert.equal(ops.bare.slice(value.start, value.end).trim(), 'confirm', `${where(ops, value.start)}: requestDelete's confirm must be the confirm useFileTreeOperations was given`);
  }

  // The window hands it the window modal's ConfirmPort, never the confirm row's.
  const handed = callArgs(win, 'useFileTreeOperations');
  assert.ok(handed.length > 0, `${win.path}: useFileTreeOperations is never called — the panel deletes nothing`);
  // A requestDelete the window still calls itself is held to the same rule.
  for (const args of [...handed, ...callArgs(win, 'requestDelete')]) {
    const value = propertyValue(win, args, 'confirm');
    assert.ok(value !== null, `${where(win, args.start)}: gets no confirm`);
    const text = win.bare.slice(value.start, value.end);
    assert.ok(isDerived(modalNames, value.start, text), `${where(win, value.start)}: the delete confirm must be the window modal's ConfirmPort`);
    assert.ok(!isDerived(barNames, value.start, text), `${where(win, value.start)}: the delete confirm still comes from the in-window confirm row`);
  }

  const bar = read(T.confirmBar);
  assert.doesNotMatch(bar.code, /['"](?:confirm-delete|decide)['"]/, `${bar.path}: still asks a delete confirm or a job decision — those moved to the window modal`);
  assert.doesNotMatch(bar.bare, /\bConfirmPort\b|\bDecidePort\b|\bDecideAnswer\b/, `${bar.path}: still implements a ConfirmPort/DecidePort — it keeps only the folder-name prompt and the error line`);
});
