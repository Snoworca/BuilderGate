import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// FR-MDE-012 AC-1..13 · FR-FEX-005 AC-7 — how the editor window hosts its left
// file-tree pane.
//
// The decisions behind the pane (widths, root, which right clicks open the
// window menu, folding, shortcut focus) are pure functions in
// editorFileTreePaneModel.ts, pinned by editorFileTreePane.test.ts. What only
// source can show is that the window and the pane route through them, so these
// are source guards held to the rules fileExplorerWiring.test.ts sets:
//
// - Prose and literals neither trip nor satisfy a check. The scanner is copied
//   from fileExplorerWindowModalWiring.test.ts (importing a *.test.ts registers
//   its tests a second time): comments are removed while strings, templates,
//   regex literals and JSX text are respected, and a view with every literal
//   blanked is kept beside it.
// - No empty sets. Every target is named and its existence asserted in every
//   case before its contents are judged. EditorFileTreePane.tsx and
//   useFileTreeOperations.ts are created by later steps, so their absence is a
//   failure, never a pass.
//
// Names that come from the model (clampPaneDragWidth, resetPaneWidth,
// renderPaneWidth, applyPaneDrag, resolvePaneRoot, isEditorWindowMenuTarget,
// buildEditorWindowContextMenu, paneInitiallyCollapsed, collapseAfterOpen,
// decidePaneShortcutFocus), from storage (saveEditorTreePaneState,
// readEditorTreePaneState) and the two new modules (EditorFileTreePane,
// useFileTreeOperations) are pinned. State names, prop names and helper names
// are the wiring step's to choose, so they are followed by shape: a value
// counts as "from X" when it is bound to X, directly or through local
// declarations, or through a prop the window feeds into <EditorFileTreePane>.

const SRC_DIR = new URL('../../src/', import.meta.url);
const ED = 'components/editor/';
const FX = 'components/fileExplorer/';

const T = {
  window: `${ED}EditorWindow.tsx`,
  pane: `${ED}EditorFileTreePane.tsx`,
  windowCss: `${ED}EditorWindow.css`,
  documentPanel: `${ED}EditorDocumentPanel.tsx`,
  opsHook: 'hooks/useFileTreeOperations.ts',
  explorer: `${FX}FileExplorerWindow.tsx`,
  treeView: `${FX}FileTreeView.tsx`,
  app: 'App.tsx',
} as const;

// The two files the pane's wiring may live in. Which of them holds a given
// piece (the splitter, the width state, the menu) is the wiring step's call.
const PANE_SIDE = [T.window, T.pane] as const;


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

/**
 * `const NAME = …`, `const { … } = …` and `const [ … ] = …` inside `span`: the
 * names bound and the initializer. The array form is added to the copy because
 * the pane's width and fold state are `const [value, setValue] = useState(…)`.
 */
function declarationsIn(src: Lexed, span: Span): { names: string[]; init: Span }[] {
  const out: { names: string[]; init: Span }[] = [];
  const text = src.bare.slice(span.start, span.end);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\{([^}]*)\}|\[([^\]]*)\])\s*(?::[^=;]+)?=(?!=)/g)) {
    const names = m[1] !== undefined ? [m[1]]
      : m[2] !== undefined ? bindingPairs(m[2]).map(p => p.local)
        : m[3].split(',').map(part => part.trim().replace(/^\.\.\./, '').split('=')[0].trim()).filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
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
      if (!refers(src.bare.slice(d.init.start, d.init.end), out)) continue;
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


// ---------------------------------------------------------------------------
// Pane helpers
// ---------------------------------------------------------------------------

const WHOLE = (src: Lexed): Span => ({ start: 0, end: src.bare.length });

/**
 * Whether `text` uses one of `names` as a value. Stricter than a word match in
 * two ways the pane needs: `saved.width` is a property of `saved`, not a use
 * of a local `width`, and `{ width: next }` names a key, not a value. A dotted
 * name (`props.onOpenFile`) matches literally.
 */
function refers(text: string, names: Iterable<string>): boolean {
  for (const name of names) {
    const escaped = name.replace(/[$.]/g, (c) => `\\${c}`);
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, 'g'))) {
      const before = text.slice(0, m.index).trimEnd().slice(-1);
      const after = text.slice(m.index + m[0].length).trimStart();
      const isKey = (before === '{' || before === ',') && after.startsWith(':') && !after.startsWith('::');
      if (!isKey) return true;
    }
  }
  return false;
}

/**
 * Names in `src` bound to something matching `root`: every declaration whose
 * initializer matches it, `seeds`, and everything declared from those in turn.
 * `const [a, setA] = …` counts as well as `const a = …` and `const { a } = …`.
 */
function boundTo(src: Lexed, root: RegExp, seeds: Iterable<string> = []): Set<string> {
  const start = new Set(seeds);
  for (const d of declarationsIn(src, WHOLE(src))) {
    if (root.test(src.bare.slice(d.init.start, d.init.end))) d.names.forEach(n => start.add(n));
  }
  return closeOver(src, WHOLE(src), start);
}

/** The local each prop of the pane component lands in, keyed by prop name. */
function paneProps(pane: Lexed): Map<string, string> {
  const out = new Map<string, string>();
  const decl = /\bEditorFileTreePane\s*(?:=\s*(?:memo\s*\(\s*)?(?:function\s*[\w$]*\s*)?|\s*)\(\s*/.exec(pane.bare)
    ?? /\bfunction\s+EditorFileTreePane\s*\(\s*/.exec(pane.bare);
  if (decl === null) return out;
  const at = decl.index + decl[0].length;
  if (pane.bare[at] === '{') {
    const pattern = pane.bare.slice(at + 1, matchBracket(pane.bare, at));
    for (const { key, local } of bindingPairs(pattern)) out.set(key, local);
    return out;
  }
  const param = /^([A-Za-z_$][\w$]*)/.exec(pane.bare.slice(at));
  if (param !== null) {
    for (const m of pane.bare.matchAll(new RegExp(`(?<![\\w$])${param[1]}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) {
      out.set(m[1], `${param[1]}.${m[1]}`);
    }
  }
  return out;
}

type Flow = (src: Lexed, text: string) => boolean;

/**
 * Whether a piece of text in the window or the pane is bound to `root`: in the
 * window through its own declarations; in the pane through its own
 * declarations or through a prop the window fed from something bound to it.
 */
function flow(win: Lexed, pane: Lexed | null, root: RegExp): Flow {
  const winNames = boundTo(win, root);
  const fed = new Set<string>();
  for (const tag of openingTags(win, 'EditorFileTreePane')) {
    for (const m of win.bare.slice(tag.start, tag.end).matchAll(/\s([A-Za-z_$][\w$]*)\s*=\s*\{/g)) {
      const value = attrValue(win, tag, m[1]);
      if (value !== null && (root.test(value.bare) || refers(value.bare, winNames))) fed.add(m[1]);
    }
  }
  const props = pane === null ? new Map<string, string>() : paneProps(pane);
  const seeds = [...fed].flatMap(key => (props.has(key) ? [props.get(key) as string] : []));
  const paneNames = pane === null ? new Set<string>() : boundTo(pane, root, seeds);
  return (src, text) => root.test(text) || refers(text, src === win ? winNames : paneNames);
}

/** The arguments of a call, split at depth-0 commas. */
function args(src: Lexed, list: Span): Span[] {
  const out: Span[] = [];
  let start = list.start;
  while (start < list.end) {
    while (start < list.end && /\s/.test(src.bare[start])) start += 1;
    if (start >= list.end) break;
    const expr = readExpression(src.bare, start);
    out.push({ start: expr.start, end: Math.min(expr.end, list.end) });
    start = expr.end + 1;
  }
  return out;
}

function text(src: Lexed, span: Span | null): { code: string; bare: string } {
  return span === null ? { code: '', bare: '' } : slice(src, span);
}

/** Each call of `name` with the file it is in, over several files. */
function callsIn(files: Lexed[], name: string): { src: Lexed; list: Span }[] {
  return files.flatMap(src => callArgs(src, name).map(list => ({ src, list })));
}

interface JsxNode {
  name: string;
  tag: Span;
  /** One past the element's closing tag (its tag end if self-closing). */
  end: number;
  parent: JsxNode | null;
  children: JsxNode[];
}

// `<` opens an element where an expression may start, as in the lexer: after
// one of these, or after `return` and friends. `useRef<HTMLDivElement>` and
// `KeyboardEvent<T>` follow an identifier and stay types.
function opensJsx(bare: string, k: number): boolean {
  let j = k - 1;
  while (j >= 0 && /\s/.test(bare[j])) j -= 1;
  if (j < 0 || '(,=:?&|{};[!>'.includes(bare[j])) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(bare.slice(Math.max(0, j - 12), j + 1));
  return word !== null && JSX_KEYWORDS.test(word[1]);
}

/** Every JSX element of a file as a forest, built from the blanked view. */
function jsxForest(src: Lexed): JsxNode[] {
  const roots: JsxNode[] = [];
  const stack: JsxNode[] = [];
  const b = src.bare;
  for (let k = 0; k < b.length; k += 1) {
    if (b[k] !== '<') continue;
    if (b[k + 1] === '/') {
      const m = /^<\/\s*([A-Za-z][\w.]*)?\s*>/.exec(b.slice(k, k + 200));
      if (m === null) continue;
      const name = m[1] ?? '';
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s].name !== name) continue;
        stack[s].end = k + m[0].length;
        stack.length = s;
        break;
      }
      k += m[0].length - 1;
      continue;
    }
    if (!/[A-Za-z>]/.test(b[k + 1] ?? '') || !opensJsx(b, k)) continue;
    const tag = tagAt(src, k);
    const name = /^<([A-Za-z][\w.]*)?/.exec(b.slice(k, tag.end))?.[1] ?? '';
    const parent = stack[stack.length - 1] ?? null;
    const node: JsxNode = { name, tag, end: tag.end, parent, children: [] };
    (parent === null ? roots : parent.children).push(node);
    if (!b.slice(tag.start, tag.end).endsWith('/>')) stack.push(node);
    k = tag.end - 1;
  }
  return roots;
}

function allNodes(roots: JsxNode[]): JsxNode[] {
  return roots.flatMap(n => [n, ...allNodes(n.children)]);
}

function holds(node: JsxNode, name: string): boolean {
  return node.children.some(c => c.name === name || holds(c, name));
}

function nodeAt(src: Lexed, index: number): JsxNode | null {
  return allNodes(jsxForest(src)).find(n => n.tag.start <= index && index < n.tag.end) ?? null;
}

/** The handler bodies of `attr` on the element whose tag is `tag`, expanded. */
function handlersOnTag(src: Lexed, tag: Span, attr: string): { code: string; bare: string } | null {
  const h = handlerBodies(src, attr).find(x => tag.start <= x.at && x.at < tag.end);
  return h === undefined ? null : spansText(src, h.spans);
}

/** Literal characters only: everything the blanked view blanked. */
function literalText(value: { code: string; bare: string }): string {
  let out = '';
  for (let k = 0; k < value.code.length; k += 1) out += value.code[k] === value.bare[k] ? ' ' : value.code[k];
  return out;
}

function classTokens(src: Lexed, tag: Span): string[] {
  const value = attrValue(src, tag, 'className');
  return value === null ? [] : literalText(value).match(/[A-Za-z_-][\w-]*/g) ?? [];
}

/** Stylesheets the window and the pane import, plus the window's own. */
function paneCss(files: Lexed[]): CssRule[] {
  const paths = new Set<string>([T.windowCss]);
  for (const src of files) {
    const dir = src.path.replace(/^src\//, '').replace(/[^/]*$/, '');
    for (const m of src.code.matchAll(/import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/g)) {
      paths.add(new URL(m[1], new URL(dir, SRC_DIR)).href.slice(SRC_DIR.href.length));
    }
  }
  return [...paths].filter(exists).flatMap(p => cssRules(readCss(p)));
}

function rulesForClass(rules: CssRule[], cls: string): CssRule[] {
  const re = new RegExp(`\\.${cls}(?![\\w-])`);
  return rules.filter(r => re.test(r.selector));
}

/** The flex direction an element is laid out in, from its style object or its classes. */
function directionOf(src: Lexed, node: JsxNode, rules: CssRule[]): 'row' | 'column' | null {
  const style = attrValue(src, node.tag, 'style');
  let styleCode = style?.code ?? '';
  const id = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(style?.bare ?? '');
  if (id !== null) {
    const def = definitionOf(src, id[1]);
    if (def !== null) styleCode = src.code.slice(def.start, def.end);
  }
  const bodies = [styleCode, ...classTokens(src, node.tag).flatMap(c => rulesForClass(rules, c).map(r => r.body))].join('\n');
  const dir = /(?:flexDirection\s*:\s*['"]|flex-direction\s*:\s*)(row|column)/.exec(bodies);
  if (dir !== null) return dir[1] as 'row' | 'column';
  if (/display\s*:\s*['"]?(?:inline-)?flex\b/.test(bodies)) return 'row';
  if (/display\s*:\s*['"]?grid\b/.test(bodies) && /grid-?[Tt]emplate-?[Cc]olumns/.test(bodies)) return 'row';
  return null;
}

/** Spans of every effect body and ResizeObserver callback in `src`. */
function effectSpans(src: Lexed): Span[] {
  return [
    ...callArgs(src, 'useEffect'),
    ...callArgs(src, 'useLayoutEffect'),
    ...[...src.bare.matchAll(/\bnew\s+ResizeObserver\s*\(/g)].map(m => {
      const open = m.index + m[0].length - 1;
      return { start: open + 1, end: matchBracket(src.bare, open) };
    }),
  ];
}

const POINTER_LISTENER = /addEventListener\s*\(\s*['"](?:pointerup|pointermove|pointercancel|lostpointercapture)['"]/;
const MOBILE = /\b(?:useResponsive|isMobile|placeable)\b/;

function loadSide(): { win: Lexed; pane: Lexed; files: Lexed[] } {
  requireSources([...PANE_SIDE]);
  const win = read(T.window);
  const pane = read(T.pane);
  return { win, pane, files: [win, pane] };
}

// ---------------------------------------------------------------------------
// AC-8 — one code path for file operations
// ---------------------------------------------------------------------------

// Every file operation the explorer tab panel performs today. After the
// extraction each is performed by useFileTreeOperations and by nothing else.
const FILE_OPS: { label: string; re: RegExp }[] = [
  { label: 'copySelection(', re: /(?<![\w$.])copySelection\s*\(/ },
  { label: 'cutSelection(', re: /(?<![\w$.])cutSelection\s*\(/ },
  { label: 'pasteFromClipboard(', re: /(?<![\w$.])pasteFromClipboard\s*\(/ },
  { label: 'requestDelete(', re: /(?<![\w$.])requestDelete\s*\(/ },
  { label: 'fileApi.moveFile(', re: /\bfileApi\s*\.\s*moveFile\s*\(/ },
  { label: 'fileApi.createDirectory(', re: /\bfileApi\s*\.\s*createDirectory\s*\(/ },
  { label: 'buildFileExplorerContextMenuItems(', re: /(?<![\w$.])buildFileExplorerContextMenuItems\s*\(/ },
];

// Where a second copy of the operations could plausibly grow. The modules that
// define the operations are excluded, and so is useFileBrowser.ts: it belongs
// to the unmounted Mdir FileManager (see CLAUDE.md) and predates the explorer.
const OPS_SCOPE_DIRS = [FX, ED] as const;
const OPS_DEFINERS = new Set([
  `${FX}fileExplorerClipboard.ts`,
  `${FX}fileJobClient.ts`,
  `${FX}fileExplorerContextMenu.ts`,
  'hooks/useFileBrowser.ts',
]);

function tsFilesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, SRC_DIR), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`);
      else if (/\.tsx?$/.test(entry.name)) out.push(`${dir}${entry.name}`);
    }
  };
  walk(rel);
  return out;
}

function hooksFiles(): string[] {
  return readdirSync(new URL('hooks/', SRC_DIR)).filter(n => /\.tsx?$/.test(n)).map(n => `hooks/${n}`);
}

/** The context literal of each useFileTreeOperations call inside `span`. */
function opsContexts(src: Lexed, span: Span): string[] {
  return callArgs(src, 'useFileTreeOperations')
    .filter(list => span.start <= list.start && list.end <= span.end)
    .map(list => {
      const first = args(src, list)[0] ?? null;
      const value = first === null ? null : propertyValue(src, first, 'context');
      let code = text(src, value).code.trim();
      const id = /^[A-Za-z_$][\w$]*$/.exec(code);
      if (id !== null) {
        const def = definitionOf(src, id[0]);
        if (def !== null) code = src.code.slice(def.start, def.end).trim();
      }
      return /^['"]([\w-]+)['"]$/.exec(code)?.[1] ?? `<not a literal: ${code}>`;
    });
}

test('TC-REQ-FR-MDE-012-AC8-02 useFileTreeOperations 훅이 존재하고 FileExplorerTabPanel 과 EditorFileTreePane 이 둘 다 그것으로 메뉴·클립보드·붙여넣기·삭제·이름 바꾸기·새 폴더를 수행한다(경로 하나)', () => {
  requireSources([T.opsHook, T.explorer, T.pane]);
  const hook = read(T.opsHook);
  assert.match(hook.bare, /\bexport\s+(?:function\s+useFileTreeOperations\s*\(|const\s+useFileTreeOperations\s*=)/,
    `${hook.path} must export useFileTreeOperations`);
  const missing = FILE_OPS.filter(op => !op.re.test(hook.bare)).map(op => op.label);
  assert.deepEqual(missing, [], `${hook.path} must perform every file operation itself; missing: ${missing.join(', ')}`);

  // The explorer's tab panel: one call, in the panel, as the explorer window.
  const explorer = read(T.explorer);
  const panelFn = /\bfunction\s+FileExplorerTabPanel\s*\(/.exec(explorer.bare);
  assert.ok(panelFn !== null, `${explorer.path}: function FileExplorerTabPanel is gone`);
  const panelBrace = explorer.bare.indexOf('{', matchBracket(explorer.bare, panelFn.index + panelFn[0].length - 1));
  const panelSpan = { start: panelBrace, end: matchBracket(explorer.bare, panelBrace) + 1 };
  assert.deepEqual(opsContexts(explorer, panelSpan), ['explorer-window'],
    `${explorer.path}: FileExplorerTabPanel must call useFileTreeOperations({ context: 'explorer-window', … }) exactly once`);

  // The pane: one call, as the editor panel, with no new-tab route.
  const pane = read(T.pane);
  assert.deepEqual(opsContexts(pane, WHOLE(pane)), ['editor-panel'],
    `${pane.path} must call useFileTreeOperations({ context: 'editor-panel', … }) exactly once`);
  const paneCall = callArgs(pane, 'useFileTreeOperations')[0];
  const paneArg = args(pane, paneCall)[0];
  assert.equal(propertyValue(pane, paneArg, 'onNewTab'), null,
    `${where(pane, paneCall.start)}: the pane has no tabs, so it passes no onNewTab (AC-8)`);

  // Both callers draw the hook's menu and run the hook's shortcuts.
  for (const src of [explorer, pane]) {
    const fromHook = boundTo(src, /\buseFileTreeOperations\s*\(/);
    const menus = openingTags(src, 'ContextMenu').filter(tag => refers(attrValue(src, tag, 'items')?.bare ?? '', fromHook));
    assert.ok(menus.length >= 1, `${src.path}: the file menu's items must come from useFileTreeOperations`);
  }
  const paneOps = boundTo(pane, /\buseFileTreeOperations\s*\(/);
  const shortcutRuns = callArgs(pane, 'createFileExplorerShortcutHandler')
    .map(list => propertyValue(pane, args(pane, list)[0] ?? list, 'run'))
    .filter((v): v is Span => v !== null && refers(text(pane, v).bare, paneOps));
  assert.ok(shortcutRuns.length >= 1, `${pane.path}: the shortcut handler's run must go to useFileTreeOperations`);

  // No second copy: outside the hook, nothing on the explorer or editor side
  // performs a file operation.
  const scope = [...OPS_SCOPE_DIRS.flatMap(tsFilesUnder), ...hooksFiles()].filter(p => !OPS_DEFINERS.has(p));
  const holders = scope.filter((p) => {
    const src = lex(readFileSync(new URL(p, SRC_DIR), 'utf8'), `src/${p}`);
    return FILE_OPS.some(op => op.re.test(src.bare));
  }).sort();
  assert.deepEqual(holders, [T.opsHook], `file operations must live only in src/${T.opsHook}; also found in: ${holders.filter(p => p !== T.opsHook).map(p => `src/${p}`).join(', ')}`);
});

// ---------------------------------------------------------------------------
// AC-1 — the body's layout
// ---------------------------------------------------------------------------

test('TC-REQ-FR-MDE-012-AC1-01 EditorWindow 본문이 가로 배치이고 EditorFileTreePane 이 첫 자식, EditorTabBar 와 EditorDocumentPanel 들이 오른쪽 세로 래퍼 안에 있다', () => {
  const { win, files } = loadSide();
  const rules = paneCss(files);
  const nodes = allNodes(jsxForest(win));
  const panes = nodes.filter(n => n.name === 'EditorFileTreePane');
  assert.equal(panes.length, 1, `${win.path} must render <EditorFileTreePane> exactly once, found ${panes.length}`);
  const pane = panes[0];
  const row = pane.parent;
  assert.ok(row !== null, `${where(win, pane.tag.start)}: <EditorFileTreePane> must sit inside the window body`);
  let inDialog = false;
  for (let n: JsxNode | null = row; n !== null; n = n.parent) if (n.name === 'WindowDialog') inDialog = true;
  assert.ok(inDialog, `${where(win, row.tag.start)}: the pane's row must be inside <WindowDialog>`);
  assert.equal(row.children[0], pane, `${where(win, row.tag.start)}: <EditorFileTreePane> must be the body row's first child (left)`);
  assert.equal(directionOf(win, row, rules), 'row', `${where(win, row.tag.start)}: the body holding the pane must be laid out horizontally`);

  const columns = row.children.slice(1).filter(c => holds(c, 'EditorTabBar') && holds(c, 'EditorDocumentPanel'));
  assert.equal(columns.length, 1, `${where(win, row.tag.start)}: one wrapper right of the pane must hold <EditorTabBar> and the <EditorDocumentPanel>s`);
  const column = columns[0];
  assert.equal(directionOf(win, column, rules), 'column', `${where(win, column.tag.start)}: the document wrapper must stack vertically`);
  const inColumn = allNodes(column.children);
  const bar = inColumn.findIndex(n => n.name === 'EditorTabBar');
  const doc = inColumn.findIndex(n => n.name === 'EditorDocumentPanel');
  assert.ok(bar !== -1 && doc !== -1 && bar < doc, `${where(win, column.tag.start)}: the tab bar sits above the document panels`);
  const outside = nodes.filter(n => (n.name === 'EditorTabBar' || n.name === 'EditorDocumentPanel')
    && !(column.tag.start <= n.tag.start && n.tag.start < column.end));
  assert.deepEqual(outside.map(n => where(win, n.tag.start)), [], 'no tab bar or document panel may be drawn outside the document wrapper');
});

// ---------------------------------------------------------------------------
// AC-2 / AC-4 — the window menu
// ---------------------------------------------------------------------------

test('TC-REQ-FR-MDE-012-AC2-02 onContextMenu 가 탭 막대 빈 곳과 제목 표시줄에만 붙고 isEditorWindowMenuTarget 을 거치며 EditorDocumentPanel 에는 없다', () => {
  requireSources([T.window, T.pane, T.documentPanel]);
  const win = read(T.window);
  const doc = read(T.documentPanel);
  const handlers: { at: number; code: string; bare: string }[] = [
    ...handlerBodies(win, 'onContextMenu').map(h => ({ at: h.at, ...spansText(win, h.spans) })),
  ];
  // A titlebar the window does not render can only be reached with a native
  // listener; its handler is whatever is passed after the event name.
  for (const m of win.code.matchAll(/addEventListener\s*\(\s*['"]contextmenu['"]\s*,/g)) {
    const open = win.bare.lastIndexOf('(', m.index + m[0].length);
    const second = args(win, { start: open + 1, end: matchBracket(win.bare, open) })[1];
    if (second !== undefined) handlers.push({ at: m.index, ...spansText(win, expand(win, second)) });
  }
  assert.ok(handlers.length >= 1, `${win.path}: the window menu needs a right-click handler`);
  for (const h of handlers) {
    assert.match(h.bare, /\bisEditorWindowMenuTarget\s*\(/, `${where(win, h.at)}: every window right-click must go through isEditorWindowMenuTarget`);
  }
  const all = handlers.map(h => h.code).join('\n');
  for (const target of ['tabbar-empty', 'titlebar-empty']) {
    assert.match(all, new RegExp(`['"]${target}['"]`), `${win.path}: a right-click handler must classify '${target}'`);
  }
  // Not on the document, nor on anything around it: the editor keeps the
  // browser's own menu.
  for (const h of handlerBodies(win, 'onContextMenu')) {
    const node = nodeAt(win, h.at);
    assert.ok(node !== null, `${where(win, h.at)}: onContextMenu outside an element`);
    assert.ok(node.name !== 'EditorDocumentPanel' && !holds(node, 'EditorDocumentPanel'),
      `${where(win, h.at)}: onContextMenu must not sit on or around <EditorDocumentPanel>`);
  }
  assert.doesNotMatch(doc.bare, /\bonContextMenu\b/, `${doc.path} must not take right clicks`);
  assert.doesNotMatch(doc.code, /addEventListener\s*\(\s*['"]contextmenu['"]/, `${doc.path} must not take right clicks`);
});

test('TC-REQ-FR-MDE-012-AC4-02 창 메뉴가 buildEditorWindowContextMenu({paneOpen}) 로 만들어진다', () => {
  const { win } = loadSide();
  const calls = callArgs(win, 'buildEditorWindowContextMenu');
  assert.ok(calls.length >= 1, `${win.path} must build the window menu with buildEditorWindowContextMenu`);
  for (const list of calls) {
    const obj = args(win, list)[0] ?? null;
    assert.ok(obj !== null, `${where(win, list.start)}: buildEditorWindowContextMenu needs its input`);
    const open = propertyValue(win, obj, 'paneOpen');
    assert.ok(open !== null, `${where(win, list.start)}: the menu must be told whether the pane is open (paneOpen)`);
    assert.doesNotMatch(text(win, open).bare.trim(), /^(?:true|false)$/, `${where(win, open.start)}: paneOpen must be the pane's state, not a constant`);
    assert.ok(propertyValue(win, obj, 'onTogglePane') !== null, `${where(win, list.start)}: the menu item must toggle the pane (onTogglePane)`);
  }
  const built = boundTo(win, /\bbuildEditorWindowContextMenu\s*\(/);
  const drawn = openingTags(win, 'ContextMenu').filter((tag) => {
    const items = attrValue(win, tag, 'items')?.bare ?? '';
    return /\bbuildEditorWindowContextMenu\s*\(/.test(items) || refers(items, built);
  });
  assert.ok(drawn.length >= 1, `${win.path}: a <ContextMenu> must draw the items buildEditorWindowContextMenu returned`);
});

// ---------------------------------------------------------------------------
// AC-3 — closing
// ---------------------------------------------------------------------------

test('TC-REQ-FR-MDE-012-AC3-01 패널 머리에 닫기 IconButton 이 있고 titlebarActions 에 패널 토글이 없다', () => {
  const { win, pane } = loadSide();
  const closers = openingTags(pane, 'IconButton').filter(tag => /닫기/.test(attrValue(pane, tag, 'label')?.code ?? ''));
  assert.equal(closers.length, 1, `${pane.path}: the pane head needs one IconButton labelled 닫기, found ${closers.length}`);
  const onClick = handlersOnTag(pane, closers[0], 'onClick');
  assert.ok(onClick !== null && /[\w$]\s*\(/.test(onClick.bare), `${where(pane, closers[0].start)}: the close button must do something on click`);
  const tree = openingTags(pane, 'FileTreeView')[0];
  assert.ok(tree === undefined || closers[0].start < tree.start, `${where(pane, closers[0].start)}: the close button belongs to the head, above the tree`);

  const actions = definitionOf(win, 'titlebarActions');
  assert.ok(actions !== null, `${win.path}: titlebarActions is gone`);
  const body = slice(win, actions);
  assert.doesNotMatch(body.bare, /[A-Za-z_$]*(?:[Pp]ane|[Tt]ree)[\w$]*/, `${where(win, actions.start)}: the titlebar must not toggle the pane (AC-3)`);
  const icons = [...body.code.matchAll(/\bicon\s*=\s*['"]([\w-]+)['"]/g)].map(m => m[1]).sort();
  assert.deepEqual(icons, ['minimize', 'save'], `${where(win, actions.start)}: the titlebar keeps save·maximize·minimize and nothing more`);
  assert.equal(openingTags(win, 'IconToggleButton').filter(t => actions.start <= t.start && t.start < actions.end).length, 1,
    `${where(win, actions.start)}: the only toggle in the titlebar is maximize`);
});

// ---------------------------------------------------------------------------
// AC-5 / AC-6 / AC-7 — what the pane lists
// ---------------------------------------------------------------------------

test('TC-REQ-FR-MDE-012-AC5-02 패널 뿌리가 resolveTabSession(활성 탭) 과 그 세션 cwd 를 resolvePaneRoot 에 넣어 정해진다', () => {
  const { win, pane, files } = loadSide();
  const calls = callsIn(files, 'resolvePaneRoot');
  assert.ok(calls.length >= 1, `${T.window} or ${T.pane} must decide the root with resolvePaneRoot`);
  const fromSession = flow(win, pane, /\bresolveTabSession\b/);
  const fromTab = flow(win, pane, /\b(?:activeTab|tabId)\b/);
  const fromCwd = flow(win, pane, /[Cc]wd\b|[Cc]wd\s*\(/);
  for (const { src, list } of calls) {
    const obj = args(src, list)[0] ?? list;
    const session = propertyValue(src, obj, 'sessionId');
    assert.ok(session !== null, `${where(src, list.start)}: resolvePaneRoot needs sessionId`);
    const s = text(src, session).bare;
    assert.ok(fromSession(src, s), `${where(src, session.start)}: sessionId must come from resolveTabSession`);
    assert.ok(fromTab(src, s), `${where(src, session.start)}: sessionId must be the active tab's session`);
    const cwd = propertyValue(src, obj, 'sessionCwd');
    assert.ok(cwd !== null && fromCwd(src, text(src, cwd).bare), `${where(src, list.start)}: sessionCwd must be that session's working directory`);
    assert.ok(propertyValue(src, obj, 'previous') !== null, `${where(src, list.start)}: resolvePaneRoot needs the previous root, or a moved root is lost`);
  }
  const fromRoot = flow(win, pane, /\bresolvePaneRoot\s*\(/);
  const trees = callArgs(pane, 'useFileTree');
  assert.equal(trees.length, 1, `${pane.path} must build its tree with one useFileTree call`);
  const root = args(pane, trees[0])[1] ?? null;
  assert.ok(root !== null && fromRoot(pane, text(pane, root).bare), `${where(pane, trees[0].start)}: useFileTree's root must be what resolvePaneRoot decided`);
});

test("TC-REQ-FR-MDE-012-AC6-01 패널이 useFileTree(..., 'tree') 로 만들고 setMode·FileListView·모드 토글을 쓰지 않는다", () => {
  const { pane } = loadSide();
  const trees = callArgs(pane, 'useFileTree');
  assert.equal(trees.length, 1, `${pane.path} must build its tree with one useFileTree call, found ${trees.length}`);
  const mode = args(pane, trees[0])[2] ?? null;
  assert.match(text(pane, mode).code.trim(), /^['"]tree['"]$/, `${where(pane, trees[0].start)}: the pane's tree is always in 'tree' mode`);
  assert.doesNotMatch(pane.bare, /\bsetMode\b/, `${pane.path} must not switch modes`);
  assert.doesNotMatch(pane.bare, /\bFileListView\b/, `${pane.path} has no list view`);
  assert.doesNotMatch(pane.bare, /\bFileExplorerPathBar\b/, `${pane.path} must not draw the path bar, whose mode toggle it has no use for`);
  assert.doesNotMatch(pane.code, /['"]list['"]/, `${pane.path} must not name the list mode`);
});

test("TC-REQ-FR-MDE-012-AC7-01 패널이 FileTreeView 를 쓰고 '..' 크롬의 goUp 을 연결한다", () => {
  requireSources([...PANE_SIDE, T.treeView]);
  const pane = read(T.pane);
  const views = openingTags(pane, 'FileTreeView');
  assert.equal(views.length, 1, `${pane.path} must draw one <FileTreeView>, found ${views.length}`);
  const tree = attrValue(pane, views[0], 'tree');
  const fromTree = boundTo(pane, /\buseFileTree\s*\(/);
  assert.ok(tree !== null && refers(tree.bare, fromTree), `${where(pane, views[0].start)}: <FileTreeView tree> must be the pane's useFileTree result, whose goUp the '..' row calls`);
  // The '..' row is FileTreeView's own; the pane must not draw a second one.
  assert.doesNotMatch(pane.code, /data-up\b|fx-up-row/, `${pane.path} must leave the '..' row to FileTreeView`);

  const view = read(T.treeView);
  assert.match(view.bare, /\bcanGoUp\s*\(/, `${view.path}: the '..' row is drawn when canGoUp says so`);
  assert.match(view.code, /\bdata-up\s*=/, `${view.path}: the '..' row carries data-up`);
  const up = handlerBodies(view, 'onDoubleClick').map(h => spansText(view, h.spans));
  assert.ok(up.some(h => /\[data-up\]/.test(h.code) && /\btree\s*\.\s*goUp\s*\(/.test(h.bare)),
    `${view.path}: a double click on '..' must call tree.goUp()`);
});

// ---------------------------------------------------------------------------
// AC-9 / FR-FEX-005 AC-7 — file shortcuts belong to the pane
// ---------------------------------------------------------------------------

/** The pane element whose onKeyDown runs the file shortcut handler. */
function shortcutRoot(pane: Lexed): { node: JsxNode; at: number } {
  const hits = handlerBodies(pane, 'onKeyDown').filter(h => /\bcreateFileExplorerShortcutHandler\s*\(/.test(spansText(pane, h.spans).bare));
  assert.equal(hits.length, 1, `${pane.path}: exactly one onKeyDown must run createFileExplorerShortcutHandler, found ${hits.length}`);
  const node = nodeAt(pane, hits[0].at);
  assert.ok(node !== null, `${where(pane, hits[0].at)}: onKeyDown outside an element`);
  return { node, at: hits[0].at };
}

test('TC-REQ-FR-MDE-012-AC9-02 createFileExplorerShortcutHandler 의 keydown 이 패널 루트에만 붙고 EditorWindow 본문·EditorDocumentPanel 에는 파일 단축키 핸들러가 없다', () => {
  requireSources([...PANE_SIDE, T.documentPanel]);
  const pane = read(T.pane);
  const { node } = shortcutRoot(pane);
  assert.ok(holds(node, 'FileTreeView'), `${where(pane, node.tag.start)}: the element taking file shortcuts must hold the tree`);
  assert.ok(attrValue(pane, node.tag, 'ref') !== null, `${where(pane, node.tag.start)}: the shortcut root needs a ref for the focus test`);
  assert.equal(callArgs(pane, 'createFileExplorerShortcutHandler').length, 1, `${pane.path}: one shortcut handler, on the pane root`);
  assert.doesNotMatch(pane.code, /addEventListener\s*\(\s*['"]keydown['"]/, `${pane.path}: a document-wide keydown would take keys typed in the editor`);
  for (const path of [T.window, T.documentPanel]) {
    const src = read(path);
    assert.doesNotMatch(src.bare, /\b(?:createFileExplorerShortcutHandler|decideFileExplorerShortcut)\b/, `${src.path} must not handle file shortcuts`);
    assert.deepEqual(importedFrom(src, /fileExplorerShortcuts(?:\.ts)?$/), [], `${src.path} must not import the file shortcuts`);
  }
  const win = read(T.window);
  for (const tag of openingTags(win, 'EditorFileTreePane')) {
    assert.equal(attrValue(win, tag, 'onKeyDown'), null, `${where(win, tag.start)}: the window must not route keys into the pane`);
  }
});

test('TC-REQ-FR-FEX-005-AC7-02 패널 핸들러의 focusedInSurface 가 decidePaneShortcutFocus(패널 루트) 로 계산된다 — 창 표면 contains 가 아니다', () => {
  const { pane } = loadSide();
  const { node } = shortcutRoot(pane);
  const list = callArgs(pane, 'createFileExplorerShortcutHandler')[0];
  const focused = propertyValue(pane, list, 'focusedInSurface');
  assert.ok(focused !== null, `${where(pane, list.start)}: the handler's context must report focusedInSurface`);
  const value = text(pane, focused).bare;
  const fromDecide = boundTo(pane, /\bdecidePaneShortcutFocus\s*\(/);
  assert.ok(/\bdecidePaneShortcutFocus\s*\(/.test(value) || refers(value, fromDecide),
    `${where(pane, focused.start)}: focusedInSurface must be decidePaneShortcutFocus(...)`);
  assert.doesNotMatch(value, /\.contains\s*\(/, `${where(pane, focused.start)}: containment in a surface is the window's rule; the pane decides with decidePaneShortcutFocus`);

  const ref = attrValue(pane, node.tag, 'ref');
  const refName = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(ref?.bare ?? '')?.[1];
  assert.ok(refName !== undefined, `${where(pane, node.tag.start)}: the shortcut root's ref must be a ref object`);
  const decides = callArgs(pane, 'decidePaneShortcutFocus');
  assert.ok(decides.length >= 1, `${pane.path} must call decidePaneShortcutFocus`);
  for (const d of decides) {
    const obj = args(pane, d)[0] ?? d;
    assert.ok(refers(text(pane, propertyValue(pane, obj, 'pane')).bare, [refName]),
      `${where(pane, d.start)}: decidePaneShortcutFocus's pane must be the shortcut root (${refName})`);
    assert.match(text(pane, propertyValue(pane, obj, 'active')).bare, /\bactiveElement\b/,
      `${where(pane, d.start)}: decidePaneShortcutFocus's active must be document.activeElement`);
  }
});

// ---------------------------------------------------------------------------
// AC-10 / AC-11 / AC-12 — width
// ---------------------------------------------------------------------------

/** The splitter: the element whose double click resets the width. */
function splitter(files: Lexed[]): { src: Lexed; tag: Span; dbl: { code: string; bare: string } } {
  const hits = files.flatMap(src => handlerBodies(src, 'onDoubleClick')
    .map(h => ({ src, at: h.at, body: spansText(src, h.spans) }))
    .filter(h => /\bresetPaneWidth\s*\(/.test(h.body.bare)));
  assert.equal(hits.length, 1, `one element must reset the pane width on double click (resetPaneWidth), found ${hits.length}`);
  const node = nodeAt(hits[0].src, hits[0].at);
  assert.ok(node !== null, `${where(hits[0].src, hits[0].at)}: onDoubleClick outside an element`);
  return { src: hits[0].src, tag: node.tag, dbl: hits[0].body };
}

test('TC-REQ-FR-MDE-012-AC10-02 6px 스플리터가 pointer 드래그에 applyPaneDrag, onDoubleClick 에 resetPaneWidth 를 쓴다', () => {
  const { files } = loadSide();
  const { src, tag, dbl } = splitter(files);
  assert.match(dbl.bare, /\bclampPaneDragWidth\s*\(\s*resetPaneWidth\s*\(\s*\)/,
    `${where(src, tag.start)}: a double click resets through clampPaneDragWidth(resetPaneWidth(), windowWidth), so a narrow window does not save a width past its cap`);
  const down = handlersOnTag(src, tag, 'onPointerDown');
  assert.ok(down !== null, `${where(src, tag.start)}: the splitter drags on pointerdown`);
  const move = handlersOnTag(src, tag, 'onPointerMove');
  assert.ok(/\bapplyPaneDrag\s*\(/.test(`${down.bare}\n${move?.bare ?? ''}`), `${where(src, tag.start)}: a drag must size the pane with applyPaneDrag`);

  const style = attrValue(src, tag, 'style');
  const byStyle = /\bwidth\s*:\s*(?:6\b|['"]6px['"])/.test(style?.code ?? '');
  const byClass = classTokens(src, tag).some(c => rulesForClass(paneCss(files), c).some(r => /(?:^|[;\s])width\s*:\s*6px/.test(r.body)));
  assert.ok(byStyle || byClass, `${where(src, tag.start)}: the splitter is a 6px band (design 9.1)`);
});

test('TC-REQ-FR-MDE-012-AC11-03 saveEditorTreePaneState 호출이 드래그 종료·더블클릭 핸들러에만 있고 창 크기 변화(ResizeObserver/rect 변화) 경로에는 없으며 렌더 폭은 renderPaneWidth(저장값, 창폭) 이다', () => {
  const { files } = loadSide();
  const saves = callsIn(files, 'saveEditorTreePaneState');
  assert.ok(saves.length >= 1, 'the pane width must be saved with saveEditorTreePaneState');

  // A save reached from an effect or a ResizeObserver would let a window
  // resize rewrite the chosen width. An effect that only exists to listen to
  // the drag's own pointer events is the drag, not the window.
  for (const src of files) {
    for (const span of effectSpans(src)) {
      const body = spansText(src, expand(src, span));
      if (POINTER_LISTENER.test(body.code)) continue;
      assert.doesNotMatch(body.bare, /\bsaveEditorTreePaneState\s*\(/, `${where(src, span.start)}: an effect or ResizeObserver must not save the pane state`);
    }
  }

  const { src, tag, dbl } = splitter(files);
  assert.match(dbl.bare, /\bsaveEditorTreePaneState\s*\(/, `${where(src, tag.start)}: the double-click reset must be saved`);
  const endPaths = [
    handlersOnTag(src, tag, 'onPointerUp'),
    handlersOnTag(src, tag, 'onLostPointerCapture'),
    handlersOnTag(src, tag, 'onPointerCancel'),
    handlersOnTag(src, tag, 'onPointerDown'),
    ...effectSpans(src).map(span => spansText(src, expand(src, span))).filter(b => POINTER_LISTENER.test(b.code)),
  ].filter((b): b is { code: string; bare: string } => b !== null);
  assert.ok(endPaths.some(b => /\bsaveEditorTreePaneState\s*\(/.test(b.bare)), `${where(src, tag.start)}: the end of a drag must save the width`);
  const move = handlersOnTag(src, tag, 'onPointerMove');
  assert.ok(move === null || !/\bsaveEditorTreePaneState\s*\(/.test(move.bare), `${where(src, tag.start)}: saving on every pointermove writes storage many times a second; save when the drag ends`);

  // What is saved is never the clipped render width. Only a direct use is
  // judged: a drag may rightly start from the width on screen, and what it
  // saves is then applyPaneDrag's answer, not the render clip. The resize path
  // that could write a clipped width back is closed by the effect check above.
  for (const { src: s, list } of saves) {
    assert.doesNotMatch(text(s, list).bare, /\brenderPaneWidth\s*\(/, `${where(s, list.start)}: the saved width must not be the render width`);
  }
  // What is drawn is the render width.
  const renders = callsIn(files, 'renderPaneWidth');
  assert.ok(renders.length >= 1, 'the pane must be drawn at renderPaneWidth(saved, windowWidth)');
  for (const { src: s, list } of renders) {
    assert.equal(args(s, list).length, 2, `${where(s, list.start)}: renderPaneWidth takes the saved width and the window width`);
  }
  const drawn = files.some((s) => {
    const rendered = boundTo(s, /\brenderPaneWidth\s*\(/);
    return handlerBodies(s, 'style').some((h) => {
      const style = spansText(s, h.spans).bare;
      return /\brenderPaneWidth\s*\(/.test(style) || refers(style, rendered);
    });
  });
  assert.ok(drawn, "a style={…} must draw the pane at renderPaneWidth's result");
});

test('TC-REQ-FR-MDE-012-AC12-02 폭·접힘이 saveEditorTreePaneState(workspaceId, ...) 로 저장되고 readEditorTreePaneState 로 복원된다', () => {
  const { win, pane, files } = loadSide();
  const fromWorkspace = flow(win, pane, /\bworkspaceId\b/);
  const saves = callsIn(files, 'saveEditorTreePaneState');
  assert.ok(saves.length >= 1, 'the pane state must be saved with saveEditorTreePaneState');
  for (const { src, list } of saves) {
    const [ws, state] = args(src, list);
    assert.ok(ws !== undefined && fromWorkspace(src, text(src, ws).bare), `${where(src, list.start)}: the pane state is saved per workspace`);
    assert.ok(state !== undefined, `${where(src, list.start)}: saveEditorTreePaneState needs the state`);
    assert.doesNotMatch(text(src, state).bare, /\bexpandedPaths\b/, `${where(src, list.start)}: expanded directories are not saved (AC-12)`);
  }
  const reads = callsIn(files, 'readEditorTreePaneState');
  assert.ok(reads.length >= 1, 'the pane state must be restored with readEditorTreePaneState');
  for (const { src, list } of reads) {
    const ws = args(src, list)[0];
    assert.ok(ws !== undefined && fromWorkspace(src, text(src, ws).bare), `${where(src, list.start)}: the pane state is read per workspace`);
  }
  const fromRead = flow(win, pane, /\breadEditorTreePaneState\s*\(/);
  const widths = callsIn(files, 'renderPaneWidth');
  assert.ok(widths.some(({ src, list }) => { const saved = args(src, list)[0]; return saved !== undefined && fromRead(src, text(src, saved).bare); }),
    'the drawn width must start from the width readEditorTreePaneState restored');
  const folds = callsIn(files, 'paneInitiallyCollapsed');
  assert.ok(folds.some(({ src, list }) => fromRead(src, text(src, propertyValue(src, args(src, list)[0] ?? list, 'savedCollapsed')).bare)),
    'paneInitiallyCollapsed must be given the folded state readEditorTreePaneState restored');
});

// ---------------------------------------------------------------------------
// AC-13 — mobile, and where an opened file goes
// ---------------------------------------------------------------------------

test('TC-REQ-FR-MDE-012-AC13-02 isMobile 이면 패널이 오버레이 클래스로 문서 위에 겹치고 파일을 연 뒤 collapseAfterOpen 으로 접힌다', () => {
  requireSources([...PANE_SIDE, T.app]);
  const win = read(T.window);
  const pane = read(T.pane);
  const files = [win, pane];
  const fromMobile = flow(win, pane, MOBILE);

  const folds = callsIn(files, 'paneInitiallyCollapsed');
  assert.ok(folds.length >= 1, 'the pane must start folded through paneInitiallyCollapsed');
  for (const { src, list } of folds) {
    const mobile = propertyValue(src, args(src, list)[0] ?? list, 'isMobile');
    assert.ok(mobile !== null && fromMobile(src, text(src, mobile).bare), `${where(src, list.start)}: paneInitiallyCollapsed's isMobile must be the layout's`);
  }

  const rules = paneCss(files);
  const overlays = files.flatMap(src => allNodes(jsxForest(src))
    .filter(n => holds(n, 'FileTreeView') || n.name === 'EditorFileTreePane' || holds(n, 'EditorFileTreePane'))
    .filter(n => fromMobile(src, attrValue(src, n.tag, 'className')?.bare ?? ''))
    .flatMap(n => classTokens(src, n.tag).filter(c => /overlay/i.test(c)))
    .filter(c => rulesForClass(rules, c).some(r => /position\s*:\s*(?:absolute|fixed)/.test(r.body))));
  assert.ok(overlays.length >= 1, 'on mobile the pane must take an overlay class that positions it over the document');

  // Opening a file from the pane: the tree's onOpenFile, then the window's.
  const treeTags = openingTags(pane, 'FileTreeView');
  assert.equal(treeTags.length, 1, `${pane.path} must draw one <FileTreeView>`);
  const fromTree = handlersOnTag(pane, treeTags[0], 'onOpenFile');
  assert.ok(fromTree !== null, `${where(pane, treeTags[0].start)}: <FileTreeView> needs onOpenFile`);
  const paneTags = openingTags(win, 'EditorFileTreePane');
  const fromWindow = paneTags.length === 1 ? handlersOnTag(win, paneTags[0], 'onOpenFile') : null;
  const openPath = `${fromTree.bare}\n${fromWindow?.bare ?? ''}`;
  assert.match(openPath, /\bcollapseAfterOpen\s*\(/, 'opening a file from the pane must fold it through collapseAfterOpen');

  // The file opens in this window's editor, bound to the active tab, as the
  // explorer's files do: App hands the window editor.openDocument.
  const fromTab = flow(win, pane, /\b(?:activeTab|tabId)\b/);
  const opens = [{ src: pane, body: fromTree }, ...(fromWindow === null ? [] : [{ src: win, body: fromWindow }])]
    .flatMap(({ src, body }) => [...body.bare.matchAll(/(?<![\w$.])(?:props\s*\.\s*)?onOpenFile\s*\(/g)].map((m) => {
      const open = body.bare.indexOf('(', m.index + m[0].length - 1);
      const inner = body.bare.slice(open + 1, matchBracket(body.bare, open));
      const parts = inner.split(',');
      return parts.length >= 2 && fromTab(src, parts.slice(1).join(','));
    }));
  assert.ok(opens.some(Boolean), "the opened file must reach onOpenFile(path, <the active tab's id>)");
  const props = /\binterface\s+EditorWindowProps\s*\{/.exec(win.bare);
  assert.ok(props !== null, `${win.path}: interface EditorWindowProps is gone`);
  const propsOpen = props.index + props[0].length - 1;
  assert.match(win.bare.slice(propsOpen, matchBracket(win.bare, propsOpen)), /\bonOpenFile\s*\??\s*:/, `${win.path}: EditorWindowProps needs onOpenFile`);
  const app = read(T.app);
  const windows = openingTags(app, 'EditorWindow');
  assert.equal(windows.length, 1, `${app.path} must render one <EditorWindow>`);
  assert.equal(attrValue(app, windows[0], 'onOpenFile')?.bare.trim(), 'editor.openDocument',
    `${where(app, windows[0].start)}: <EditorWindow onOpenFile> must be editor.openDocument, the same route the explorer uses`);
});
