import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// CON-FEX-001 AC-3 · FR-FEX-001 AC-6 · FR-FEX-003 AC-4 · FR-FEX-005 AC-2/5/6/8 ·
// FR-FEX-006 AC-1/2/9 — how the explorer's context menu, clipboard, shortcuts,
// mobile button row and in-window confirm row are wired into the window.
//
// The decisions themselves (which menu, which selection, which shortcut) are
// pure functions with their own tests. What only source can show is that the
// window actually routes events through them, so these are source guards, and
// they are held to the two rules fileExplorerWiring.test.ts sets:
//
// - Prose and literals neither trip nor satisfy a check. The scanner (copied
//   from fileExplorerWiring.test.ts — importing a *.test.ts registers its tests
//   a second time) removes comments while respecting strings, templates, regex
//   literals and JSX text, and gives a view with every literal blanked.
// - No empty sets. Every target is named, and its existence is asserted before
//   anything is said about its contents. Two of them — FileExplorerMobileBar.tsx
//   and FileExplorerConfirmBar.tsx — are created by the wiring step, so their
//   absence is a failure, never a pass.
//
// Names that the wiring step is free to choose (a state setter, a prop name)
// are matched by shape, not pinned; names that come from the decision modules
// (resolveContextMenuTarget, decideContextMenuSelection, decideRowPointer,
// buildFileExplorerContextMenuItems, buildMobileActionButtons,
// createFileExplorerShortcutHandler, registerFileJobHandler) are pinned,
// because routing through exactly those is the contract.

const SRC_DIR = new URL('../../src/', import.meta.url);
const FX = 'components/fileExplorer/';

const T = {
  window: `${FX}FileExplorerWindow.tsx`,
  tabBar: `${FX}FileExplorerTabBar.tsx`,
  pathBar: `${FX}FileExplorerPathBar.tsx`,
  treeView: `${FX}FileTreeView.tsx`,
  listView: `${FX}FileListView.tsx`,
  mobileBar: `${FX}FileExplorerMobileBar.tsx`,
  confirmBar: `${FX}FileExplorerConfirmBar.tsx`,
  css: `${FX}FileExplorer.css`,
  windowsHook: 'hooks/useFileExplorerWindows.ts',
  // The explorer tab panel's file operations — menu, rename, new-tab entry —
  // moved here so the editor's tree pane shares them (FR-MDE-012 AC-8).
  opsHook: 'hooks/useFileTreeOperations.ts',
  tokens: 'styles/tokens.css',
} as const;

// Held as a list rather than globbed so that the set can never come out empty.
const EXPLORER_TSX = [T.window, T.tabBar, T.pathBar, T.treeView, T.listView, T.mobileBar, T.confirmBar] as const;
const VIEWS = [T.treeView, T.listView] as const;

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

/** Every .ts/.tsx under components/fileExplorer/, recursively. */
function explorerTree(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(rel, SRC_DIR), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
      else if (/\.tsx?$/.test(entry.name)) out.push(`${rel}${entry.name}`);
    }
  };
  walk(FX);
  return out;
}

function explorerTsxAll(): string[] {
  return [...new Set([...EXPLORER_TSX, ...explorerTree().filter(p => p.endsWith('.tsx'))])];
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

/** Whether `text` refers to `id`, directly or through one local definition. */
function refersTo(src: Lexed, text: string, id: string): boolean {
  if (new RegExp(`\\b${id}\\b`).test(text)) return true;
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const def = definitionOf(src, m[1]);
    if (def && new RegExp(`\\b${id}\\b`).test(src.bare.slice(def.start, def.end))) return true;
  }
  return false;
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

/** Every opening tag in the file: `<name ...>` where name starts with a letter. */
function allTags(src: Lexed): Span[] {
  return [...src.bare.matchAll(/<[A-Za-z][\w.]*/g)].map(m => tagAt(src, m.index));
}

/** The tag whose attribute list holds `index`. */
function tagHolding(src: Lexed, index: number): Span | null {
  const open = src.bare.lastIndexOf('<', index);
  return open === -1 ? null : tagAt(src, open);
}

function matchBracketBack(bare: string, close: number): number {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let depth = 0;
  for (let k = close; k >= 0; k -= 1) {
    const c = bare[k];
    if (c in pairs) depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** The body of the innermost function (arrow, declaration or method) enclosing `index`. */
function enclosingFunction(src: Lexed, index: number): Span | null {
  let at = index;
  for (;;) {
    const open = enclosingBrace(src.bare, at);
    if (open === -1) return null;
    const before = src.bare.slice(0, open).trimEnd();
    let isFunction = before.endsWith('=>');
    if (!isFunction && before.endsWith(')')) {
      const paren = matchBracketBack(src.bare, before.length - 1);
      const word = /([A-Za-z_$][\w$]*)\s*$/.exec(src.bare.slice(0, paren))?.[1] ?? '';
      isFunction = !/^(?:if|for|while|switch|catch|with)$/.test(word);
    }
    if (isFunction) return { start: open, end: matchBracket(src.bare, open) + 1 };
    at = open - 1;
  }
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

interface Located { src: Lexed; span: Span }

/**
 * Handler spans plus, one hop further, the bodies wired to the `onX` props they
 * call: a view that forwards `onRowContextMenu(event, row)` is judged by what
 * the window passes as `onRowContextMenu={...}`.
 */
function follow(files: readonly Lexed[], src: Lexed, spans: readonly Span[]): Located[] {
  const out: Located[] = spans.map(span => ({ src, span }));
  const text = spansText(src, [...spans]).bare;
  const names = new Set([...text.matchAll(/\b(on[A-Z][\w$]*)\s*(?:\?\.\s*)?\(/g)].map(m => m[1]));
  for (const name of names) {
    for (const file of files) {
      for (const h of handlerBodies(file, name)) out.push(...h.spans.map(span => ({ src: file, span })));
    }
  }
  return out;
}

/** The value of `key` in the object literal at `args`: `key: value` or the shorthand `key`. */
function propertyValueOf(src: Lexed, args: Span, key: string): Span | null {
  const text = src.bare.slice(args.start, args.end);
  const m = new RegExp(`(?:^|[{,\\s])${key}\\s*(:|,|\\})`).exec(text);
  if (m === null) return null;
  const keyEnd = args.start + m.index + m[0].length - 1;
  if (m[1] !== ':') return { start: keyEnd - key.length, end: keyEnd };
  let k = keyEnd + 1;
  while (/\s/.test(src.bare[k])) k += 1;
  return readExpression(src.bare, k);
}

/**
 * `follow`, plus one hop through useFileTreeOperations: an `onX(` called inside
 * the hook is the `onX` its callers pass in `useFileTreeOperations({ onX: … })`,
 * just as a view's `onX(` is the window's `onX={…}`.
 */
function followThroughOps(files: readonly Lexed[], src: Lexed, spans: readonly Span[]): Located[] {
  const out = follow(files, src, spans);
  if (src.path !== `src/${T.opsHook}`) return out;
  const text = spansText(src, [...spans]).bare;
  const names = new Set([...text.matchAll(/\b(on[A-Z][\w$]*)\s*(?:\?\.\s*)?\(/g)].map(m => m[1]));
  for (const name of names) {
    for (const file of files) {
      for (const call of callArgs(file, 'useFileTreeOperations')) {
        const value = propertyValueOf(file, call, name);
        if (value !== null) out.push(...expand(file, value).map(span => ({ src: file, span })));
      }
    }
  }
  return out;
}

function locatedText(located: readonly Located[], view: 'code' | 'bare'): string {
  return located.map(l => l.src[view].slice(l.span.start, l.span.end)).join('\n');
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

/** A length in px, following one var() into the given custom property sources. */
function pxOf(value: string, sources: readonly string[]): number | null {
  const px = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value);
  if (px) return Number(px[1]);
  const v = /^\s*var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)\s*$/.exec(value);
  if (!v) return null;
  for (const css of sources) {
    const def = new RegExp(`${v[1]}\\s*:\\s*([^;]+);`).exec(css);
    if (def) return pxOf(def[1], []);
  }
  return v[2] === undefined ? null : pxOf(v[2], []);
}

// `?.(` counts: an optional prop callback is still the call that opens the menu.
const MENU_OPEN_CALL = /\b(?:set|open|on)[\w$]*Menu[\w$]*\s*(?:\?\.\s*)?\(/;
const REACHES_NEW_TAB = /\b(?:addTab|openInNewTab)\s*\(/;

// ---------------------------------------------------------------------------
// CON-FEX-001 AC-3 — '..' is chrome, never a target
// ---------------------------------------------------------------------------

test('TC-REQ-CON-FEX-001-AC3-02 DR-09: up 행 분기가 data-path·onContextMenu 없이 data-up 만 갖고, 선택·메뉴·클립보드·Delete 처리기는 data-path 로만 대상을 푼다', () => {
  requireSources([T.window, ...VIEWS]);
  for (const path of VIEWS) {
    const view = read(path);
    const upTags = allTags(view).filter(tag => /\sdata-up\s*=/.test(view.bare.slice(tag.start, tag.end)));
    assert.ok(upTags.length > 0, `${view.path}: the '..' row (data-up) is no longer drawn`);
    for (const tag of upTags) {
      const text = view.bare.slice(tag.start, tag.end);
      for (const attr of ['data-path', 'onContextMenu', 'onClick', 'onPointerDown', 'onMouseDown', 'onTouchStart']) {
        assert.doesNotMatch(text, new RegExp(`\\s${attr}\\s*=`), `${where(view, tag.start)}: the '..' row carries ${attr} — it would become a target`);
      }
      // A spread is how long-press handlers reach a row; on '..' it would give it a menu.
      assert.doesNotMatch(text, /\{\s*\.\.\./, `${where(view, tag.start)}: the '..' row spreads props — long-press handlers would land on it`);
    }
    assert.ok(handlerBodies(view, 'onContextMenu').length > 0, `${view.path}: no onContextMenu handler — the context menu is not wired into this view`);
  }
  // Every handler that picks a target resolves it from data-path (directly or
  // through resolveContextMenuTarget); none reads the '..' marker to act on it.
  for (const path of [T.window, ...VIEWS]) {
    const src = read(path);
    for (const attr of ['onContextMenu', 'onKeyDown', 'onClick']) {
      for (const h of handlerBodies(src, attr)) {
        assert.doesNotMatch(spansText(src, h.spans).code, /data-up|dataset\s*\.\s*up\b/,
          `${where(src, h.at)}: ${attr} resolves a target through the '..' row`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-006 — context menu
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-006-AC9-01 메뉴 배선이 components/ContextMenu/ContextMenu 의 ContextMenu 와 hooks/useLongPress 를 import 해 쓰고 재구현하지 않는다', () => {
  requireSources([...EXPLORER_TSX, T.opsHook]);
  const files = explorerTsxAll().map(read);

  // The menu's items come from buildFileExplorerContextMenuItems, directly or
  // as useFileTreeOperations' menuItems — which the hook must build with it.
  const ops = read(T.opsHook);
  const opsBuildsMenu = importedFrom(ops, /^\.\.\/components\/fileExplorer\/fileExplorerContextMenu(?:\.ts)?$/).includes('buildFileExplorerContextMenuItems')
    && refersTo(ops, 'menuItems', 'buildFileExplorerContextMenuItems')
    && /\breturn\s*\{[^}]*\bmenuItems\b[^}]*\}/.test(ops.bare);
  const menuUsers = files.filter(f => importedFrom(f, /^\.\.\/ContextMenu(?:\/ContextMenu(?:\.tsx)?|\/index(?:\.ts)?)?$/).includes('ContextMenu'));
  assert.ok(menuUsers.length > 0, 'no explorer component imports ContextMenu from ../ContextMenu/ContextMenu');
  let rendered = 0;
  for (const f of menuUsers) {
    let viaOps = false;
    for (const tag of openingTags(f, 'ContextMenu')) {
      rendered += 1;
      const items = attrValue(f, tag, 'items');
      assert.ok(items !== null, `${where(f, tag.start)}: <ContextMenu> has no items`);
      const direct = refersTo(f, items.bare, 'buildFileExplorerContextMenuItems');
      const fromOps = /\.\s*menuItems\b/.test(items.bare) && refersTo(f, items.bare, 'useFileTreeOperations');
      if (fromOps) {
        viaOps = true;
        assert.ok(opsBuildsMenu, `${ops.path}: menuItems must be built with buildFileExplorerContextMenuItems imported from ../components/fileExplorer/fileExplorerContextMenu and returned`);
      }
      assert.ok(direct || fromOps,
        `${where(f, tag.start)}: <ContextMenu items> must come from buildFileExplorerContextMenuItems (directly or as useFileTreeOperations' menuItems)`);
    }
    if (openingTags(f, 'ContextMenu').length > 0) {
      if (viaOps) {
        assert.ok(importedFrom(f, /^\.\.\/\.\.\/hooks\/useFileTreeOperations(?:\.ts)?$/).includes('useFileTreeOperations'),
          `${f.path} must import useFileTreeOperations from ../../hooks/useFileTreeOperations`);
      } else {
        assert.ok(importedFrom(f, /^\.\/fileExplorerContextMenu(?:\.ts)?$/).includes('buildFileExplorerContextMenuItems'),
          `${f.path} must import buildFileExplorerContextMenuItems from ./fileExplorerContextMenu`);
      }
    }
  }
  assert.ok(rendered > 0, 'ContextMenu is imported but never rendered');

  const pressUsers = files.filter(f => importedFrom(f, /^\.\.\/\.\.\/hooks\/useLongPress(?:\.ts)?$/).includes('useLongPress'));
  assert.ok(pressUsers.length > 0, 'no explorer component imports useLongPress from ../../hooks/useLongPress');
  assert.ok(pressUsers.some(f => callArgs(f, 'useLongPress').length > 0), 'useLongPress is imported but never called');

  // A second menu or a hand-rolled long press is what "reuse" rules out.
  for (const rel of explorerTree()) {
    const f = read(rel);
    assert.doesNotMatch(f.code, /\brole\s*=\s*\{?\s*['"]menu(?:item)?['"]/, `${f.path}: draws its own menu (role="menu")`);
    assert.doesNotMatch(f.bare, /\b(?:function|const|let|class)\s+ContextMenu\b/, `${f.path}: declares its own ContextMenu`);
    assert.doesNotMatch(f.bare, /\bnavigator\s*\.\s*vibrate\b/, `${f.path}: re-implements long-press feedback`);
    for (const attr of ['onTouchStart', 'onPointerDown']) {
      for (const h of handlerBodies(f, attr)) {
        assert.doesNotMatch(spansText(f, h.spans).bare, /\bsetTimeout\s*\(/, `${where(f, h.at)}: ${attr} times a press itself — use useLongPress`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-003 AC-4 — one way to open a tab
// ---------------------------------------------------------------------------

test("TC-REQ-FR-FEX-003-AC4-02 탭 막대 더하기 버튼과 메뉴 '새 탭에서 열기' 가 모두 openInNewTab 을 부른다", () => {
  requireSources([...EXPLORER_TSX, T.windowsHook, T.opsHook]);
  const hook = read(T.windowsHook);
  const addTab = definitionOf(hook, 'addTab');
  assert.ok(addTab !== null, `${hook.path}: addTab is not defined`);
  assert.match(hook.bare.slice(addTab.start, addTab.end), /\bopenInNewTab\s*\(/, `${hook.path}: addTab must open the tab with openInNewTab`);

  // The menu is built in useFileTreeOperations; its '새 탭에서 열기' calls the
  // onNewTab the panel hands it, followed one hop by followThroughOps.
  const files = [...explorerTsxAll().map(read), read(T.opsHook)];
  const win = files.find(f => f.path === `src/${T.window}`)!;
  const onAdd = handlerBodies(win, 'onAdd');
  assert.equal(onAdd.length, 1, `${win.path}: expected one onAdd on the tab bar`);
  assert.match(locatedText(follow(files, win, onAdd[0].spans), 'bare'), REACHES_NEW_TAB,
    `${where(win, onAdd[0].at)}: the tab bar's + must reach addTab/openInNewTab`);

  const builds = files.flatMap(f => callArgs(f, 'buildFileExplorerContextMenuItems').map(args => ({ f, args })));
  assert.ok(builds.length > 0, 'buildFileExplorerContextMenuItems is never called — there is no menu to hold "새 탭에서 열기"');
  for (const { f, args } of builds) {
    const handlersArg = secondArg(f, args);
    assert.ok(handlersArg !== null, `${where(f, args.start)}: buildFileExplorerContextMenuItems gets no handlers`);
    // The handlers object, or the definition of the name passed.
    const text = f.bare.slice(handlersArg.start, handlersArg.end);
    const named = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(text);
    const obj = named ? definitionOf(f, named[1], handlersArg.start) : handlersArg;
    assert.ok(obj !== null, `${where(f, args.start)}: the handlers passed to the menu builder are not defined in ${f.path}`);
    const key = /(?:^|[{,\s])([\w$]*[Nn]ew[Tt]ab[\w$]*)\s*(?=[:,}(])/.exec(f.bare.slice(obj.start, obj.end));
    assert.ok(key !== null, `${where(f, obj.start)}: the menu handlers have no new-tab entry`);
    const at = obj.start + key.index + key[0].length;
    let k = at;
    while (/\s/.test(f.bare[k])) k += 1;
    let value: Span;
    if (f.bare[k] === ':') value = readExpression(f.bare, k + 1);
    else if (f.bare[k] === '(') {
      const brace = f.bare.indexOf('{', matchBracket(f.bare, k));
      value = { start: brace, end: matchBracket(f.bare, brace) + 1 };
    } else value = definitionOf(f, key[1], obj.start) ?? { start: at - key[1].length, end: at };
    assert.match(locatedText(followThroughOps(files, f, expand(f, value)), 'bare'), REACHES_NEW_TAB,
      `${where(f, value.start)}: '새 탭에서 열기' must reach addTab/openInNewTab, the same path as the tab bar's +`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-005 — clipboard, shortcuts, confirm row, mobile buttons
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-005-AC2-02 행 className 이 rowRenderClass(row, clipboard) 를 쓰고 CSS .fx-row.cut 이 opacity 로 흐리게 한다', () => {
  requireSources([T.window, ...VIEWS, T.css]);
  for (const path of VIEWS) {
    const view = read(path);
    assert.match(view.bare, /\browRenderClass\s*\(\s*\w+\s*,\s*clipboard\s*\)/, `${view.path}: rows must be classed with rowRenderClass(row, clipboard)`);
  }
  // The views default clipboard to null; dimming happens only if the window
  // hands them the shared clipboard.
  const win = read(T.window);
  const clipboardNames = importedFrom(win, /^\.\/fileExplorerClipboard(?:\.ts)?$/);
  assert.ok(clipboardNames.length > 0, `${win.path} must read the shared clipboard from ./fileExplorerClipboard`);
  for (const name of ['FileTreeView', 'FileListView']) {
    const tags = openingTags(win, name);
    assert.ok(tags.length > 0, `${win.path}: <${name}> is not rendered`);
    for (const tag of tags) {
      const value = attrValue(win, tag, 'clipboard');
      assert.ok(value !== null, `${where(win, tag.start)}: <${name}> gets no clipboard, so cut rows are never dimmed`);
      assert.ok(clipboardNames.some(id => refersTo(win, value.bare, id)),
        `${where(win, tag.start)}: <${name} clipboard> does not come from ./fileExplorerClipboard`);
    }
  }
  const cut = cssRules(readCss(T.css)).filter(r => r.selector.split(',').some(s => /^\.fx-row\.cut$/.test(s.trim())));
  assert.equal(cut.length, 1, `${T.css}: expected one .fx-row.cut rule`);
  const opacity = /(?:^|;)\s*opacity\s*:\s*([\d.]+)\s*(?:;|$)/.exec(cut[0].body);
  assert.ok(opacity !== null && Number(opacity[1]) < 1, `${T.css}: .fx-row.cut must dim with opacity < 1`);
});

test('TC-REQ-FR-FEX-005-AC6-02 keydown 처리기가 창 표면 루트에 붙고 focusedInSurface 를 contains(document.activeElement) 로 판정한다 — document/window 전역 리스너 없음', () => {
  requireSources([T.window]);
  const win = read(T.window);
  const dialogs = openingTags(win, 'WindowDialog');
  assert.equal(dialogs.length, 1, `${win.path}: expected one <WindowDialog>`);
  const childAt = /<[A-Za-z]/.exec(win.bare.slice(dialogs[0].end));
  assert.ok(childAt !== null, `${where(win, dialogs[0].start)}: <WindowDialog> has no child element`);
  const root = tagAt(win, dialogs[0].end + childAt.index);
  const keyDown = /\sonKeyDown\s*=\s*\{/.exec(win.bare.slice(root.start, root.end));
  assert.ok(keyDown !== null, `${where(win, root.start)}: the window surface root (the first child of <WindowDialog>) has no onKeyDown`);
  const open = root.start + keyDown.index + keyDown[0].length - 1;
  const spans = expand(win, { start: open + 1, end: matchBracket(win.bare, open) });

  assert.ok(importedFrom(win, /^\.\/fileExplorerShortcuts(?:\.ts)?$/).includes('createFileExplorerShortcutHandler'),
    `${win.path} must import createFileExplorerShortcutHandler from ./fileExplorerShortcuts`);
  const created = callArgs(win, 'createFileExplorerShortcutHandler');
  assert.ok(created.length > 0, `${win.path}: createFileExplorerShortcutHandler is never called`);
  const keyText = spansText(win, spans).bare;
  assert.ok(/\bcreateFileExplorerShortcutHandler\s*\(/.test(keyText) || refersTo(win, keyText, 'createFileExplorerShortcutHandler'),
    `${where(win, root.start)}: the surface onKeyDown does not run the handler createFileExplorerShortcutHandler made`);
  // Focus is judged by containment in this surface, so a terminal's Ctrl+C is
  // never taken (DR-16).
  const judged = [spansText(win, spans).bare, ...created.map(args => spansText(win, expand(win, args)).bare)].join('\n');
  assert.match(judged, /\.\s*contains\s*\(\s*document\s*\.\s*activeElement\s*\)/,
    `${win.path}: focusedInSurface must be decided by <surface>.contains(document.activeElement)`);

  for (const rel of [...explorerTree(), T.windowsHook]) {
    const f = read(rel);
    assert.doesNotMatch(f.code, /\baddEventListener\s*\(\s*['"]key(?:down|up|press)['"]/, `${f.path}: a global key listener — keys must be taken on the window surface only`);
    assert.doesNotMatch(f.bare, /\.\s*onkey(?:down|up|press)\s*=/, `${f.path}: assigns a global key handler`);
  }
});

test('TC-REQ-FR-FEX-005-AC8-02 DR-13: 모바일 버튼 줄이 buildMobileActionButtons 를 map 하고 CSS 버튼 min-height >= 44px', () => {
  requireSources([T.mobileBar, T.window, T.css]);
  const bar = read(T.mobileBar);
  assert.ok(importedFrom(bar, /^\.\/fileExplorerContextMenu(?:\.ts)?$/).includes('buildMobileActionButtons'),
    `${bar.path} must import buildMobileActionButtons from ./fileExplorerContextMenu`);
  const calls = callArgs(bar, 'buildMobileActionButtons');
  assert.ok(calls.length > 0, `${bar.path}: buildMobileActionButtons is never called`);
  const mapped = calls.some(args => {
    const after = bar.bare.slice(args.end + 1);
    if (/^\s*\.\s*map\s*\(/.test(after)) return true;
    const decl = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:useMemo\s*\(\s*\(\s*\)\s*=>\s*)?$/.exec(bar.bare.slice(0, args.start).replace(/buildMobileActionButtons\s*\($/, ''));
    return decl !== null && new RegExp(`\\b${decl[1]}\\s*\\.\\s*map\\s*\\(`).test(bar.bare);
  });
  assert.ok(mapped, `${bar.path}: the buttons must be drawn by mapping buildMobileActionButtons(...)`);
  const buttons = [...bar.bare.matchAll(/<(?:button|IconButton)\b/g)].map(m => tagAt(bar, m.index));
  assert.equal(buttons.length, 1, `${bar.path}: expected one button element, inside the map — a hand-written button would bypass the shared predicates`);
  assert.ok(attrValue(bar, buttons[0], 'disabled') !== null, `${where(bar, buttons[0].start)}: the button must carry disabled from the builder`);

  const win = read(T.window);
  const barTags = openingTags(win, 'FileExplorerMobileBar');
  assert.ok(barTags.length > 0, `${win.path}: <FileExplorerMobileBar> is not rendered`);
  assert.match(win.code, /\{[^}]*\bisMobile\b[^}]*\}\s*=\s*useResponsive\s*\(/, `${win.path}: isMobile must come from useResponsive()`);
  for (const tag of barTags) {
    assert.match(win.bare.slice(Math.max(0, tag.start - 80), tag.start), /\bisMobile\b[^;]*?(?:&&|\?)\s*\(?\s*$/,
      `${where(win, tag.start)}: the mobile bar must render only when isMobile`);
  }

  const className = attrValue(bar, buttons[0], 'className');
  assert.ok(className !== null, `${where(bar, buttons[0].start)}: the button has no className to style`);
  const classes = [...className.code.matchAll(/\bfx-[\w-]+/g)].map(m => m[0]);
  assert.ok(classes.length > 0, `${where(bar, buttons[0].start)}: the button has no fx- class`);
  const css = readCss(T.css);
  const sources = [css, readCss(T.tokens)];
  const heights = cssRules(css)
    .filter(r => classes.some(c => new RegExp(`\\.${c}(?![\\w-])`).test(r.selector)))
    .map(r => /(?:^|;)\s*min-height\s*:\s*([^;]+)/.exec(r.body)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(v => pxOf(v, sources));
  assert.ok(heights.some(h => h !== null && h >= 44), `${T.css}: the mobile button (${classes.join(', ')}) needs min-height >= 44px; found ${JSON.stringify(heights)}`);
});

test('TC-REQ-FR-FEX-005-AC5-02 DR-12: 확인 줄이 창 콘텐츠 안에 렌더되고 dialogStack/WindowDialog modal 등록·createPortal 을 쓰지 않는다; F2 는 useInlineRename 경유 fileApi.moveFile', () => {
  requireSources([...EXPLORER_TSX]);
  const bar = read(T.confirmBar);
  for (const [re, what] of [
    [/\bcreatePortal\b/, 'createPortal'],
    [/\buseDialogStack\b|\bregisterDialogStackEntry\b/, 'the dialog stack'],
    [/<WindowDialog\b|<MessageBox\b/, 'a dialog component'],
  ] as const) assert.doesNotMatch(bar.bare, re, `${bar.path}: uses ${what} — the confirm row must stay inside the window and block nothing else`);
  assert.doesNotMatch(bar.code, /from\s*['"]\.\.\/dialog(?:\/|['"])/, `${bar.path}: imports from ../dialog`);

  const win = read(T.window);
  assert.doesNotMatch(win.bare, /\bcreatePortal\b|\buseDialogStack\b|\bregisterDialogStackEntry\b/, `${win.path}: registers with the dialog stack or portals itself`);
  const dialogs = openingTags(win, 'WindowDialog');
  assert.equal(dialogs.length, 1, `${win.path}: expected one <WindowDialog>`);
  assert.equal(attrValue(win, dialogs[0], 'mode')?.code, '"modeless"', `${where(win, dialogs[0].start)}: the explorer window must stay modeless`);
  const close = win.bare.indexOf('</WindowDialog>', dialogs[0].end);
  const windowFn = /\bexport\s+function\s+FileExplorerWindow\b/.exec(win.bare);
  const confirmTags = openingTags(win, 'FileExplorerConfirmBar');
  assert.ok(confirmTags.length > 0, `${win.path}: <FileExplorerConfirmBar> is not rendered`);
  for (const tag of confirmTags) {
    const insideDialog = tag.start > dialogs[0].end && tag.start < close;
    const insidePanel = windowFn !== null && tag.start < windowFn.index;
    assert.ok(insideDialog || insidePanel, `${where(win, tag.start)}: the confirm row is rendered outside the window's content`);
  }

  // Inline rename is one of the file operations useFileTreeOperations holds;
  // from hooks/ it imports useInlineRename as ./useInlineRename.
  requireSources([T.opsHook]);
  const files = [...explorerTsxAll().map(read), read(T.opsHook)];
  const renamers = files.filter(f => importedFrom(f, f.path === `src/${T.opsHook}`
    ? /^\.\/useInlineRename(?:\.ts)?$/
    : /^\.\.\/\.\.\/hooks\/useInlineRename(?:\.ts)?$/).includes('useInlineRename'));
  assert.ok(renamers.length > 0, 'neither an explorer component nor useFileTreeOperations imports useInlineRename');
  let movesFile = false;
  for (const f of renamers) {
    for (const args of callArgs(f, 'useInlineRename')) {
      const arg = firstArg(f, args);
      const text = f.bare.slice(arg.start, arg.end);
      const named = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(text);
      const obj = named ? definitionOf(f, named[1], arg.start) : arg;
      if (obj === null) continue;
      const onRename = /(?:^|[{,\s])onRename\b/.exec(f.bare.slice(obj.start, obj.end));
      if (onRename === null) continue;
      if (/\bfileApi\s*\.\s*moveFile\s*\(/.test(locatedText(follow(files, f, expand(f, obj)), 'bare'))) movesFile = true;
    }
    assert.match(f.bare, /\bstartEdit\s*\(|\.\s*startEdit\b/, `${f.path}: useInlineRename is set up but its startEdit is never used — F2/'이름 바꾸기' cannot start a rename`);
  }
  assert.ok(movesFile, 'useInlineRename onRename must commit through fileApi.moveFile');
});

// ---------------------------------------------------------------------------
// FR-FEX-006 AC-1/2 · CON-FEX-001 AC-3 — how a right click and a long press land
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-006-AC1-02 행 onContextMenu 가 decideContextMenuSelection 결과를 dispatch 한 뒤 메뉴를 연다', () => {
  requireSources(EXPLORER_TSX);
  const files = explorerTsxAll().map(read);
  for (const path of VIEWS) {
    const view = files.find(f => f.path === `src/${path}`)!;
    const handlers = handlerBodies(view, 'onContextMenu');
    assert.ok(handlers.length > 0, `${view.path}: no onContextMenu handler`);
    const located = handlers.flatMap(h => follow(files, view, h.spans));
    const deciding = located.filter(l => /\bdecideContextMenuSelection\s*\(/.test(l.src.bare.slice(l.span.start, l.span.end)));
    assert.ok(deciding.length > 0, `${view.path}: the context menu path never calls decideContextMenuSelection`);
    const ordered = deciding.some(({ src, span }) => {
      const text = src.bare.slice(span.start, span.end);
      const decide = /\bdecideContextMenuSelection\s*\(/.exec(text)!;
      const assigned = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*$/.exec(text.slice(0, decide.index))?.[1];
      const rest = text.slice(decide.index);
      const dispatch = /\bdispatch\s*\(/.exec(rest);
      if (dispatch === null) return false;
      const openMenu = MENU_OPEN_CALL.exec(rest.slice(dispatch.index));
      if (openMenu === null) return false;
      // Opened before the selection settles, the menu would act on the old one.
      const firstOpen = MENU_OPEN_CALL.exec(text);
      if (firstOpen !== null && firstOpen.index < decide.index + dispatch.index) return false;
      // The dispatch must act on the decision, not merely come after it.
      const between = rest.slice(0, matchBracket(rest, dispatch.index + dispatch[0].length - 1) + 1);
      return assigned !== undefined && new RegExp(`\\b${assigned}\\b`).test(between.slice(decide[0].length));
    });
    assert.ok(ordered, `${view.path}: decideContextMenuSelection's result must be dispatched, and only then the menu opened`);
  }
});

test('TC-REQ-FR-FEX-006-AC2-03 길게 누르기 시작과 행 포인터 처리가 decideRowPointer 를 거친다 — 선택 변경 경로가 그 함수 밖에 없다', () => {
  requireSources(EXPLORER_TSX);
  const files = explorerTsxAll().map(read);
  const presses = files.flatMap(f => callArgs(f, 'useLongPress').map(args => ({ f, args })));
  assert.ok(presses.length > 0, 'useLongPress is never called — a long press opens nothing');
  for (const { f, args } of presses) {
    const callback = firstArg(f, args);
    assert.match(locatedText(follow(files, f, expand(f, callback)), 'bare'), /\bdecideRowPointer\s*\(/,
      `${where(f, args.start)}: the long-press callback does not go through decideRowPointer`);
  }
  // Every selection change sits in a function that decided it.
  for (const path of [T.window, ...VIEWS]) {
    const src = files.find(f => f.path === `src/${path}`)!;
    for (const args of callArgs(src, 'dispatch')) {
      if (!/\btype\s*:\s*['"](?:CLICK_ROW|CLEAR_SELECTION)['"]/.test(src.code.slice(args.start, args.end))) continue;
      const fn = enclosingFunction(src, args.start);
      assert.ok(fn !== null, `${where(src, args.start)}: a selection change outside any function`);
      assert.match(src.bare.slice(fn.start, fn.end), /\bdecide(?:RowPointer|ContextMenuSelection)\s*\(/,
        `${where(src, args.start)}: changes the selection without decideRowPointer/decideContextMenuSelection`);
    }
  }
});

test('TC-REQ-CON-FEX-001-AC3-05 뷰 컨테이너 onContextMenu 가 resolveContextMenuTarget 을 쓰고 none 이면 preventDefault 후 메뉴를 열지 않는다', () => {
  requireSources([...VIEWS]);
  for (const path of VIEWS) {
    const view = read(path);
    const containers = handlerBodies(view, 'onContextMenu').filter(h => {
      const tag = tagHolding(view, h.at);
      return tag !== null && !/\sdata-path\s*=/.test(view.bare.slice(tag.start, tag.end));
    });
    assert.ok(containers.length > 0, `${view.path}: no container-level onContextMenu (one not on a data-path row)`);
    const ok = containers.some(h => h.spans.some(span => {
      const text = view.bare.slice(span.start, span.end);
      if (!/\bresolveContextMenuTarget\s*\(/.test(text) && !h.spans.some(s => /\bresolveContextMenuTarget\s*\(/.test(view.bare.slice(s.start, s.end)))) return false;
      for (const m of text.matchAll(/\bif\s*\(/g)) {
        const condOpen = span.start + m.index + m[0].length - 1;
        const condClose = matchBracket(view.bare, condOpen);
        if (!/\.\s*kind\s*===\s*['"]none['"]/.test(view.code.slice(condOpen, condClose + 1))) continue;
        let k = condClose + 1;
        while (/\s/.test(view.bare[k])) k += 1;
        const end = view.bare[k] === '{' ? matchBracket(view.bare, k) + 1 : view.bare.indexOf(';', k) + 1;
        const consequent = view.bare.slice(k, end);
        return /\bpreventDefault\s*\(/.test(consequent) && /\breturn\b/.test(consequent) && !MENU_OPEN_CALL.test(consequent);
      }
      return false;
    }));
    assert.ok(ok, `${view.path}: the container onContextMenu must resolve with resolveContextMenuTarget and, for 'none', preventDefault and return without opening a menu`);
    assert.ok(importedFrom(view, /^\.\/fileRowInteraction(?:\.ts)?$/).includes('resolveContextMenuTarget'),
      `${view.path} must import resolveContextMenuTarget from ./fileRowInteraction`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-001 AC-6 — a finished job refreshes the tab that shows it
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-001-AC6-07 창이 registerFileJobHandler 로 받은 invalidate 를 해당 세션 탭의 controller.applyJobDone 에 넘긴다', () => {
  requireSources([T.window]);
  const win = read(T.window);
  const registrations = callArgs(win, 'registerFileJobHandler');
  assert.ok(registrations.length > 0, `${win.path}: registerFileJobHandler is never called — finished jobs refresh nothing`);
  const ok = registrations.some(args => {
    const text = spansText(win, expand(win, args));
    return /\bapplyJobDone\s*\(/.test(text.bare)
      && /['"]invalidate['"]/.test(text.code)
      && /\bsessionId\s*[!=]==|[!=]==\s*[\w$.]*\bsessionId\b/.test(text.bare);
  });
  assert.ok(ok, `${win.path}: the file-job handler must route 'invalidate' to applyJobDone of the tab whose sessionId matches`);
});
