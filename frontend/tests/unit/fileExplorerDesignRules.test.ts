import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// CON-ARCH-001 AC-3 · AC-10 (with regression guards for the already checked
// AC-6 · AC-7 · AC-11) — the design rules the file explorer's styles and
// components must keep. DR numbers are those of the fx-step3 plan §5.6.
//
// AC-6/7/11 were closed in fx-step1 against tokens.css alone. The cases here
// that carry those numbers only keep the explorer from undoing them; they are
// not coverage for AC-3 or AC-10.
//
// No DOM harness exists, so every rule is judged from source. The two ways a
// source guard lies are both closed:
//
// - An empty set. "No file contains #fff" is true of no files at all, and the
//   var() check that read only tokens.css was exactly that kind of guard. The
//   CSS set is collected two ways — every .css under components/fileExplorer/,
//   recursively, and every .css an explorer .ts/.tsx imports — and an empty
//   result fails. The components are named, and their existence is asserted
//   before anything is said about their contents.
// - Prose. Comments are stripped before scanning, so a comment explaining why
//   #007acc is gone neither trips nor satisfies a rule. The TS/TSX scanner is
//   the one fileExplorerWiring.test.ts proves; it is copied rather than
//   imported, because importing a *.test.ts registers its tests a second time.

const SRC_DIR = new URL('../../src/', import.meta.url);
const FX = 'components/fileExplorer/';
const TOKENS = 'styles/tokens.css';

const T = {
  window: `${FX}FileExplorerWindow.tsx`,
  tabBar: `${FX}FileExplorerTabBar.tsx`,
  pathBar: `${FX}FileExplorerPathBar.tsx`,
  treeView: `${FX}FileTreeView.tsx`,
  listView: `${FX}FileListView.tsx`,
} as const;

/** The components this step creates. A list, not a glob, so it cannot come out empty. */
const EXPLORER_TSX = [T.window, T.tabBar, T.pathBar, T.treeView, T.listView] as const;

/** The views whose rows the .fx-row rules are written for. */
const ROW_VIEWS = [T.treeView, T.listView] as const;

// ---------------------------------------------------------------------------
// TS/TSX scanner (copied from fileExplorerWiring.test.ts)
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
// CSS reading
// ---------------------------------------------------------------------------

interface CssFile {
  /** Display path, relative to frontend/src when it lies inside it. */
  name: string;
  /** Comments blanked to spaces, newlines kept, so offsets still name a line. */
  text: string;
}

interface CssRule {
  file: CssFile;
  selector: string;
  body: string;
  /** Offset of the body in file.text. */
  at: number;
}

interface Decl { prop: string; value: string; at: number }

function stripCssComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

function cssAt(file: CssFile, index: number): string {
  return `${file.name}:${lineOf(file.text, index)}`;
}

function closeBrace(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k += 1) {
    if (text[k] === '{') depth += 1;
    else if (text[k] === '}') {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/**
 * Leaf style rules, descending into grouping at-rules (@media, @supports,
 * @container, @layer) and keyframe steps. Native CSS nesting is refused
 * outright rather than half-read: a nested `.fx-row[aria-selected]` that the
 * reader skipped would make "exactly one selected-row rule" count wrong.
 */
function cssRules(file: CssFile): CssRule[] {
  const out: CssRule[] = [];
  const walk = (start: number, end: number) => {
    let k = start;
    while (k < end) {
      const open = file.text.indexOf('{', k);
      if (open === -1 || open >= end) return;
      const semi = file.text.indexOf(';', k);
      if (semi !== -1 && semi < open) { k = semi + 1; continue; }
      const prelude = file.text.slice(k, open).trim();
      const close = closeBrace(file.text, open);
      assert.notEqual(close, -1, `unterminated block at ${cssAt(file, open)}`);
      if (/^@(?:media|supports|container|layer|document)\b/.test(prelude)
        || /^@(?:-webkit-)?keyframes\b/.test(prelude)) {
        walk(open + 1, close);
      } else {
        const body = file.text.slice(open + 1, close);
        assert.ok(!body.includes('{'), `nested CSS at ${cssAt(file, open)} is not read by this guard; flatten it`);
        out.push({ file, selector: prelude, body, at: open + 1 });
      }
      k = close + 1;
    }
  };
  walk(0, file.text.length);
  return out;
}

function decls(rule: CssRule): Decl[] {
  const out: Decl[] = [];
  for (const m of rule.body.matchAll(/(-{0,2}[A-Za-z][\w-]*)\s*:\s*([^;]*)/g)) {
    out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), at: rule.at + m.index });
  }
  return out;
}

/** A value with its quoted strings emptied: `content: "#abc"` is text, not a colour. */
function unquoted(value: string): string {
  return value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
}

/** The compound each comma-separated selector ends in — the element it styles. */
function subjects(selector: string): string[] {
  return selector.split(',').map((part) => {
    const flat = part.trim().replace(/\[([^\]]*)\]/g, (_m, inner: string) => `[${inner.replace(/\s+/g, '')}]`);
    return flat.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
  });
}

const isRow = (compound: string): boolean => /\.fx-row(?![\w-])/.test(compound);
const isSelected = (compound: string): boolean => /\[aria-selected=(["']?)true\1\]/.test(compound);

/** hex, rgb(a), hsl(a). `(?![\w-])` keeps `#fade-in` and the like out. */
const COLOR_LITERAL = /#[0-9a-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\s*\(/i;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Exact directory entry: the checkout sits on a case-insensitive filesystem. */
function exists(relPath: string): boolean {
  const slash = relPath.lastIndexOf('/');
  const dir = new URL(slash === -1 ? './' : relPath.slice(0, slash + 1), SRC_DIR);
  const base = relPath.slice(slash + 1);
  return existsSync(dir) && readdirSync(dir).includes(base) && statSync(new URL(relPath, SRC_DIR)).isFile();
}

function requireSources(paths: readonly string[]): void {
  const missing = paths.filter(p => !exists(p));
  assert.deepEqual(missing, [], `target files must exist before their design rules can be checked; missing: ${missing.map(p => `src/${p}`).join(', ')}`);
}

function walkExplorer(pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(new URL(rel, SRC_DIR), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
      else if (pattern.test(entry.name)) out.push(`${rel}${entry.name}`);
    }
  };
  walk(FX);
  return out;
}

function read(relPath: string): Lexed {
  const lexed = lex(readFileSync(new URL(relPath, SRC_DIR), 'utf8'), `src/${relPath}`);
  assert.ok(lexed.bare.trim().length > 0, `src/${relPath} is empty once comments are removed`);
  return lexed;
}

/** Every explorer .ts/.tsx: the named components plus whatever else the folder holds. */
function explorerScripts(): Lexed[] {
  requireSources(EXPLORER_TSX);
  return [...new Set([...EXPLORER_TSX, ...walkExplorer(/\.tsx?$/)])].map(read);
}

function explorerTsx(): Lexed[] {
  return explorerScripts().filter(s => s.path.endsWith('.tsx'));
}

/**
 * The explorer's CSS: every .css under the folder, recursively, and every .css
 * an explorer script imports by relative path. tokens.css is the one file
 * allowed to hold literals and is left out; an imported file that does not
 * exist fails rather than silently shrinking the set.
 */
function explorerCss(): CssFile[] {
  const srcPath = SRC_DIR.pathname;
  const found = new Map<string, URL>();
  for (const rel of walkExplorer(/\.css$/)) found.set(rel, new URL(rel, SRC_DIR));
  const missing = EXPLORER_TSX.filter(p => !exists(p));
  if (found.size === 0 && missing.length > 0) {
    assert.fail(`no css files in src/${FX}, and the components that would import one are missing: ${missing.map(p => `src/${p}`).join(', ')}`);
  }
  const add = (spec: string, from: URL, site: string): URL | null => {
    if (!spec.startsWith('.')) return null;
    const url = new URL(spec, from);
    const name = url.pathname.startsWith(srcPath) ? decodeURIComponent(url.pathname.slice(srcPath.length)) : url.pathname;
    assert.ok(existsSync(url), `${site} imports ${spec}, which does not exist`);
    if (found.has(name)) return null;
    found.set(name, url);
    return url;
  };
  // Static `import './x.css'` and dynamic `import('./x.css')` alike.
  const pending: URL[] = [...found.values()];
  for (const script of explorerScripts()) {
    const rel = script.path.slice('src/'.length);
    for (const m of script.code.matchAll(/\bimport\s*(?:\(\s*|[^'";()]*?\bfrom\s+)?(['"`])([^'"`]+\.css)(?:\?[^'"`]*)?\1/g)) {
      const url = add(m[2], new URL(rel, SRC_DIR), `${script.path}:${lineOf(script.code, m.index)}`);
      if (url) pending.push(url);
    }
  }
  // A stylesheet's own @import pulls another file into the explorer's styles.
  while (pending.length > 0) {
    const url = pending.pop()!;
    if (url.pathname.endsWith(`/${TOKENS}`)) continue;
    const text = stripCssComments(readFileSync(url, 'utf8'));
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/g)) {
      const next = add(m[2], url, `${url.pathname}:${lineOf(text, m.index)}`);
      if (next) pending.push(next);
    }
  }
  found.delete(TOKENS);
  assert.ok(found.size > 0, `no css files in the explorer set (src/${FX}**/*.css ∪ .css imported by explorer TS/TSX); a guard over no files approves everything`);
  return [...found].map(([name, url]) => ({ name: `src/${name}`, text: stripCssComments(readFileSync(url, 'utf8')) }));
}

function allRules(files: CssFile[]): CssRule[] {
  return files.flatMap(cssRules);
}

/** Names tokens.css declares on the three blocks the contract uses. */
function declaredTokens(): Set<string> {
  const text = stripCssComments(readFileSync(new URL(TOKENS, SRC_DIR), 'utf8'));
  const names = new Set<string>();
  for (const selector of [':root', '[data-surface="paper"]', '[data-density="compact"]']) {
    const at = text.indexOf(selector);
    assert.notEqual(at, -1, `tokens.css has no ${selector} block`);
    const open = text.indexOf('{', at);
    const body = text.slice(open + 1, closeBrace(text, open));
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]);
  }
  // The set is the reference the var() check leans on; if it were read empty,
  // every reference would look undeclared and the failure would mislead.
  for (const name of ['--bg-active', '--sel-bar', '--row-h', '--r-md']) assert.ok(names.has(name), `tokens.css read without ${name}`);
  return names;
}

/**
 * An attribute's value, with a `{name}` or `{f(…)}` value followed to the local
 * definitions it names: `className={rowClass}` is judged by what rowClass holds.
 */
function attrText(src: Lexed, tag: Span, attr: string): string | null {
  const text = src.bare.slice(tag.start, tag.end);
  const m = new RegExp(`\\s${attr}\\s*=\\s*`).exec(text);
  if (!m) return null;
  const at = tag.start + m.index + m[0].length;
  if (src.code[at] !== '{') return attrValue(src, tag, attr)?.code ?? null;
  const close = matchBracket(src.bare, at);
  return spansText(src, expand(src, { start: at + 1, end: close })).code;
}

/** The text of every `{...expr}` spread on a tag, followed to local definitions. */
function spreads(src: Lexed, tag: Span): string[] {
  const out: string[] = [];
  for (const m of src.bare.slice(tag.start, tag.end).matchAll(/\{\s*\.\.\./g)) {
    const open = tag.start + m.index;
    const close = matchBracket(src.bare, open);
    if (close !== -1) out.push(spansText(src, expand(src, { start: open + m[0].length, end: close })).code);
  }
  return out;
}

/** Every opening JSX tag in a file, whatever its name. */
function allOpeningTags(src: Lexed): Span[] {
  const names = new Set([...src.bare.matchAll(/<([A-Za-z][\w.]*)/g)].map(m => m[1]));
  return [...names].flatMap(name => openingTags(src, name.replace(/\./g, '\\.')))
    .filter((tag, k, all) => all.findIndex(o => o.start === tag.start) === k);
}

/** A tag's literal-keeping text with link targets blanked: `href="#abc"` is not a colour. */
function tagColorText(src: Lexed, tag: Span): string {
  return src.code.slice(tag.start, tag.end)
    .replace(/\b(?:href|xlinkHref|id|htmlFor|key)\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})/g, m => ' '.repeat(m.length));
}

function scanLiteral(files: { name: string; text: string }[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
      out.push(`${f.name}:${lineOf(f.text, m.index)} ${m[0]}`);
    }
  }
  return out;
}

/** Every explorer file as scannable text: CSS without comments, scripts without comments but with literals. */
function explorerTexts(): { name: string; text: string }[] {
  return [
    ...explorerCss().map(f => ({ name: f.name, text: f.text })),
    ...explorerScripts().map(s => ({ name: s.path, text: s.code })),
  ];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test('TC-REQ-CON-ARCH-001-AC10-01 DR-01: components/fileExplorer/ 재귀 순회 ∪ 탐색기 TS/TSX 가 import 하는 모든 .css 집합에 hex·rgb(a) 색 리터럴 0건 (집합이 비면 실패)', () => {
  const hits: string[] = [];
  for (const rule of allRules(explorerCss())) {
    for (const d of decls(rule)) {
      const m = COLOR_LITERAL.exec(unquoted(d.value));
      if (m) hits.push(`${cssAt(rule.file, d.at)} ${d.prop}: ${d.value}`);
    }
  }
  assert.deepEqual(hits, [], `colour literals in explorer CSS; use var(--token):\n${hits.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC10-07 DR-01: 탐색기 TSX 의 인라인 style={{…}} 에 hex·rgb(a) 리터럴 0건', () => {
  const hits: string[] = [];
  for (const src of explorerTsx()) {
    // Inside the tag: style={{…}}, fill="#fff", color="rgb(…)".
    for (const tag of allOpeningTags(src)) {
      const text = tagColorText(src, tag);
      const m = COLOR_LITERAL.exec(text);
      if (m) hits.push(`${src.path}:${lineOf(src.code, tag.start + m.index)} ${m[0]}`);
    }
    // style={rowStyle} — the object it names, followed to its definition.
    for (const h of handlerBodies(src, 'style')) {
      const m = COLOR_LITERAL.exec(spansText(src, h.spans).code);
      if (m) hits.push(`${src.path}:${lineOf(src.code, h.at)} style → ${m[0]}`);
    }
  }
  assert.deepEqual([...new Set(hits)], [], `colour literals in explorer JSX; use var(--token):\n${[...new Set(hits)].join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC11-11 DR-02 [이미 checked 된 AC-11 의 회귀 가드]: 새 CSS 의 모든 var(--x) 가 tokens.css 선언 또는 같은 파일 선언에 실재', () => {
  const tokens = declaredTokens();
  const unknown: string[] = [];
  for (const file of explorerCss()) {
    const local = new Set([...file.text.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map(m => m[1]));
    for (const m of file.text.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
      if (!tokens.has(m[1]) && !local.has(m[1])) unknown.push(`${cssAt(file, m.index)} ${m[1]}`);
    }
  }
  assert.deepEqual(unknown, [], `var() names declared neither in tokens.css nor in the same file:\n${unknown.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC10-03 DR-04: 새 CSS·TSX 에 #007acc·#0e639c 없음', () => {
  const hits = scanLiteral(explorerTexts(), /#(?:007acc|0e639c)(?![\w-])/i);
  assert.deepEqual(hits, [], `the old VS Code accent pair; the one accent is var(--accent):\n${hits.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC10-04 DR-05: 새 UI 파일에 #7c3aed·#8250df·#a78bfa·#6639ba 없음', () => {
  const hits = scanLiteral(explorerTexts(), /#(?:7c3aed|8250df|a78bfa|6639ba)(?![\w-])/i);
  assert.deepEqual(hits, [], `violet is reserved for editor syntax highlighting:\n${hits.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC7-11 DR-07 [이미 checked 된 AC-7 의 회귀 가드]: 새 파일에 \'atomic-editor\' 문자열 없음', () => {
  const hits = scanLiteral(explorerTexts(), /atomic-editor/);
  assert.deepEqual(hits, [], `the vendored editor's palette stays apart from the explorer:\n${hits.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC10-06 DR-10: [aria-selected="true"] 행 규칙이 정확히 하나 존재하고 background:var(--bg-active)·border-left-color:var(--sel-bar) 를 갖고 색 리터럴이 없다', () => {
  const selected = allRules(explorerCss()).filter(r => subjects(r.selector).some(c => isRow(c) && isSelected(c)));
  assert.equal(selected.length, 1, `expected exactly one .fx-row[aria-selected="true"] rule, found ${selected.length}: ${selected.map(r => `${cssAt(r.file, r.at)} ${r.selector}`).join(' | ') || 'none'}`);
  const rule = selected[0];
  const ds = decls(rule);
  const value = (prop: string) => ds.filter(d => d.prop === prop).map(d => d.value);
  const background = [...value('background'), ...value('background-color')];
  assert.deepEqual(background, ['var(--bg-active)'], `${cssAt(rule.file, rule.at)} selected-row background must be var(--bg-active) alone`);
  assert.deepEqual(value('border-left-color'), ['var(--sel-bar)'], `${cssAt(rule.file, rule.at)} selected-row bar must be border-left-color: var(--sel-bar)`);
  const full = ds.filter(d => d.prop === 'border' || d.prop === 'border-color');
  assert.deepEqual(full.map(d => d.prop), [], `${cssAt(rule.file, rule.at)} the selection marks the left edge only, not a full border`);
  const literal = ds.filter(d => COLOR_LITERAL.test(unquoted(d.value))).map(d => `${d.prop}: ${d.value}`);
  assert.deepEqual(literal, [], `${cssAt(rule.file, rule.at)} colour literal in the selected-row rule`);
});

test('TC-REQ-CON-ARCH-001-AC3-01 DR-03: fileExplorer/*.ts(x) 가 dataset.surface·getAttribute(\'data-surface\')·surface prop·\'chrome\'/\'paper\' 비교를 갖지 않는다 (JSX 속성값 위치 제외)', () => {
  const hits: string[] = [];
  for (const src of explorerScripts()) {
    const at = (k: number) => `${src.path}:${lineOf(src.code, k)}`;
    // Any identifier named surface: dataset.surface, props.surface, { surface }, surface={…}.
    for (const m of src.bare.matchAll(/(?<![\w$-])(?:surface|dataSurface)(?![\w$-])/g)) hits.push(`${at(m.index)} identifier ${m[0]}`);
    // data-surface written inside a string is a read (getAttribute, closest,
    // matches, querySelector); as a JSX attribute name it is kept in bare.
    for (const m of src.code.matchAll(/data-surface/g)) {
      if (src.bare.slice(m.index, m.index + m[0].length) !== m[0]) hits.push(`${at(m.index)} 'data-surface' inside a literal`);
    }
    // 'chrome' / 'paper' as a value anywhere except the value of a data-surface attribute.
    for (const m of src.code.matchAll(/(['"`])(chrome|paper)\1/g)) {
      const before = src.code.slice(Math.max(0, m.index - 40), m.index);
      if (!/data-surface\s*=\s*\{?\s*$/.test(before)) hits.push(`${at(m.index)} ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `components must not know which surface they sit on; the host sets data-surface:\n${hits.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC6-11 DR-06 [이미 checked 된 AC-6 의 회귀 가드]: .fx-row{height:var(--row-h)} 규칙이 1개 이상 존재하고 행 선택자 height 에 px 리터럴 없음', () => {
  const rows = allRules(explorerCss()).filter(r => subjects(r.selector).some(isRow));
  const sized = rows.filter(r => decls(r).some(d => d.prop === 'height' && d.value === 'var(--row-h)'));
  assert.ok(sized.length >= 1, `no .fx-row rule sets height: var(--row-h); row rules found: ${rows.map(r => r.selector).join(' | ') || 'none'}`);
  const literal: string[] = [];
  for (const r of rows) {
    for (const d of decls(r)) {
      // Any number is a height the token does not set — px, %, vh, calc(…) alike.
      if (/^(?:min-|max-)?height$/.test(d.prop) && /\d/.test(d.value.replace(/var\(--row-h\)/g, ''))) literal.push(`${cssAt(r.file, d.at)} ${r.selector} { ${d.prop}: ${d.value} }`);
    }
  }
  assert.deepEqual(literal, [], `row height comes from var(--row-h) only:\n${literal.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC3-03 DR-11(탐색기 쪽): FileExplorerWindow 루트에 data-surface="paper" 가 없다', () => {
  requireSources([T.window]);
  const src = read(T.window);
  const hits = [...src.code.matchAll(/data-surface\s*=\s*\{?\s*(['"`])paper\1/g)].map(m => `${src.path}:${lineOf(src.code, m.index)}`);
  assert.deepEqual(hits, [], `the explorer window is chrome, the :root default; paper belongs to the editor's tree panel:\n${hits.join('\n')}`);
});

/** Space-separated parts of a value, keeping `calc(a * b)` whole. */
function radiusParts(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A radius part that comes from the scale: the token itself, `0` (no corner),
 * or a calc() built on a token — the mockup's tab shape is
 * `calc(var(--r-sm) * var(--tab-shape))`. A calc() with no --r-* in it is a
 * literal in disguise.
 */
function radiusFromToken(part: string): boolean {
  if (part === '0' || /^var\(--r-(?:sm|md|lg)\)$/.test(part)) return true;
  return /^calc\(.*\)$/.test(part) && /var\(--r-(?:sm|md|lg)\)/.test(part);
}

test('TC-REQ-CON-ARCH-001-AC3-04 DR-19: 새 CSS 의 border-radius 는 var(--r-sm|md|lg) 만', () => {
  const bad: string[] = [];
  for (const rule of allRules(explorerCss())) {
    for (const d of decls(rule)) {
      if (!/^border(?:-[a-z]+)*-radius$/.test(d.prop)) continue;
      if (!radiusParts(d.value).every(radiusFromToken)) bad.push(`${cssAt(rule.file, d.at)} ${d.prop}: ${d.value}`);
    }
  }
  assert.deepEqual(bad, [], `radius comes from var(--r-sm|md|lg) only:\n${bad.join('\n')}`);
});

test('TC-REQ-CON-ARCH-001-AC3-05 FileTreeView·FileListView 의 노드 행이 className 에 fx-row 를 쓰고 aria-selected 를 건다 — DR-06·DR-10 규칙이 실제 요소에 걸림', () => {
  requireSources(ROW_VIEWS);
  const missing: string[] = [];
  for (const path of ROW_VIEWS) {
    const src = read(path);
    const rowTags = allOpeningTags(src).filter((tag) => {
      const cls = attrText(src, tag, 'className');
      const aria = attrValue(src, tag, 'aria-selected') !== null
        || spreads(src, tag).some(text => /['"]?aria-selected['"]?\s*:/.test(text));
      return cls !== null && /(?<![\w-])fx-row(?![\w-])/.test(cls) && aria;
    });
    if (rowTags.length === 0) missing.push(`src/${path}`);
  }
  assert.deepEqual(missing, [], `no element with className "fx-row" and aria-selected — the row rules style nothing:\n${missing.join('\n')}`);
});

// ---------------------------------------------------------------------------
// The readers themselves. Stays green; a reader that miscounts makes every
// rule above approve what it cannot see.
// ---------------------------------------------------------------------------

test('scanner: CSS 규칙·주어 compound·JSX 태그 색 판독을 올바로 한다', () => {
  const file: CssFile = {
    name: 'fixture.css',
    text: stripCssComments([
      '/* .fx-row[aria-selected="true"] { background: #fff } */',
      '.fx-row { height: var(--row-h); }',
      '@media (max-width: 600px) { .fx-list .fx-row[aria-selected = "true"] { background: var(--bg-active); } }',
      '.fx-row.lrow[aria-selected="true"] .cmt { color: var(--fg); }',
      '.tab[aria-selected="true"] { color: var(--fg-strong); }',
      '#fade-in { opacity: 1; }',
    ].join('\n')),
  };
  const rules = cssRules(file);
  assert.equal(rules.length, 5, 'the commented rule is gone; the @media child is read');
  const selected = rules.filter(r => subjects(r.selector).some(c => isRow(c) && isSelected(c)));
  assert.deepEqual(selected.map(r => r.selector), ['.fx-list .fx-row[aria-selected = "true"]'], 'only a rule whose subject is the selected row counts');
  assert.equal(lineOf(file.text, selected[0].at), 3, 'offsets survive comment stripping');
  assert.equal(COLOR_LITERAL.test(decls(rules[4])[0].value), false);
  assert.equal(COLOR_LITERAL.test('#fade-in'), false, 'an id-like word is not a colour');
  assert.equal(COLOR_LITERAL.test('rgba(0, 0, 0, .1)'), true);
  assert.throws(() => cssRules({ name: 'n.css', text: '.a { .fx-row { height: 1px; } }' }), /nested CSS/);

  const src = lex('const a = <svg><use href="#abc" /><path fill="#0e639c" /><div className={`fx-row ${x}`} aria-selected={s} style={rowStyle} /></svg>;\nconst rowStyle = { color: \'#fff\' };', 'fixture.tsx');
  const colours = allOpeningTags(src).map(t => COLOR_LITERAL.exec(tagColorText(src, t))?.[0]).filter(Boolean);
  assert.deepEqual(colours, ['#0e639c'], 'href="#abc" is a link target; fill="#0e639c" is a colour');
  assert.match(spansText(src, handlerBodies(src, 'style')[0].spans).code, /#fff/, 'style={name} is followed to its object');
  const row = allOpeningTags(src).find(t => attrValue(src, t, 'className') !== null)!;
  assert.match(attrValue(src, row, 'className')!.code, /fx-row/);
  assert.notEqual(attrValue(src, row, 'aria-selected'), null);
});
