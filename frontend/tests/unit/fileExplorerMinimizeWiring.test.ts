import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// FR-FEX-004 AC-1..6 — how the explorer window's minimize, header tray row,
// revival and 최대화 are wired into App.tsx, the window hook and the window.
//
// The decisions themselves live in fileExplorerTrayModel.ts and are tested
// there (fileExplorerTray.test.ts). What those tests cannot see is whether
// anything calls them: a model nobody imports passes every one of its own
// cases while the tray still shows editor rows only. This file closes that gap
// from source, since the repository has no DOM harness.
//
// The scanner is a copy of the one in fileExplorerWiring.test.ts, for the same
// two reasons given there: comments and literals must neither trip nor satisfy
// a structural check, and every target's existence is asserted first so that
// "no file does X" cannot pass vacuously. Importing it from that file would
// register its tests a second time.
//
// The decision function names are matched literally. A renamed model would
// fail here on purpose: the point is that the explorer reuses the one shared
// decision set, and a local helper with a similar shape is exactly the copy
// this guard exists to keep out.

const SRC_DIR = new URL('../../src/', import.meta.url);
const FX = 'components/fileExplorer/';

const T = {
  app: 'App.tsx',
  windowsHook: 'hooks/useFileExplorerWindows.ts',
  window: `${FX}FileExplorerWindow.tsx`,
  trayModel: `${FX}fileExplorerTrayModel.ts`,
} as const;

const ALL = [T.app, T.windowsHook, T.window, T.trayModel] as const;

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
// Helpers local to this guard
// ---------------------------------------------------------------------------

/** The span inside `attr={...}` of a tag, or null when the attribute is absent or not an expression. */
function attrSpan(src: Lexed, tag: Span, attr: string): Span | null {
  const m = new RegExp(`\\s${attr}\\s*=\\s*\\{`).exec(src.bare.slice(tag.start, tag.end));
  if (!m) return null;
  const open = tag.start + m.index + m[0].length - 1;
  const close = matchBracket(src.bare, open);
  return close === -1 ? null : { start: open + 1, end: close };
}

/**
 * A span plus what it names: called local functions (via expand) and, one
 * level further, plain identifiers that hold a local definition — so
 * `[...editor.trayItems, ...explorerTrayRows]` is judged by what
 * explorerTrayRows is. Member names (`x.label`) are never looked up.
 */
function resolve(src: Lexed, span: Span): { code: string; bare: string } {
  const spans = expand(src, span);
  const seen = new Set<string>();
  for (const s of [...spans]) {
    const text = src.bare.slice(s.start, s.end);
    for (const m of text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const def = definitionOf(src, m[1], s.start);
      if (def && !spans.some(k => k.start <= def.start && def.end <= k.end)) spans.push(...expand(src, def));
    }
  }
  return spansText(src, spans);
}

/** The definition of a local (`const x = useCallback(...)`), expanded, or a failure naming it. */
function definitionText(src: Lexed, name: string): { code: string; bare: string } {
  const def = definitionOf(src, name);
  assert.ok(def, `${src.path}: no local definition of ${name}`);
  return resolve(src, def);
}

function assertImports(src: Lexed, name: string, modulePath: string): void {
  const escaped = modulePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  // assert.ok rather than assert.match: a failed match would print the whole file.
  const pattern = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][./]*${escaped}(?:\\.tsx?)?['"]`);
  assert.ok(pattern.test(src.code), `${src.path} must import ${name} from ${modulePath}`);
}

/** The single opening tag of `<name ...>` that carries `attr`. */
function tagWith(src: Lexed, name: string, attr: string): Span {
  const tags = openingTags(src, name).filter(tag => new RegExp(`\\s${attr}\\s*=`).test(src.bare.slice(tag.start, tag.end)));
  assert.equal(tags.length, 1, `${src.path}: expected exactly one <${name}> carrying ${attr}=, found ${tags.length}`);
  return tags[0];
}

// assert.match would print the whole source on failure; these print the message.
function has(text: string, pattern: RegExp, message: string): void {
  assert.ok(pattern.test(text), message);
}
function lacks(text: string, pattern: RegExp, message: string): void {
  const hit = pattern.exec(text);
  assert.equal(hit, null, hit ? `${message} (found: ${hit[0].trim()})` : '');
}

// A tab list rebuilt on minimize or revival is a fresh first tab over the ones
// the user had: expanded directories, selection, mode and root would be gone.
const TAB_BUILDERS = /\b(openInNewTab|createInitialFileTreeState|readPersistedFileExplorerState|restoreFileExplorerTabs|randomUUID|getRandomValues)\s*\(/;

// ---------------------------------------------------------------------------
// FR-FEX-004
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-004-AC1-02 App.tsx 의 explorer.windows.map 이 minimized 로 거르지 않고 FileExplorerWindow 는 hidden prop 으로만 감춘다(조건부 언마운트 없음)', () => {
  requireSources(ALL);
  const app = read(T.app);
  const hook = read(T.windowsHook);
  const win = read(T.window);

  const narrowed = /\bexplorer\.windows\s*\.\s*(filter|slice|splice|flatMap|find)\b/.exec(app.bare);
  assert.equal(narrowed, null, narrowed ? `${where(app, narrowed.index)}: explorer.windows.${narrowed[1]} — every window stays mounted, a minimized one included` : '');
  const maps = [...app.bare.matchAll(/\bexplorer\.windows\s*\.\s*map\s*\(/g)];
  assert.equal(maps.length, 1, `${app.path}: expected exactly one explorer.windows.map(...), found ${maps.length}`);
  const open = maps[0].index + maps[0][0].length - 1;
  const body: Span = { start: open + 1, end: matchBracket(app.bare, open) };
  const bodyText = app.bare.slice(body.start, body.end);
  lacks(bodyText, /\bminimized\b/, `${where(app, body.start)}: the map must not read minimized — hiding is the window's hidden prop`);
  const conditional = /\bhidden\b\s*(?:&&|\?)|!\s*[\w.]*\bhidden\b\s*&&/.exec(bodyText);
  assert.equal(conditional, null, conditional ? `${where(app, body.start + conditional.index)}: the window is rendered conditionally on hidden — it must only be hidden` : '');
  const tags = openingTags(app, 'FileExplorerWindow').filter(t => t.start >= body.start && t.end <= body.end);
  assert.equal(tags.length, 1, `${where(app, body.start)}: expected one <FileExplorerWindow> inside explorer.windows.map, found ${tags.length}`);
  const tag = tags[0];
  const hidden = attrSpan(app, tag, 'hidden');
  assert.ok(hidden && /\.hidden\b/.test(app.bare.slice(hidden.start, hidden.end)), `${where(app, tag.start)}: hidden= must pass the view's hidden`);

  has(win.bare, /\bfunction\s+FileExplorerWindow\s*\(\s*\{[^}]*\bhidden\b/, `${win.path}: FileExplorerWindow must still take hidden`);

  // AC-1: minimize sets the hiding flag and nothing else, by the editor's own
  // transition rather than a spread written here.
  assertImports(hook, 'minimizeFileExplorerRecord', 'components/fileExplorer/fileExplorerTrayModel');
  const minimize = definitionText(hook, 'minimizeFileExplorer');
  has(minimize.bare, /\bminimizeFileExplorerRecord\s*\(/, `${hook.path}: minimizeFileExplorer must go through minimizeFileExplorerRecord`);
  lacks(minimize.bare, /\bminimized\s*:/, `${hook.path}: minimizeFileExplorer writes minimized itself — it must leave that to minimizeFileExplorerRecord`);
});

test('TC-REQ-FR-FEX-004-AC2-02 useFileExplorerWindows 의 minimizeFileExplorer 가 minimizeFileExplorerRecord 를 거치고 tabs 를 새로 만들지 않는다', () => {
  requireSources(ALL);
  const hook = read(T.windowsHook);
  assertImports(hook, 'restoreFileExplorerRecord', 'components/fileExplorer/fileExplorerTrayModel');
  const minimize = definitionText(hook, 'minimizeFileExplorer');
  const revive = definitionText(hook, 'reviveFileExplorer');
  has(minimize.bare, /\bminimizeFileExplorerRecord\s*\(/, `${hook.path}: minimizeFileExplorer must go through minimizeFileExplorerRecord`);
  has(revive.bare, /\brestoreFileExplorerRecord\s*\(/, `${hook.path}: reviveFileExplorer must un-hide through restoreFileExplorerRecord`);
  for (const [name, text] of [['minimizeFileExplorer', minimize], ['reviveFileExplorer', revive]] as const) {
    const builds = TAB_BUILDERS.exec(text.bare);
    assert.equal(builds, null, builds ? `${hook.path}: ${name} calls ${builds[1]} — the window's tabs must come back as they were` : '');
    lacks(text.bare, /\btabs\s*:/, `${hook.path}: ${name} writes tabs — minimize and revival touch only the hiding state`);
  }
});

test('TC-REQ-FR-FEX-004-AC3-03 App.tsx 가 listFileExplorerTrayEntries 결과의 label 을 가공 없이 Header editorTrayItems 의 label 로 합치고 hasEditorWindows 를 hasHeaderTrayWindows 로 계산한다', () => {
  requireSources(ALL);
  const app = read(T.app);
  assertImports(app, 'listFileExplorerTrayEntries', 'components/fileExplorer/fileExplorerTrayModel');
  assertImports(app, 'hasHeaderTrayWindows', 'components/fileExplorer/fileExplorerTrayModel');

  const trayTag = tagWith(app, 'Header', 'editorTrayItems');
  const traySpan = attrSpan(app, trayTag, 'editorTrayItems');
  assert.ok(traySpan, `${where(app, trayTag.start)}: editorTrayItems= must be an expression`);
  const tray = resolve(app, traySpan);
  has(tray.bare, /\beditor\.trayItems\b/, `${where(app, trayTag.start)}: editorTrayItems must keep the editor's rows`);
  has(tray.bare, /\blistFileExplorerTrayEntries\s*\(/, `${where(app, trayTag.start)}: editorTrayItems must add the rows listFileExplorerTrayEntries gives`);
  // The label is the model's, character for character (AC-4). Any template,
  // concatenation or call here would be a second place deciding the name.
  const labels = [...tray.bare.matchAll(/\blabel\s*:\s*([^,}\n]*)/g)].map(m => m[1].trim());
  assert.ok(labels.length > 0, `${where(app, trayTag.start)}: the explorer rows must set label: from the tray entry`);
  for (const label of labels) {
    has(label, /^[A-Za-z_$][\w$]*\.label$/, `${where(app, trayTag.start)}: label: ${label} — the row label must be the entry's label unchanged`);
  }

  const countTag = tagWith(app, 'Header', 'hasEditorWindows');
  const countSpan = attrSpan(app, countTag, 'hasEditorWindows');
  assert.ok(countSpan, `${where(app, countTag.start)}: hasEditorWindows= must be an expression`);
  const count = resolve(app, countSpan);
  const call = /\bhasHeaderTrayWindows\s*\(([^)]*)\)/.exec(count.bare);
  assert.ok(call, `${where(app, countTag.start)}: hasEditorWindows must be computed by hasHeaderTrayWindows — editor windows alone would strand a minimized explorer`);
  has(call[1], /\bexplorer\.windows\b/, `${where(app, countTag.start)}: hasHeaderTrayWindows must count the explorer windows`);
});

test('TC-REQ-FR-FEX-004-AC5-02 useFileExplorerWindows.reviveFileExplorer 가 decideReviveFileExplorer 결과로 setActiveWorkspaceId·setScreen·raiseDialogById 를 부른다', () => {
  requireSources(ALL);
  const hook = read(T.windowsHook);
  const app = read(T.app);
  assertImports(hook, 'decideReviveFileExplorer', 'components/fileExplorer/fileExplorerTrayModel');

  const input = /\binterface\s+UseFileExplorerWindowsInput\b[^{]*\{/.exec(hook.bare);
  assert.ok(input, `${hook.path}: no UseFileExplorerWindowsInput`);
  const inputBody = hook.bare.slice(input.index, matchBracket(hook.bare, input.index + input[0].length - 1));
  for (const field of ['setActiveWorkspaceId', 'setScreen']) {
    has(inputBody, new RegExp(`\\b${field}\\s*\\??\\s*:`), `${hook.path}: UseFileExplorerWindowsInput must take ${field}`);
  }

  const revive = definitionText(hook, 'reviveFileExplorer');
  has(revive.bare, /\bdecideReviveFileExplorer\s*\(/, `${hook.path}: reviveFileExplorer must decide through decideReviveFileExplorer`);
  has(revive.bare, /\bsetActiveWorkspaceId\s*\(/, `${hook.path}: reviveFileExplorer must switch workspace when the decision says so`);
  has(revive.bare, /\bswitchWorkspaceId\b/, `${hook.path}: the workspace switch must follow the decision's switchWorkspaceId`);
  has(revive.bare, /\bsetScreen\s*\(/, `${hook.path}: reviveFileExplorer must leave the settings screen when the decision says so`);
  has(revive.bare, /\bshowWorkspaceScreen\b/, `${hook.path}: the screen change must follow the decision's showWorkspaceScreen`);
  has(revive.code, /\braiseDialogById\s*\(\s*[\w.]*raiseDialogId\s*,\s*['"]modeless['"]\s*\)/,
    `${hook.path}: reviveFileExplorer must call raiseDialogById(decision.raiseDialogId, 'modeless')`);

  const callSpans = callArgs(app, 'useFileExplorerWindows');
  assert.equal(callSpans.length, 1, `${app.path}: expected one useFileExplorerWindows(...) call, found ${callSpans.length}`);
  const args = app.bare.slice(callSpans[0].start, callSpans[0].end);
  has(args, /\bsetActiveWorkspaceId\s*(?::\s*wm\.setActiveWorkspaceId\b|[,}])/, `${app.path}: useFileExplorerWindows must receive wm.setActiveWorkspaceId`);
  has(args, /\bsetScreen\s*(?::\s*setScreen\b|[,}\s])/, `${app.path}: useFileExplorerWindows must receive setScreen`);

  const tray = resolve(app, attrSpan(app, tagWith(app, 'Header', 'editorTrayItems'), 'editorTrayItems') as Span);
  has(tray.bare, /\breviveFileExplorer\s*\(/, `${app.path}: an explorer tray row must revive through reviveFileExplorer`);
});

test('TC-REQ-FR-FEX-004-AC6-02 FileExplorerWindow 제목 표시줄에 최대화 IconToggleButton 이 있고 placement=stage 일 때 WindowDialog 에 측정한 stage rect 를 controlled rect 로 넘긴다', () => {
  requireSources(ALL);
  const win = read(T.window);
  const hook = read(T.windowsHook);

  const toggles = openingTags(win, 'IconToggleButton').filter(tag => /\slabel\s*=\s*["']최대화["']/.test(win.code.slice(tag.start, tag.end)));
  assert.equal(toggles.length, 1, `${win.path}: expected one <IconToggleButton label="최대화">, found ${toggles.length}`);
  assert.ok(attrSpan(win, toggles[0], 'pressed'), `${where(win, toggles[0].start)}: the 최대화 toggle must say which end it is at (pressed=)`);
  const onToggle = attrSpan(win, toggles[0], 'onToggle');
  assert.ok(onToggle, `${where(win, toggles[0].start)}: the 최대화 toggle needs onToggle=`);
  has(resolve(win, onToggle).bare, /\btoggleMaximizeFileExplorer\s*\(/, `${where(win, toggles[0].start)}: onToggle must call toggleMaximizeFileExplorer`);

  assertImports(win, 'toStageRect', 'editor/editorWindowRect');
  assertImports(win, 'EDITOR_WINDOW_BOUNDS_SELECTOR', 'editor/editorWindowBounds');
  has(win.bare, /\btoStageRect\s*\(/, `${win.path}: the stage rect must be converted with toStageRect`);
  has(win.bare, /\bEDITOR_WINDOW_BOUNDS_SELECTOR\b/, `${win.path}: the stage must be measured at EDITOR_WINDOW_BOUNDS_SELECTOR`);
  has(win.code, /\bplacement\s*[!=]==\s*['"]stage['"]/, `${win.path}: the controlled rect must depend on placement === 'stage'`);
  const dialog = openingTags(win, 'WindowDialog');
  assert.equal(dialog.length, 1, `${win.path}: expected one <WindowDialog>, found ${dialog.length}`);
  assert.ok(attrSpan(win, dialog[0], 'rect'), `${where(win, dialog[0].start)}: <WindowDialog> must take the stage rect as rect=`);

  assertImports(hook, 'toggleFileExplorerMaximize', 'components/fileExplorer/fileExplorerTrayModel');
  const actions = /\binterface\s+FileExplorerWindowActions\b[^{]*\{/.exec(hook.bare);
  assert.ok(actions, `${hook.path}: no FileExplorerWindowActions`);
  has(hook.bare.slice(actions.index, matchBracket(hook.bare, actions.index + actions[0].length - 1)), /\btoggleMaximizeFileExplorer\s*:/,
    `${hook.path}: FileExplorerWindowActions must carry toggleMaximizeFileExplorer`);
  has(definitionText(hook, 'toggleMaximizeFileExplorer').bare, /\btoggleFileExplorerMaximize\s*\(/,
    `${hook.path}: toggleMaximizeFileExplorer must go through toggleFileExplorerMaximize`);
});
