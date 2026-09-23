import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// FR-FEX-002 AC-1/2/8 · FR-FEX-003 AC-1/2/3/5/6/9/10 · FR-FEX-010 AC-5/6 ·
// FR-FEX-011 AC-1/2/4/5 · SEC-FOP-001 AC-3/5 — how the explorer window, its
// views and its three entry points are wired.
//
// There is no DOM harness in this repository, so wiring is judged from source.
// Two things make a source guard lie, and both are closed here:
//
// - Prose and literals. A comment that says "never call readFile here", or a
//   string that happens to contain a token, must neither trip nor satisfy a
//   check. The scanner below removes comments while respecting strings,
//   template literals and regex literals, and gives a second view with the
//   contents of every literal blanked. Structural checks (calls, handlers,
//   identifiers) read the blanked view; checks about an attribute value read
//   the view that keeps literals. Both views keep every offset, so a failure
//   can name a line.
// - Empty sets. "No file references X" is vacuously true of a file that does
//   not exist. Every target is named in a constant and its existence is
//   asserted first, by exact directory entry (the checkout lives on a
//   case-insensitive filesystem, where existsSync('FileListView.tsx') would not
//   distinguish it from a differently cased neighbour).

const SRC_DIR = new URL('../../src/', import.meta.url);
const FRONTEND_DIR = new URL('../../', import.meta.url);
const FX = 'components/fileExplorer/';

const T = {
  window: `${FX}FileExplorerWindow.tsx`,
  tabBar: `${FX}FileExplorerTabBar.tsx`,
  pathBar: `${FX}FileExplorerPathBar.tsx`,
  treeView: `${FX}FileTreeView.tsx`,
  listView: `${FX}FileListView.tsx`,
  css: `${FX}FileExplorer.css`,
  pathBarModel: `${FX}fileExplorerPathBarModel.ts`,
  windowsHook: 'hooks/useFileExplorerWindows.ts',
  // The explorer tab panel's file operations moved here (FR-MDE-012 AC-8), so
  // the path handling that went with them stays under DR-20.
  opsHook: 'hooks/useFileTreeOperations.ts',
  treeHook: 'hooks/useFileTree.ts',
  header: 'components/Header/Header.tsx',
  app: 'App.tsx',
  mosaic: 'components/Grid/MosaicContainer.tsx',
  editorWindows: 'hooks/useEditorWindows.ts',
} as const;

// The components this step creates. Held as a list rather than globbed so that
// the set can never come out empty.
const EXPLORER_TSX = [T.window, T.tabBar, T.pathBar, T.treeView, T.listView] as const;

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

/** The identifier holding a selector's result, and the declaration's span. */
function rowsIdentifier(src: Lexed, selector: string): { id: string; at: number } {
  const decls = [...src.bare.matchAll(new RegExp(
    `\\b(const|let|var)\\s+(\\w+)\\s*(?::[^=;]+)?=\\s*(?:useMemo\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*)?${selector}\\s*\\(`, 'g'))];
  assert.equal(decls.length, 1, `${src.path}: expected exactly one declaration holding ${selector}(...), found ${decls.length}`);
  const m = decls[0];
  assert.equal(m[1], 'const', `${where(src, m.index)}: the ${selector} result must be a const, not reassignable`);
  const open = m.index + m[0].length - 1;
  const close = matchBracket(src.bare, open);
  const after = src.bare.slice(close + 1).trimStart()[0];
  assert.ok(after !== '.' && after !== '[', `${where(src, close)}: ${selector}(...) is chained — the rows must reach .map untouched`);
  return { id: m[2], at: m.index };
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

/** The value of `prop` inside an object literal span, following shorthand. */
function propValue(src: Lexed, obj: Span, prop: string): { code: string; bare: string } | null {
  const text = src.bare.slice(obj.start, obj.end);
  const m = new RegExp(`(^|[{,\\s])${prop}\\s*(:|,|\\}|$)`).exec(text);
  if (!m) return null;
  if (m[2] === ':') {
    const at = obj.start + m.index + m[0].length;
    return slice(src, readExpression(src.bare, at));
  }
  const def = definitionOf(src, prop, obj.start);
  return def ? slice(src, def) : { code: prop, bare: prop };
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
// FR-FEX-002 — path bar and the two views
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-002-AC1-01 PATH_BAR_CONTROLS === [up, path, mode, refresh, newdir] (DR-18)', async () => {
  // Loaded here, not imported at the top: a static import of a missing module
  // crashes the runner before any test is named. The specifier is a runtime
  // value, so tsc does not resolve it while the module is absent.
  const specifier = new URL(T.pathBarModel, SRC_DIR).href;
  const mod = await import(specifier) as { PATH_BAR_CONTROLS?: unknown };
  // DR-18 is an order, and the order is a value: the component maps this array,
  // so asserting it here asserts what is drawn left to right.
  assert.deepEqual(mod.PATH_BAR_CONTROLS, ['up', 'path', 'mode', 'refresh', 'newdir']);
});

test('TC-REQ-FR-FEX-002-AC1-02 FileExplorerPathBar 가 PATH_BAR_CONTROLS 를 map 해 그리고 mode 토글이 setMode 를 부른다', () => {
  requireSources([T.pathBar, T.pathBarModel]);
  const bar = read(T.pathBar);
  assert.match(bar.code, /import\s*\{[^}]*\bPATH_BAR_CONTROLS\b[^}]*\}\s*from\s*['"]\.\/fileExplorerPathBarModel(?:\.ts)?['"]/,
    `${bar.path} must import PATH_BAR_CONTROLS from ./fileExplorerPathBarModel`);
  assert.match(bar.bare, /\bPATH_BAR_CONTROLS\s*\.\s*map\s*\(/, `${bar.path} must render by mapping PATH_BAR_CONTROLS`);
  // A second, hand-written order would be the one that is actually drawn.
  assert.doesNotMatch(bar.code, /\[\s*['"]up['"]\s*,\s*['"]path['"]/, `${bar.path} re-declares the control order`);
  assert.ok(handlerBodies(bar, 'onClick').some(h => /\bsetMode\s*\(/.test(spansText(bar, h.spans).bare)),
    `${bar.path}: the tree/list toggle's onClick must call setMode`);
});

test('TC-REQ-FR-FEX-002-AC2-03 FileListView 가 LIST_COLUMNS 를 map 해 머리글 셋을 그리고 머리글 클릭이 sort 를 바꾼다', async () => {
  requireSources([T.listView]);
  // The three columns are a value, pinned here, so mapping LIST_COLUMNS is
  // mapping exactly name / modified / size.
  const model = await import(new URL(`${FX}fileListView.ts`, SRC_DIR).href) as { LIST_COLUMNS?: unknown };
  assert.deepEqual(model.LIST_COLUMNS, ['name', 'modified', 'size']);
  const view = read(T.listView);
  assert.match(view.code, /import\s*\{[^}]*\bLIST_COLUMNS\b[^}]*\}\s*from\s*['"]\.\/fileListView(?:\.ts)?['"]/,
    `${view.path} must import LIST_COLUMNS from ./fileListView`);
  const maps = callArgs(view, 'LIST_COLUMNS\\s*\\.\\s*map');
  assert.ok(maps.length >= 1, `${view.path} must draw the column headers by mapping LIST_COLUMNS`);
  const headerClickChangesSort = maps.some(span => handlerBodies(view, 'onClick')
    .filter(h => h.at >= span.start && h.at < span.end)
    .some(h => /\b(?:set|on)\w*Sort\w*\s*\(/.test(spansText(view, h.spans).bare)));
  assert.ok(headerClickChangesSort, `${view.path}: a header's onClick must change the sort (set…Sort / on…Sort call)`);
});

test('TC-REQ-FR-FEX-002-AC8-02 두 뷰: 가상화 import 없음, 행 .map 수신자가 selectListRows/selectVisibleRows 결과 그 자체이고 사이에 slice/filter/splice 없음 (DR-14)', () => {
  requireSources([T.listView, T.treeView]);
  const pkg = JSON.parse(readFileSync(new URL('package.json', FRONTEND_DIR), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const VIRTUALIZERS = ['react-window', 'react-virtualized', '@tanstack/react-virtual', 'react-virtuoso', 'virtua'];
  assert.deepEqual(deps.filter(d => VIRTUALIZERS.includes(d)), [], 'frontend/package.json must not depend on a virtualization library');

  for (const [path, selector, module] of [
    [T.listView, 'selectListRows', 'fileListView'],
    [T.treeView, 'selectVisibleRows', 'fileTreeState'],
  ] as const) {
    const view = read(path);
    assert.match(view.code, new RegExp(`import\\s*\\{[^}]*\\b${selector}\\b[^}]*\\}\\s*from\\s*['"]\\./${module}(?:\\.ts)?['"]`),
      `${view.path} must import ${selector} from ./${module}`);
    assert.doesNotMatch(view.code, /(?:from|import)\s*['"](?:react-window|react-virtualized|@tanstack\/react-virtual|react-virtuoso|virtua)['"]/,
      `${view.path} imports a virtualization library`);
    assert.doesNotMatch(view.bare, /\bIntersectionObserver\b/, `${view.path} uses IntersectionObserver`);

    const { id } = rowsIdentifier(view, selector);
    assert.match(view.bare, new RegExp(`\\{\\s*${id}\\s*\\.\\s*map\\s*\\(`),
      `${view.path}: the rendered rows must be {${id}.map(...)} — the selector result itself`);
    const cut = new RegExp(`\\b${id}\\s*\\.\\s*(slice|splice${path === T.listView ? '|filter' : ''})\\s*\\(`).exec(view.bare);
    assert.equal(cut, null, cut ? `${where(view, cut.index)}: ${id}.${cut[1]}(...) cuts the row set` : '');
    assert.doesNotMatch(view.bare, new RegExp(`\\b${id}\\s*\\.\\s*length\\s*=(?!=)`), `${view.path} truncates ${id}`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-003 — the window
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-003-AC1-02 FileExplorerWindow 가 <WindowDialog mode="modeless" dialogId={fileExplorerDialogId(workspaceId)}> 로 뜬다', () => {
  requireSources([T.window]);
  const win = read(T.window);
  assert.match(win.code, /import\s*\{[^}]*\bfileExplorerDialogId\b[^}]*\}\s*from\s*['"]\.\/fileExplorerDialog(?:\.ts)?['"]/,
    `${win.path} must take the dialog id from ./fileExplorerDialog`);
  const tags = openingTags(win, 'WindowDialog');
  assert.ok(tags.length >= 1, `${win.path} must render a <WindowDialog>`);
  for (const tag of tags) {
    const mode = attrValue(win, tag, 'mode');
    assert.ok(mode && /^(?:"modeless"|'modeless'|\s*['"]modeless['"]\s*)$/.test(mode.code),
      `${where(win, tag.start)}: <WindowDialog> must have mode="modeless", got ${mode?.code ?? 'none'}`);
    const id = attrValue(win, tag, 'dialogId');
    assert.ok(id, `${where(win, tag.start)}: <WindowDialog> has no dialogId`);
    const expr = id.bare.trim();
    const direct = /^fileExplorerDialogId\s*\(\s*workspaceId\s*\)$/.test(expr);
    const def = /^\w+$/.test(expr) ? definitionOf(win, expr) : null;
    const viaConst = def !== null && /^\s*fileExplorerDialogId\s*\(\s*workspaceId\s*\)\s*$/.test(win.bare.slice(def.start, def.end));
    assert.ok(direct || viaConst, `${where(win, tag.start)}: dialogId must be fileExplorerDialogId(workspaceId), got {${expr}}`);
  }
});

test('TC-REQ-FR-FEX-003-AC5-01 FileExplorer.css·explorer TSX 에 z-index/zIndex 가 없다 — 쌓임은 WindowDialog 모델만', () => {
  requireSources([...EXPLORER_TSX, T.css]);
  const css = readCss(T.css);
  assert.doesNotMatch(css, /z-index/i, `src/${T.css} sets z-index; stacking belongs to the dialog stack's 3000 band`);
  for (const path of explorerTsxAll()) {
    const src = read(path);
    assert.doesNotMatch(src.bare, /\bzIndex\b/, `${src.path} sets zIndex`);
    assert.doesNotMatch(src.code, /z-index/i, `${src.path} sets z-index`);
  }
});

test('TC-REQ-FR-FEX-003-AC9-02 창의 스크롤 복원이 렌더된 행 수와 이름 조회 결과를 decideScrollRestore 에 넘긴다 (행 0 이면 쓰기 없음)', () => {
  requireSources([T.window, T.treeView, T.listView]);
  const sources = [T.window, T.treeView, T.listView].map(read);
  // DR-15: the position is an anchor, so no pixel offset is ever written back.
  for (const src of sources) {
    const px = /\bscrollTop\s*=(?!=)/.exec(src.bare);
    assert.equal(px, null, px ? `${where(src, px.index)}: scrollTop is assigned — restore goes by anchor, not pixels` : '');
  }
  const calls = sources.flatMap(src => callArgs(src, 'decideScrollRestore').map(span => ({ src, span })));
  assert.ok(calls.length >= 1, 'the window or a view must restore scroll through decideScrollRestore');
  for (const { src, span } of calls) {
    const rowCount = propValue(src, span, 'rowCount');
    assert.ok(rowCount, `${where(src, span.start)}: decideScrollRestore needs rowCount`);
    // "Rendered", not "in state": a listing can be loaded before a row is
    // painted, and a write then is clamped to 0 without an error.
    assert.match(rowCount.bare, /querySelectorAll|childElementCount|\.children\b/,
      `${where(src, span.start)}: rowCount must be counted from the rendered list, got ${rowCount.code.trim()}`);
    assert.ok(propValue(src, span, 'anchorName'), `${where(src, span.start)}: decideScrollRestore needs anchorName`);
    assert.ok(propValue(src, span, 'visibleRows'), `${where(src, span.start)}: decideScrollRestore needs visibleRows`);
    assert.match(src.code, /\.kind\s*(?:===|!==)\s*['"](?:wait|scroll)['"]/, `${src.path}: the 'wait' decision must be honoured before scrolling`);
    assert.match(src.bare, /\bif\s*\([^)]*\bshouldPersist\b|\bshouldPersist\b\s*(?:&&|\?)/,
      `${src.path}: a restore may save only when shouldPersist says so — it must gate a write, not merely be named`);
  }
});

test('TC-REQ-FR-FEX-003-AC10-02 onScroll 은 decideAnchorPersist 로만 저장하고, 복원 대비책 scrollIntoView 는 프로그램 스크롤로 표시된다 (DR-15)', () => {
  requireSources([T.window, T.treeView, T.listView]);
  const sources = [T.window, T.treeView, T.listView].map(read);

  const persistCalls = sources.flatMap((src) => {
    const scrollSpans = handlerBodies(src, 'onScroll').flatMap(h => h.spans);
    return callArgs(src, 'decideAnchorPersist')
      .filter(arg => scrollSpans.some(s => arg.start >= s.start && arg.end <= s.end))
      .map(arg => ({ src, arg }));
  });
  assert.ok(persistCalls.length >= 1, 'an onScroll handler must decide the anchor write with decideAnchorPersist');

  // The restore's own scroll fires scroll events too. It is told apart by a flag
  // set right before scrollIntoView and read into userInitiated; a literal true
  // would let the fallback save itself through the back door (Orca STA-5949).
  const flags = new Set<string>();
  for (const { src, arg } of persistCalls) {
    const value = propValue(src, arg, 'userInitiated');
    assert.ok(value, `${where(src, arg.start)}: decideAnchorPersist needs userInitiated`);
    const expr = value.bare.trim();
    assert.notEqual(expr, 'true', `${where(src, arg.start)}: userInitiated is a literal true — the programmatic restore scroll would be saved`);
    const flag = /([A-Za-z_$][\w$]*)(?:\.current)?/.exec(expr.replace(/^!+/, ''));
    assert.ok(flag, `${where(src, arg.start)}: userInitiated must read a programmatic-scroll flag, got ${expr}`);
    flags.add(flag[1]);
  }
  const intoView = sources.flatMap(src => [...src.bare.matchAll(/\bscrollIntoView\s*\(/g)].map(m => ({ src, at: m.index })));
  assert.ok(intoView.length >= 1, 'the restore must scroll with scrollIntoView (anchor, not pixels)');
  for (const { src, at } of intoView) {
    const before = src.bare.slice(Math.max(0, at - 300), at);
    const marked = [...flags].some(f => new RegExp(`\\b${f}(?:\\.current)?\\s*=\\s*(?:true|false)\\b`).test(before));
    assert.ok(marked, `${where(src, at)}: scrollIntoView is not marked as a programmatic scroll (set ${[...flags].join('/')} right before it)`);
  }

  // Every anchor write sits behind a 'save' decision or a restore's shouldPersist.
  let writes = 0;
  for (const src of sources) {
    for (const m of src.bare.matchAll(/\b(?:on|set|save|persist|update)\w*Anchor\w*\s*\(/gi)) {
      if (/\bdecideAnchorPersist\s*\($/.test(src.bare.slice(0, m.index + m[0].length))) continue;
      writes += 1;
      assert.ok(gated(src, m.index, /['"]save['"]|\bshouldPersist\b/),
        `${where(src, m.index)}: anchor write without a decideAnchorPersist 'save' or shouldPersist gate on the same statement`);
    }
  }
  assert.ok(writes >= 1, 'no anchor write found — the top row name is never saved');
});

test('TC-REQ-FR-FEX-003-AC2-03 useFileExplorerWindows 의 raise 분기가 raiseDialogById(dialogId, "modeless") 를 부르고 minimized 를 false 로 둔다', () => {
  requireSources([T.windowsHook]);
  const hook = read(T.windowsHook);
  assert.match(hook.code, /import\s*\{[^}]*\bdecideOpenFileExplorer\b[^}]*\}\s*from\s*['"][./]*components\/fileExplorer\/fileExplorerDialog(?:\.ts)?['"]/,
    `${hook.path} must import decideOpenFileExplorer`);
  assert.match(hook.code, /import\s*\{[^}]*\braiseDialogById\b[^}]*\}\s*from\s*['"][./]*components\/dialog\/dialogStack(?:\.ts)?['"]/,
    `${hook.path} must import raiseDialogById from the dialog stack`);
  const raise = raiseBranch(hook);
  const text = slice(hook, raise);
  assert.match(text.code, /\braiseDialogById\s*\(\s*[\w.]+\s*,\s*['"]modeless['"]\s*\)/, `${where(hook, raise.start)}: the raise branch must call raiseDialogById(id, 'modeless')`);
  assert.match(text.bare, /\bminimized\s*:\s*false\b/, `${where(hook, raise.start)}: the raise branch must clear minimized`);
});

/**
 * Whether the statement holding `index` runs only under `gate`: the gate sits
 * in the statement itself (`if (gate) call()`, `gate && call()`), or the
 * statement is the direct body of an `if (gate) { ... }`. A gate on some
 * neighbouring statement does not count.
 */
function gated(src: Lexed, index: number, gate: RegExp): boolean {
  const statementStart = (from: number): number => {
    let depth = 0;
    for (let k = from - 1; k >= 0; k -= 1) {
      const c = src.bare[k];
      if (c === ')' || c === ']') depth += 1;
      else if (c === '(' || c === '[') depth -= 1;
      else if (depth === 0 && (c === ';' || c === '{' || c === '}')) return k;
    }
    return -1;
  };
  const start = statementStart(index);
  if (gate.test(src.code.slice(start + 1, index))) return true;
  // Outward through enclosing blocks, stopping at the function that holds the
  // write: a gate outside the handler is not a gate on this call.
  let open = enclosingBrace(src.bare, index);
  while (open !== -1) {
    const head = src.code.slice(statementStart(open) + 1, open);
    if (/\bif\s*\(/.test(head) && gate.test(head)) return true;
    if (/=>\s*$|\bfunction\b/.test(head)) return false;
    open = enclosingBrace(src.bare, open - 1);
  }
  return false;
}

/** The block run when decideOpenFileExplorer answers 'raise'. */
function raiseBranch(hook: Lexed): Span {
  const ifRaise = /\bif\s*\(/g;
  for (const m of hook.bare.matchAll(ifRaise)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(hook.bare, open);
    const cond = hook.code.slice(open, close);
    if (!/\.action\s*===\s*['"]raise['"]/.test(cond)) continue;
    const brace = hook.bare.slice(close + 1).search(/\S/) + close + 1;
    if (hook.bare[brace] !== '{') continue;
    return { start: brace, end: matchBracket(hook.bare, brace) + 1 };
  }
  const caseRaise = /\bcase\s+['"]raise['"]\s*:/.exec(hook.code);
  if (caseRaise) {
    const rest = hook.bare.slice(caseRaise.index + caseRaise[0].length);
    const stop = rest.search(/\bcase\b|\bdefault\s*:/);
    return { start: caseRaise.index, end: caseRaise.index + caseRaise[0].length + (stop === -1 ? rest.length : stop) };
  }
  assert.fail(`${hook.path}: no branch on decision.action === 'raise'`);
}

test('TC-REQ-FR-FEX-003-AC2-04 최소화된 창을 다시 열면 새로 만들지 않고 워크스페이스 창 기록의 minimized 를 해제해 끌어올린다 — 최소화는 언마운트하지 않는다', () => {
  requireSources([T.windowsHook, T.window]);
  const hook = read(T.windowsHook);
  const win = read(T.window);
  const raise = slice(hook, raiseBranch(hook));
  // Design decision 20: the window stays mounted while minimized, so it stays
  // registered and a reopen is a raise. Building a new window here would put a
  // fresh first tab over the ones the user had.
  assert.match(raise.bare, /\[\s*[\w.]*workspaceId\s*\]|\.get\s*\(\s*[\w.]*workspaceId\s*\)/,
    `${hook.path}: the raise branch must find the workspace's existing window record`);
  const creates = /\b(openInNewTab|createInitialFileTreeState|readPersistedFileExplorerState|restoreFileExplorerTabs|randomUUID|getRandomValues)\s*\(/.exec(raise.bare);
  assert.equal(creates, null, creates ? `${hook.path}: the raise branch calls ${creates[1]} — a reopen must not build tabs` : '');
  for (const src of [hook, win]) {
    // `hidden`/`visible` too: the window may receive the three-term visibility
    // (as the editor window does) rather than the raw flag.
    for (const pattern of [
      /\bif\s*\([^)]*\b(?:minimized|hidden)\b[^)]*\)\s*\{?\s*return\s+null\b/,
      /\bif\s*\(\s*!\s*[\w.]*\bvisible\b[^)]*\)\s*\{?\s*return\s+null\b/,
      /\b(?:minimized|hidden)\s*\)?\s*\?\s*null\b/,
      /!\s*[\w.]*\b(?:minimized|hidden)\b\s*&&/,
      /\bvisible\b\s*&&\s*[(<]/,
      /\bvisible\b\s*\?[^:;]*:\s*null\b/,
    ]) {
      const hit = pattern.exec(src.bare);
      assert.equal(hit, null, hit ? `${where(src, hit.index)}: a minimized window is unmounted — it must only be hidden` : '');
    }
  }
});

test('TC-REQ-FR-FEX-003-AC3-03 복원 시 originTabId 의 탭이 사라졌으면 워크스페이스의 활성 터미널 탭 세션으로 대체한다', () => {
  requireSources([T.windowsHook]);
  const hook = read(T.windowsHook);
  const calls = callArgs(hook, 'restoreFileExplorerTabs');
  assert.ok(calls.length >= 1, `${hook.path} must restore tabs with restoreFileExplorerTabs`);
  let checked = 0;
  for (const call of calls) {
    // The deps object is the call's last argument; find resolveSession in it.
    const resolver = propValue(hook, call, 'resolveSession');
    if (!resolver) continue;
    checked += 1;
    // Inline arrow or a named local function: judged by what it runs.
    const named = /^\s*[A-Za-z_$][\w$]*\s*$/.test(resolver.bare) ? definitionOf(hook, resolver.bare.trim()) : null;
    const body = named ? spansText(hook, expand(hook, named)).bare : resolver.bare;
    assert.match(body, /\bresolveTabSession\s*\(/, `${hook.path}: resolveSession must look the origin tab up with resolveTabSession`);
    assert.match(body, /\?\?|\|\||===\s*undefined|!==\s*undefined/, `${hook.path}: resolveSession has no fallback for a vanished origin tab`);
    assert.match(body, /\bactive\w*Tab\w*|\bactiveTab\w*/i, `${hook.path}: the fallback must be the workspace's active terminal tab`);
  }
  assert.ok(checked >= 1, `${hook.path}: restoreFileExplorerTabs is called without a resolveSession dependency`);
});

test('TC-REQ-FR-FEX-003-AC6-04 탭 생성이 readPersistedFileExplorerState 로 불러오고 모드·정렬·anchor 변경이 saveFileExplorerStateForWorkspace 를 부른다', () => {
  requireSources([T.windowsHook]);
  const hook = read(T.windowsHook);
  assert.match(hook.code, /import\s*\{[^}]*\breadPersistedFileExplorerState\b[^}]*\bsaveFileExplorerStateForWorkspace\b[^}]*\}|import\s*\{[^}]*\bsaveFileExplorerStateForWorkspace\b[^}]*\breadPersistedFileExplorerState\b[^}]*\}/,
    `${hook.path} must import readPersistedFileExplorerState and saveFileExplorerStateForWorkspace`);
  assert.match(hook.bare, /\breadPersistedFileExplorerState\s*\(/, `${hook.path} never reads the stored tabs`);
  assert.match(hook.bare, /\brestoreFileExplorerTabs\s*\(/, `${hook.path} never turns stored tabs back into tabs`);
  assert.match(hook.bare, /\bsaveFileExplorerStateForWorkspace\s*\(/, `${hook.path} never saves`);

  // Either every tab change is saved by an effect on the tab state, or each of
  // the three updaters saves on its own.
  // An effect counts only if it re-runs on state: a save on mount with [] deps
  // would never see a mode, sort or anchor change.
  const effectSaves = callArgs(hook, 'useEffect').some((span) => {
    if (!/\bsaveFileExplorerStateForWorkspace\s*\(/.test(spansText(hook, expand(hook, span)).bare)) return false;
    const deps = /\[([^\[\]]*)\]\s*$/.exec(hook.bare.slice(span.start, span.end));
    return deps !== null && /[A-Za-z_$]/.test(deps[1]);
  });
  const updatersSave = [/mode/i, /sort/i, /anchor/i].every((word) =>
    [...hook.bare.matchAll(/\bconst\s+(\w+)\s*=/g)]
      .filter(m => word.test(m[1]))
      .some(m => {
        const def = definitionOf(hook, m[1]);
        return def !== null && /\bsaveFileExplorerStateForWorkspace\s*\(/.test(spansText(hook, expand(hook, def)).bare);
      }));
  assert.ok(effectSaves || updatersSave, `${hook.path}: mode, sort and anchor changes must reach saveFileExplorerStateForWorkspace`);
  for (const field of ['mode', 'sort', 'scrollAnchor']) {
    assert.match(hook.bare, new RegExp(`\\b${field}\\b`), `${hook.path}: the saved record never carries ${field}`);
  }
  assert.doesNotMatch(hook.bare, /\bexpandedPaths\b/, `${hook.path} touches expandedPaths — expansion is not persisted (AC-7)`);
});

// ---------------------------------------------------------------------------
// FR-FEX-011 — rows
// ---------------------------------------------------------------------------

const VIEWS = [
  [T.listView, 'selectListRows'],
  [T.treeView, 'selectVisibleRows'],
] as const;

test('TC-REQ-FR-FEX-011-AC1-03 두 뷰가 CLICK_ROW/SELECT_ALL 에 싣는 orderedPaths 가 그 뷰가 map 하는 행 배열에서 나온다', () => {
  requireSources(VIEWS.map(v => v[0]));
  for (const [path, selector] of VIEWS) {
    const view = read(path);
    const { id } = rowsIdentifier(view, selector);
    const actions = [...view.code.matchAll(/\btype\s*:\s*['"](CLICK_ROW|SELECT_ALL)['"]/g)];
    assert.ok(actions.some(a => a[1] === 'CLICK_ROW'), `${view.path} never dispatches CLICK_ROW`);
    for (const action of actions) {
      const open = enclosingBrace(view.bare, action.index);
      const obj = { start: open + 1, end: matchBracket(view.bare, open) };
      const ordered = propValue(view, obj, 'orderedPaths');
      assert.ok(ordered, `${where(view, action.index)}: ${action[1]} carries no orderedPaths`);
      // Shift-range selection walks this list; a list other than the drawn rows
      // selects rows the user cannot see, or skips ones they can.
      assert.ok(refersTo(view, ordered.bare, id), `${where(view, action.index)}: orderedPaths must come from ${id}, the rows this view maps`);
    }
  }
});

test('TC-REQ-FR-FEX-011-AC1-04 행 선택이 onClick → decideRowPointer 로만 일어나고 onMouseDown/onPointerDown 에서 선택을 바꾸지 않는다', () => {
  requireSources(VIEWS.map(v => v[0]));
  for (const [path] of VIEWS) {
    const view = read(path);
    const clickSpans = handlerBodies(view, 'onClick').flatMap(h => h.spans);
    const calls = [...view.bare.matchAll(/\bdecideRowPointer\s*\(/g)];
    assert.ok(calls.length >= 1, `${view.path} never calls decideRowPointer`);
    for (const call of calls) {
      const inside = clickSpans.some(s => call.index >= s.start && call.index < s.end);
      assert.ok(inside, `${where(view, call.index)}: decideRowPointer is called outside an onClick handler`);
    }
    for (const attr of ['onMouseDown', 'onPointerDown', 'onMouseUp', 'onPointerUp']) {
      for (const h of handlerBodies(view, attr)) {
        const hit = /\b(decideRowPointer|CLICK_ROW|SELECT_ALL|CLEAR_SELECTION|selectedPaths)\b/.exec(spansText(view, h.spans).code);
        assert.equal(hit, null, hit ? `${where(view, h.at)}: ${attr} touches selection (${hit[1]})` : '');
      }
    }
  }
});

test('TC-REQ-FR-FEX-011-AC4-03 삼각형(expander) 처리기가 stopPropagation 을 부르고 decideRowClick({targetPart:"expander"}) 를 쓴다', () => {
  requireSources([T.treeView]);
  const view = read(T.treeView);
  const expanders = handlerBodies(view, 'onClick').filter(h => /\btargetPart\s*:\s*['"]expander['"]/.test(spansText(view, h.spans).code));
  assert.ok(expanders.length >= 1, `${view.path}: no onClick passes targetPart: 'expander'`);
  for (const h of expanders) {
    const text = spansText(view, h.spans).bare;
    assert.match(text, /\.\s*stopPropagation\s*\(/, `${where(view, h.at)}: the expander must stop propagation so the row does not also select`);
    assert.match(text, /\bdecideRowClick\s*\(/, `${where(view, h.at)}: the expander must decide through decideRowClick`);
  }
});

test('TC-REQ-FR-FEX-011-AC2-02 open-editor 판정은 주입된 onOpenFile 로만 간다 — fileExplorer/ 에 readFile 호출 없음', () => {
  requireSources([...EXPLORER_TSX, T.windowsHook]);
  for (const path of [...explorerTree(), T.windowsHook]) {
    const src = read(path);
    const hit = /\breadFile\b/.exec(src.bare);
    assert.equal(hit, null, hit ? `${where(src, hit.index)}: the explorer reads files itself — opening goes through the editor's openDocument` : '');
  }
  const win = read(T.window);
  assert.match(win.bare, /\bonOpenFile\s*\??\s*:/, `${win.path} must take onOpenFile as a prop`);
  let routed = 0;
  for (const path of explorerTsxAll()) {
    const src = read(path);
    for (const m of src.code.matchAll(/['"]open-editor['"]/g)) {
      routed += 1;
      assert.match(src.bare.slice(m.index, m.index + 300), /\bonOpenFile\s*\(/, `${where(src, m.index)}: 'open-editor' must call onOpenFile`);
    }
  }
  assert.ok(routed >= 1, "no view acts on decideDoubleClick's 'open-editor'");
});

test('TC-REQ-FR-FEX-011-AC5-02 행 렌더러가 rowRenderClass 를 className 에 쓰고 onDoubleClick 이 decideDoubleClick 을 따른다', () => {
  requireSources(VIEWS.map(v => v[0]));
  for (const [path] of VIEWS) {
    const view = read(path);
    const classNames = handlerBodies(view, 'className');
    assert.ok(classNames.some(h => /\browRenderClass\s*\(/.test(spansText(view, h.spans).bare)),
      `${view.path}: a row's className must include rowRenderClass(...)`);
    const doubles = handlerBodies(view, 'onDoubleClick');
    assert.ok(doubles.length >= 1, `${view.path} has no onDoubleClick`);
    for (const h of doubles) {
      assert.match(spansText(view, h.spans).bare, /\bdecideDoubleClick\s*\(/, `${where(view, h.at)}: onDoubleClick must follow decideDoubleClick (noop for unopenable files)`);
    }
    // One rule for openability: the view must not re-judge it.
    const second = /\b(isOpenableFile|isViewableExtension)\b/.exec(view.bare) ?? /['"]unopenable['"]|classList\s*\.\s*contains/.exec(view.code);
    assert.equal(second, null, second ? `${where(view, second.index)}: the view judges openability itself` : '');
  }
});

// ---------------------------------------------------------------------------
// SEC-FOP-001 — no client copy of the boundary
// ---------------------------------------------------------------------------

// Pure path-syntax modules reviewed with the tree core: they spell a drive root
// to canonicalize a path ('C:' -> 'C:\'), which is syntax, not a boundary
// judgement. Listed by name so the exemption cannot grow silently, and asserted
// to exist so a rename cannot turn it into a hole.
const PATH_SYNTAX_EXEMPT = [`${FX}fileTreeState.ts`, `${FX}fileTreeController.ts`];

test('TC-REQ-SEC-FOP-001-AC3-01 fileExplorer/**·useFileTree·useFileExplorerWindows 에 경계 규칙 사본이 없다 (DR-20)', () => {
  requireSources([...EXPLORER_TSX, T.pathBarModel, T.treeHook, T.windowsHook, T.opsHook, ...PATH_SYNTAX_EXEMPT]);
  const files = [...new Set([...explorerTree(), T.treeHook, T.windowsHook, T.opsHook])];
  for (const path of files) {
    const src = read(path);
    const policy = /\b(isPathBlocked|blockedPaths|resolveAndValidate)\b/.exec(src.code);
    assert.equal(policy, null, policy ? `${where(src, policy.index)}: ${policy[1]} — the boundary lives on the server` : '');
    for (const pattern of [
      /\b\w*[cC]wd\w*\b(?:\.\w+|\(\s*[^)]*\))?\s*(?:===|!==|==|!=)/,
      /(?:===|!==|==|!=)\s*[\w.]*\b\w*[cC]wd\w*\b/,
      /\.startsWith\s*\(\s*[\w.]*[cC]wd/,
      /\b\w*[cC]wd\w*(?:\.\w+)*\s*\.\s*startsWith\s*\(/,
    ]) {
      const hit = pattern.exec(src.bare);
      assert.equal(hit, null, hit ? `${where(src, hit.index)}: compares against a cwd — '↑' is decided by the server's '..' only` : '');
    }
    if (!PATH_SYNTAX_EXEMPT.includes(path)) {
      // Any spelling of a letter class followed by ':' — [A-Za-z]:, [A-Z]:, [a-z]: …
      const drive = /\[(?:[A-Za-z]-[A-Za-z]){1,2}\]\s*:/.exec(src.code);
      assert.equal(drive, null, drive ? `${where(src, drive.index)}: a drive-letter pattern in UI code — roots are not judged on the client` : '');
    }
  }
  const bar = read(T.pathBar);
  assert.match(bar.bare, /\bcanGoUp\s*\(/, `${bar.path}: '↑' must be enabled by canGoUp (the server's '..'), nothing else`);
});

test('TC-REQ-SEC-FOP-001-AC5-02 경로 막대가 tree.error 를 role="alert" 로 보이고 root 를 바꾸지 않는다', () => {
  requireSources([T.pathBar]);
  const bar = read(T.pathBar);
  const alerts = [...bar.code.matchAll(/\brole\s*=\s*(?:"alert"|\{\s*['"]alert['"]\s*\})/g)];
  assert.ok(alerts.length >= 1, `${bar.path}: a refused listing must be shown with role="alert"`);
  assert.ok(alerts.some(a => /\.error\b/.test(bar.bare.slice(a.index, a.index + 300))),
    `${bar.path}: the role="alert" element must show the tree's error`);
  // A refused parent keeps the root: the path bar reports, it does not move.
  const moves = /\b(SET_ROOT|NAVIGATE_COMMITTED|NAVIGATE_FAILED)\b/.exec(bar.code);
  assert.equal(moves, null, moves ? `${where(bar, moves.index)}: the path bar drives navigation state (${moves[1]}) itself` : '');
  for (const m of bar.bare.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const body = bar.bare.slice(open, matchBracket(bar.bare, open));
    assert.doesNotMatch(body, /\bsetRoot\s*\(/, `${where(bar, m.index)}: a failed listing must not change the root`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-010 — entry points (closed by T-PH002-10, red until then)
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-010-AC5-01 Header.tsx 의 aria-label "파일 탐색기" 버튼이 onOpenFileExplorer 를 부른다', () => {
  requireSources([T.header]);
  const header = read(T.header);
  assert.match(header.bare, /\bonOpenFileExplorer\s*\??\s*:/, `${header.path} must declare an onOpenFileExplorer prop`);
  const buttons = openingTags(header, 'button').filter((tag) => {
    const label = attrValue(header, tag, 'aria-label');
    return label !== null && /['"]\s*파일 탐색기\s*['"]/.test(label.code);
  });
  assert.equal(buttons.length, 1, `${header.path}: expected one <button aria-label="파일 탐색기">, found ${buttons.length}`);
  const tag = buttons[0];
  const cls = attrValue(header, tag, 'className');
  assert.ok(cls && /header-action-button/.test(cls.code), `${where(header, tag.start)}: the button must use header-action-button`);
  const click = attrValue(header, tag, 'onClick');
  assert.ok(click && /\bonOpenFileExplorer\b/.test(click.bare), `${where(header, tag.start)}: onClick must call onOpenFileExplorer`);
  // Always open-or-raise, never a toggle: a second press must not close it.
  assert.doesNotMatch(click.bare, /\bset\w*\s*\(|!\s*\w/, `${where(header, tag.start)}: onClick toggles state — the button only opens or raises`);
});

test('TC-REQ-FR-FEX-010-AC6-02 세 진입점이 useFileExplorerWindows.openFileExplorer 하나로 모이고 그 함수가 decideOpenFileExplorer 를 쓴다', () => {
  requireSources([T.app, T.header, T.mosaic, T.editorWindows, T.windowsHook, T.window]);
  const hook = read(T.windowsHook);
  const open = definitionOf(hook, 'openFileExplorer');
  assert.ok(open, `${hook.path} must define openFileExplorer`);
  assert.match(spansText(hook, expand(hook, open)).bare, /\bdecideOpenFileExplorer\s*\(/, `${hook.path}: openFileExplorer must decide with decideOpenFileExplorer`);

  // The decision has one caller, so no entry point can open a second window.
  for (const path of [T.app, T.header, T.mosaic, T.editorWindows, ...explorerTsxAll()]) {
    const src = read(path);
    const hit = /\bdecideOpenFileExplorer\s*\(/.exec(src.bare);
    assert.equal(hit, null, hit ? `${where(src, hit.index)}: decideOpenFileExplorer is called outside useFileExplorerWindows` : '');
  }

  const app = read(T.app);
  const hookUse = /\bconst\s+(\{[^}]*\}|\w+)\s*=\s*useFileExplorerWindows\s*\(/.exec(app.bare);
  assert.ok(hookUse, `${app.path} must create the explorer windows with useFileExplorerWindows`);
  const bound = hookUse[1].startsWith('{')
    ? /\bopenFileExplorer\b/.test(hookUse[1]) ? '\\bopenFileExplorer\\b' : null
    : `\\b${hookUse[1]}\\s*\\.\\s*openFileExplorer\\b`;
  assert.ok(bound, `${app.path}: openFileExplorer is not taken from useFileExplorerWindows`);
  const reaches = (text: string) => refersToPattern(app, text, new RegExp(bound));

  // App-side sites: the editor path menu (through useEditorWindows), the tab
  // strip's terminal menu, the header and the grid's terminal menu.
  const values: { at: number; text: string }[] = [];
  for (const m of app.bare.matchAll(/\bonOpenFileExplorer\s*(=\s*\{|:)/g)) {
    if (m[1] === ':') {
      const expr = readExpression(app.bare, m.index + m[0].length);
      values.push({ at: m.index, text: app.bare.slice(expr.start, expr.end) });
    } else {
      const o = m.index + m[0].length - 1;
      values.push({ at: m.index, text: app.bare.slice(o + 1, matchBracket(app.bare, o)) });
    }
  }
  const shorthand = [...app.bare.matchAll(/[{,]\s*onOpenFileExplorer\s*[,}]/g)];
  assert.ok(values.length + shorthand.length >= 4,
    `${app.path}: expected onOpenFileExplorer for useEditorWindows, the terminal menu, <Header> and <MosaicContainer>; found ${values.length + shorthand.length}`);
  for (const v of values) assert.ok(reaches(v.text), `${where(app, v.at)}: onOpenFileExplorer does not reach useFileExplorerWindows.openFileExplorer`);
  if (shorthand.length > 0) {
    const def = definitionOf(app, 'onOpenFileExplorer');
    assert.ok(def && reaches(app.bare.slice(def.start, def.end)), `${app.path}: shorthand onOpenFileExplorer does not reach openFileExplorer`);
  }
  for (const [component, label] of [['Header', 'header'], ['MosaicContainer', 'grid']] as const) {
    const tags = openingTags(app, component);
    assert.ok(tags.length >= 1 && tags.every(t => /\bonOpenFileExplorer\b/.test(app.bare.slice(t.start, t.end))),
      `${app.path}: <${component}> (${label} entry point) is not given onOpenFileExplorer`);
  }
  const terminalMenu = callArgs(app, 'buildTerminalContextMenuItems');
  assert.ok(terminalMenu.some(s => /\bonOpenFileExplorer\b/.test(app.bare.slice(s.start, s.end))),
    `${app.path}: the tab strip's terminal menu is not given onOpenFileExplorer`);
  const editorInput = callArgs(app, 'useEditorWindows');
  assert.ok(editorInput.some(s => /\bonOpenFileExplorer\b/.test(app.bare.slice(s.start, s.end))),
    `${app.path}: useEditorWindows is not given onOpenFileExplorer (session path menu)`);

  // The window is mounted, and a double click opens through the editor.
  const layers = openingTags(app, 'FileExplorerWindow');
  assert.ok(layers.length >= 1, `${app.path} must mount <FileExplorerWindow>`);
  assert.ok(layers.some(t => { const v = attrValue(app, t, 'onOpenFile'); return v !== null && /\bopenDocument\b/.test(v.bare); }),
    `${app.path}: <FileExplorerWindow onOpenFile> must be the editor's openDocument`);

  const editor = read(T.editorWindows);
  assert.ok(callArgs(editor, 'buildEditorFileMenuItems').some(s => /\bonOpenFileExplorer\b/.test(editor.bare.slice(s.start, s.end))),
    `${editor.path}: the session path menu is built without onOpenFileExplorer`);
  assert.match(editor.bare, /\bopenDocument\b/, `${editor.path} must expose openDocument`);

  const mosaic = read(T.mosaic);
  assert.match(mosaic.bare, /\bonOpenFileExplorer\s*\??\s*:/, `${mosaic.path} must take onOpenFileExplorer as a prop`);
  assert.ok(callArgs(mosaic, 'buildTerminalContextMenuItems').some(s => /\bonOpenFileExplorer\b/.test(mosaic.bare.slice(s.start, s.end))),
    `${mosaic.path}: the grid's terminal menu is not given onOpenFileExplorer`);
});

function refersToPattern(src: Lexed, text: string, pattern: RegExp): boolean {
  if (pattern.test(text)) return true;
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const def = definitionOf(src, m[1]);
    if (def && pattern.test(src.bare.slice(def.start, def.end))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The scanner itself. A guard built on a scanner that miscounts is a guard that
// measures nothing, so its two promises are pinned here and stay green.
// ---------------------------------------------------------------------------

test('scanner: JSX 텍스트의 // 와 앞 아포스트로피, 화살표 뒤 정규식을 올바로 읽는다', () => {
  const frag = lex("const f = () => (\n  <>\n    <a />\n  </>\n);\nconst after = 1;", 'frag.tsx');
  assert.match(frag.bare, /\);\nconst after = 1;/, 'a closing fragment </> ends the fragment');
  const generic = lex("const g = <Mosaic<string> value={v} className=\"m\" />;\nconst after = 2;", 'generic.tsx');
  assert.match(generic.bare, /\/>;\nconst after = 2;/, 'type arguments on a tag do not end it');
  const typeParam = lex("const h = useCallback(<K extends keyof D>(k: K) => { set(k); }, []);\nconst after = 3;", 'tp.tsx');
  assert.match(typeParam.bare, /\{ set\(k\); \}, \[\]\);\nconst after = 3;/, 'a generic arrow is not JSX');
  const jsx = lex("const a = () => <div>ref 3//4 x style={{ zIndex: 9 }}</div>;\nconst b = <p> 'Til <button aria-label=\"확인\">ok</button></p>;\nconst c = () => /readFile\\(/;\nconst d = n < m ? 1 : 2;", 'fixture.tsx');
  assert.match(jsx.bare, /\bzIndex\b/, 'code in a JSX expression after // text is still visible');
  assert.match(jsx.code, /<button aria-label="확인">/, 'a leading apostrophe in JSX text does not swallow the next tag');
  assert.doesNotMatch(jsx.bare, /\breadFile\s*\(/, 'a regex right after => is a literal');
  assert.match(jsx.bare, /const d = n < m \? 1 : 2;/, 'a comparison is not JSX');
  const g = lex("function f() { if (d === 'save') { ref.current = 1; setAnchor(x); } setAnchor(y); }", 'g.ts');
  assert.equal(gated(g, g.bare.indexOf('setAnchor(x)'), /'save'/), true, 'a write inside the gated block, after another statement');
  assert.equal(gated(g, g.bare.indexOf('setAnchor(y)'), /'save'/), false, 'a write after the gated block');
});

test('scanner: 주석은 지우고 문자열·템플릿·정규식 안의 토큰은 bare 에서 가린다', () => {
  const src = lex([
    "// readFile(x)",
    "/* scrollTop = 1 */",
    "const a = 'readFile(';",
    "const b = `x ${ readFile2(y) } readFile(`;",
    "const c = /readFile\\(/;",
    "const d = <p>don't {/* zIndex */} stop</p>;",
    "const e = 1; // zIndex",
  ].join('\n'), 'fixture.tsx');
  assert.doesNotMatch(src.bare, /\breadFile\s*\(/);
  assert.match(src.bare, /\breadFile2\s*\(/, 'code inside a template expression stays visible');
  assert.doesNotMatch(src.bare, /scrollTop|zIndex/);
  assert.match(src.code, /'readFile\('/, 'the literal view keeps string contents');
  assert.match(src.bare, /\bconst e = 1;/, 'an apostrophe in JSX text does not swallow the following lines');
  assert.equal(src.code.length, [
    "// readFile(x)", "/* scrollTop = 1 */", "const a = 'readFile(';", "const b = `x ${ readFile2(y) } readFile(`;",
    "const c = /readFile\\(/;", "const d = <p>don't {/* zIndex */} stop</p>;", "const e = 1; // zIndex",
  ].join('\n').length, 'offsets are preserved so failures can name a line');
});
