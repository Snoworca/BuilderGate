import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

// FR-FEX-008 AC-1..9 · FR-FEX-009 AC-1..4 — how file-job progress reaches its
// three places (the row inside an explorer window, the app's bottom status bar,
// the popover it opens) and how a job waiting for an answer brings its window
// back.
//
// What each place shows is decided by the pure selectors in fileJobStore.ts,
// tested by fileJobStore.test.ts. What only source can show is that the
// components read the store the way it has to be read and route events through
// those selectors, so these are source guards held to the rules
// fileExplorerWiring.test.ts sets:
//
// - Prose and literals neither trip nor satisfy a check. The scanner is copied
//   from fileExplorerInteractionWiring.test.ts (importing a *.test.ts registers
//   its tests a second time): comments are removed while strings, templates,
//   regex literals and JSX text are respected, and a view with every literal
//   blanked is kept beside it.
// - No empty sets. Every target is named and its existence asserted in each
//   case before its contents are judged. FileJobStatusBar.tsx, FileJobPopover.tsx,
//   FileExplorerProgressRow.tsx and hooks/useFileJobStoreSync.ts are created by
//   the wiring steps, so their absence is a failure, never a pass.
//
// The store's consumer rules are pinned because breaking them fails silently:
// - useSyncExternalStore gets getFileJobSnapshot itself. The selectors build a
//   new object on every call, so a selector passed as getSnapshot never compares
//   equal and React re-renders forever. Each select* runs inside useMemo on the
//   snapshot instead.
// - The window reports what it has done: FAILURE_SHOWN once it showed a
//   failure, DECISION_ANSWERED once it answered. Otherwise the store keeps both.
// - The app re-adopts the server's jobs with fileJobApi.list whenever the socket
//   becomes connected, which includes mount.
// - Once the window reads jobs from the store, nothing cancels a job when a
//   window unmounts: the store keeps the question until the window comes back
//   (FR-FEX-009 AC-3). That reverses fileJobOwnership's dispose rule, so the
//   window no longer creates an ownership object.
//
// Names from the store, the API client and the socket context (the selectors,
// dispatchFileJob, getFileJobSnapshot, subscribeFileJobs,
// decidePopoverOutsideClose, fileJobApi, registerFileJobHandler) and the names
// the plan gives the new modules are pinned. A prop name, a memo variable or a
// state setter is the wiring step's to choose, so it is followed by shape.
//
// Where the popover's open state lives is not decided yet (T-PH003-02 left it
// open). What is pinned is that the in-window '외 N개' button and the popover
// share it: the button calls something imported from a module the popover or
// the status bar also reads a popover name from. A useState in the row could
// never open the popover the app draws.

const SRC_DIR = new URL('../../src/', import.meta.url);
const FX = 'components/fileExplorer/';

const T = {
  app: 'App.tsx',
  window: `${FX}FileExplorerWindow.tsx`,
  windowModal: `${FX}FileExplorerWindowModal.tsx`,
  statusBar: `${FX}FileJobStatusBar.tsx`,
  popover: `${FX}FileJobPopover.tsx`,
  progressRow: `${FX}FileExplorerProgressRow.tsx`,
  sync: 'hooks/useFileJobStoreSync.ts',
  // The explorer tab panel's file operations, shared with the editor's tree
  // pane (FR-MDE-012 AC-8): the job client that dispatches JOB_STARTED lives here.
  opsHook: 'hooks/useFileTreeOperations.ts',
} as const;

// Modules by their path under src/, extension dropped.
const M = {
  store: `${FX}fileJobStore`,
  events: `${FX}fileJobEvents`,
  ownership: `${FX}fileJobOwnership`,
  statusBar: `${FX}FileJobStatusBar`,
  popover: `${FX}FileJobPopover`,
  progressRow: `${FX}FileExplorerProgressRow`,
  windowModal: `${FX}FileExplorerWindowModal`,
  sync: 'hooks/useFileJobStoreSync',
  opsHook: 'hooks/useFileTreeOperations',
  api: 'services/api',
  ws: 'contexts/WebSocketContext',
} as const;

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
// Interaction helpers
// ---------------------------------------------------------------------------

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

function locatedText(located: readonly Located[], view: 'code' | 'bare'): string {
  return located.map(l => l.src[view].slice(l.span.start, l.span.end)).join('\n');
}


// ---------------------------------------------------------------------------
// Imports, store reads and render shapes
// ---------------------------------------------------------------------------

function relOf(src: Lexed): string {
  return src.path.slice('src/'.length);
}

function resolveModule(fromRel: string, spec: string): string {
  if (!spec.startsWith('.')) return spec;
  const url = new URL(spec, new URL(fromRel, SRC_DIR));
  return url.href.slice(SRC_DIR.href.length).replace(/\.(?:tsx?|jsx?)$/, '').replace(/\/index$/, '');
}

/** Every import of the file: resolved module and the local names it binds. */
function importsOf(src: Lexed): { module: string; names: string[] }[] {
  const out: { module: string; names: string[] }[] = [];
  const re = /\bimport\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:from\s*)?(['"])([^'"]+)\3/g;
  for (const m of src.code.matchAll(re)) {
    const names: string[] = [];
    if (m[1] && m[1] !== 'type') names.push(m[1]);
    for (const part of (m[2] ?? '').split(',')) {
      const name = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
    out.push({ module: resolveModule(relOf(src), m[4]), names });
  }
  return out;
}

function namesFrom(src: Lexed, module: string): string[] {
  return importsOf(src).filter(i => i.module === module).flatMap(i => i.names);
}

function requireImport(src: Lexed, module: string, name: string): void {
  assert.ok(namesFrom(src, module).includes(name), `${src.path} must import ${name} from src/${module}`);
}

/** Like refersTo, but through up to `depth` levels of local definitions. */
function refersDeep(src: Lexed, text: string, id: string, depth = 3): boolean {
  if (new RegExp(`\\b${id}\\b`).test(text)) return true;
  if (depth === 0) return false;
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const def = definitionOf(src, m[1]);
    if (def && refersDeep(src, src.bare.slice(def.start, def.end), id, depth - 1)) return true;
  }
  return false;
}

/** The name bound by `const NAME = <call>(` where the call's `(` is at `open`. */
function bindingOf(src: Lexed, open: number): string | null {
  const before = src.bare.slice(Math.max(0, open - 300), open);
  const m = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*[A-Za-z_$][\w$.]*\s*(?:<[^;]*>)?\s*$/.exec(before);
  return m ? m[1] : null;
}

/**
 * The names bound to useSyncExternalStore(subscribeFileJobs, getFileJobSnapshot).
 * Any read of subscribeFileJobs that passes something other than
 * getFileJobSnapshot as the snapshot fails here: every selector returns a new
 * object per call, so as getSnapshot it would re-render without end.
 */
function storeSnapshots(src: Lexed): string[] {
  const out: string[] = [];
  for (const args of callArgs(src, 'useSyncExternalStore')) {
    const first = firstArg(src, args);
    if (src.bare.slice(first.start, first.end).trim() !== 'subscribeFileJobs') continue;
    const second = secondArg(src, args);
    assert.ok(second !== null, `${where(src, args.start)}: useSyncExternalStore(subscribeFileJobs) has no getSnapshot`);
    assert.equal(src.bare.slice(second.start, second.end).trim(), 'getFileJobSnapshot',
      `${where(src, args.start)}: useSyncExternalStore(subscribeFileJobs, …) must pass getFileJobSnapshot itself — a selector returns a new object every call; select from the snapshot with useMemo`);
    const name = bindingOf(src, args.start - 1);
    assert.ok(name !== null, `${where(src, args.start)}: the file-job snapshot is not bound to a name`);
    out.push(name);
  }
  if (out.length > 0) {
    requireImport(src, M.store, 'subscribeFileJobs');
    requireImport(src, M.store, 'getFileJobSnapshot');
  }
  return out;
}

interface SelectorRead { args: Span; memo: string | null }

/** Calls of `selector` that sit inside a useMemo callback, with the memo's bound name. */
function memoCalls(src: Lexed, selector: string): SelectorRead[] {
  const memos = callArgs(src, 'useMemo');
  return callArgs(src, selector).map((args) => {
    const memo = memos.filter(m => m.start <= args.start && args.end <= m.end).sort((a, b) => b.start - a.start)[0];
    assert.ok(memo !== undefined, `${where(src, args.start)}: ${selector}(…) must run inside useMemo — it returns a new object every call`);
    return { args, memo: bindingOf(src, memo.start - 1) };
  });
}

/**
 * The store reads of `selector` in `src`: each inside useMemo, each on the
 * file-job snapshot. Fails when there is none.
 */
function storeReads(src: Lexed, selector: string): SelectorRead[] {
  requireImport(src, M.store, selector);
  const snapshots = storeSnapshots(src);
  assert.ok(snapshots.length > 0, `${src.path}: no useSyncExternalStore(subscribeFileJobs, getFileJobSnapshot) — ${selector} has no snapshot to read`);
  const reads = memoCalls(src, selector);
  assert.ok(reads.length > 0, `${src.path} never calls ${selector}`);
  for (const read_ of reads) {
    const first = firstArg(src, read_.args);
    const text = src.bare.slice(first.start, first.end);
    assert.ok(snapshots.some(s => refersDeep(src, text, s)),
      `${where(src, read_.args.start)}: ${selector}(…) must read the file-job snapshot (${snapshots.join(', ')})`);
    assert.ok(read_.memo !== null, `${where(src, read_.args.start)}: the memo holding ${selector}(…) is not bound to a name`);
  }
  return reads;
}

/** The body of component `name`: `function name(` or `const name = [memo(](…) => {`. */
function componentBody(src: Lexed, name: string): Span {
  const fn = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src.bare);
  if (fn) {
    const brace = src.bare.indexOf('{', matchBracket(src.bare, fn.index + fn[0].length - 1));
    return { start: brace, end: matchBracket(src.bare, brace) + 1 };
  }
  const def = definitionOf(src, name);
  assert.ok(def !== null, `${src.path} does not define ${name}`);
  const arrow = src.bare.indexOf('=>', def.start);
  const brace = arrow === -1 ? -1 : src.bare.indexOf('{', arrow);
  assert.ok(brace !== -1 && brace < def.end, `${src.path}: ${name} has no block body`);
  return { start: brace, end: matchBracket(src.bare, brace) + 1 };
}

/** Conditions of `if (cond) return null;` whose innermost function is `body`. */
function nullGuards(src: Lexed, body: Span): { at: number; code: string; bare: string }[] {
  const out: { at: number; code: string; bare: string }[] = [];
  for (const m of src.bare.slice(body.start, body.end).matchAll(/\bif\s*\(/g)) {
    const open = body.start + m.index + m[0].length - 1;
    const close = matchBracket(src.bare, open);
    if (close === -1) continue;
    if (!/^\s*\{?\s*return\s+null\b/.test(src.bare.slice(close + 1, close + 40))) continue;
    if (enclosingFunction(src, open)?.start !== body.start) continue;
    out.push({ at: open, ...slice(src, { start: open + 1, end: close }) });
  }
  return out;
}

/** The true branch of a ternary whose `?` is at `q`: up to the depth-0 `:`. */
function ternaryTrue(bare: string, q: number): Span {
  let depth = 0;
  let k = q + 1;
  for (; k < bare.length; k += 1) {
    const c = bare[k];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth -= 1; }
    else if (c === '?' && bare[k + 1] !== '.' && depth === 0) {
      // A nested ternary eats its own ':'.
      k = ternaryTrue(bare, k).end;
    } else if (c === ':' && depth === 0) break;
  }
  return { start: q + 1, end: k };
}

/**
 * Branches rendered only when `cond` (a regex over the blanked view) holds:
 * `cond && <…>` and `cond ? <…> : …` both count. Returns [whenTrue, whenFalse?].
 */
function conditionalBranches(src: Lexed, cond: RegExp): { at: number; whenTrue: Span; whenFalse: Span | null }[] {
  const out: { at: number; whenTrue: Span; whenFalse: Span | null }[] = [];
  const re = new RegExp(`(?:${cond.source})\\s*\\)*\\s*(&&|\\?(?!\\.))`, 'g');
  for (const m of src.bare.matchAll(re)) {
    const op = m.index + m[0].length - m[1].length;
    if (m[1] === '&&') {
      let start = op + 2;
      while (/\s/.test(src.bare[start] ?? '')) start += 1;
      out.push({ at: m.index, whenTrue: readExpression(src.bare, start), whenFalse: null });
    } else {
      const whenTrue = ternaryTrue(src.bare, op);
      let start = whenTrue.end + 1;
      while (/\s/.test(src.bare[start] ?? '')) start += 1;
      out.push({ at: m.index, whenTrue, whenFalse: readExpression(src.bare, start) });
    }
  }
  return out;
}

const hasJsx = (src: Lexed, span: Span): boolean => /<[A-Za-z]/.test(src.bare.slice(span.start, span.end));

/**
 * FR-FEX-008 AC-5: the component draws a spinner or a bar by the selector's
 * `indeterminate` flag — two different elements, chosen by that flag — and never
 * looks at the phase itself (the selector already turned 'scanning' into it).
 */
function assertIndeterminateBranch(src: Lexed): void {
  const ternaries = conditionalBranches(src, /\bindeterminate\b/)
    .filter(b => b.whenFalse !== null && hasJsx(src, b.whenTrue) && hasJsx(src, b.whenFalse));
  const pairs = conditionalBranches(src, /(?<!!\s*[\w$.]*)\bindeterminate\b/).filter(b => b.whenFalse === null && hasJsx(src, b.whenTrue)).length > 0
    && conditionalBranches(src, /!\s*[\w$.]*\bindeterminate\b/).filter(b => b.whenFalse === null && hasJsx(src, b.whenTrue)).length > 0;
  assert.ok(ternaries.length > 0 || pairs,
    `${src.path}: no element choice on indeterminate — the spinner and the bar must be two elements picked by the selector's flag`);
  for (const b of ternaries) {
    const t = src.bare.slice(b.whenTrue.start, b.whenTrue.end).replace(/\s+/g, '');
    const f = src.bare.slice(b.whenFalse!.start, b.whenFalse!.end).replace(/\s+/g, '');
    assert.notEqual(t, f, `${where(src, b.at)}: both sides of the indeterminate choice draw the same thing`);
  }
  assert.doesNotMatch(src.bare, /\bphase\b/, `${src.path} reads the job phase itself — the selector's indeterminate flag already decides spinner or bar`);
}

/** Every `fileJobApi.cancel(…)` argument in the given text. */
function cancelArgs(text: string): string[] {
  return [...text.matchAll(/\bfileJobApi\s*\.\s*cancel\s*\(([^)]*)\)/g)].map(m => m[1]);
}

/** dispatchFileJob calls whose action has `type: 'TYPE'`. */
function dispatches(src: Lexed, type: string): Span[] {
  return callArgs(src, 'dispatchFileJob').filter(a => new RegExp(`\\btype\\s*:\\s*['"]${type}['"]`).test(src.code.slice(a.start, a.end)));
}

/** Callbacks passed to useEffect/useLayoutEffect, with their deps span. */
function effects(src: Lexed): { callback: Span; deps: Span | null }[] {
  return ['useEffect', 'useLayoutEffect'].flatMap(name => callArgs(src, name).map(args => ({
    callback: firstArg(src, args),
    deps: secondArg(src, args),
  })));
}

/** The cleanup an effect callback returns, when it returns a function (not a call's result). */
function effectCleanups(src: Lexed, callback: Span): Span[] {
  const text = src.bare.slice(callback.start, callback.end);
  const arrow = text.indexOf('=>');
  if (arrow === -1) return [];
  let k = callback.start + arrow + 2;
  while (/\s/.test(src.bare[k] ?? '')) k += 1;
  if (src.bare[k] !== '{') {
    // A concise body returns its own value: only `() => () => …` returns a function.
    const body = readExpression(src.bare, k);
    return /^\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(src.bare.slice(body.start, body.end)) ? [body] : [];
  }
  const close = matchBracket(src.bare, k);
  const out: Span[] = [];
  for (const m of src.bare.slice(k, close).matchAll(/\breturn\b\s*/g)) {
    const at = k + m.index;
    if (enclosingFunction(src, at)?.start !== k) continue;
    const value = readExpression(src.bare, at + m[0].length);
    const v = src.bare.slice(value.start, value.end);
    if (/^\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(v) || /^\s*[A-Za-z_$][\w$]*\s*$/.test(v)) out.push(value);
  }
  return out;
}

/**
 * follow(), plus a handler that is just a prop's name (`onClick={onMore}`):
 * that prop is followed to what the parent passes, like a called one.
 */
function followProps(files: readonly Lexed[], src: Lexed, spans: readonly Span[]): Located[] {
  const out = follow(files, src, spans);
  for (const s of spans) {
    const bare = /^\s*(on[A-Z][\w$]*)\s*$/.exec(src.bare.slice(s.start, s.end));
    if (!bare) continue;
    for (const file of files) {
      for (const h of handlerBodies(file, bare[1])) out.push(...h.spans.map(span => ({ src: file, span })));
    }
  }
  return out;
}

/** Tags with `onClick` inside `span`, each with its handler followed one prop hop into `files`. */
function clicksWithin(files: readonly Lexed[], src: Lexed, span: Span): { at: number; located: Located[] }[] {
  return handlerBodies(src, 'onClick')
    .filter(h => span.start <= h.at && h.at < span.end)
    .map(h => ({ at: h.at, located: followProps(files, src, h.spans) }));
}

const WHOLE = (src: Lexed): Span => ({ start: 0, end: src.bare.length });

/**
 * Whether the action's `origin` carries the window's workspaceId as the value of
 * its `workspaceId` field — `origin: { workspaceId, tabId }`, `workspaceId:
 * props.workspaceId`, or a local `origin` built that way. A field named
 * workspaceId holding anything else does not count.
 */
function originCarriesWorkspace(src: Lexed, args: Span): boolean {
  const text = src.bare.slice(args.start, args.end);
  const m = /\borigin\b\s*(:)?/.exec(text);
  if (!m) return false;
  let value: string;
  if (!m[1]) {
    const def = definitionOf(src, 'origin', args.start);
    if (!def) return false;
    value = src.bare.slice(def.start, def.end);
  } else {
    let start = args.start + m.index + m[0].length;
    while (/\s/.test(src.bare[start] ?? '')) start += 1;
    const span = readExpression(src.bare, start);
    value = src.bare.slice(span.start, span.end);
    if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(value)) {
      const def = definitionOf(src, value.trim(), args.start);
      if (!def) return false;
      value = src.bare.slice(def.start, def.end);
    }
  }
  const field = /\bworkspaceId\b\s*(?::\s*([^,}]+))?/.exec(value);
  return field !== null && (field[1] === undefined || /\bworkspaceId\b/.test(field[1]));
}

/** The inside of every `attr={…}` of a tag, joined — attribute names left out. */
function tagValues(src: Lexed, tag: Span): string {
  const out: string[] = [];
  for (const m of src.bare.slice(tag.start, tag.end).matchAll(/\s[\w-]+\s*=\s*\{/g)) {
    const open = tag.start + m.index + m[0].length - 1;
    const close = matchBracket(src.bare, open);
    if (close !== -1) out.push(src.bare.slice(open + 1, close));
  }
  return out.join('\n');
}

/** Local names bound to what `hook(` returned: `const x = hook(` or `const { a, b: c } = hook(`. */
function boundTo(src: Lexed, hook: string): string[] {
  const out: string[] = [];
  for (const m of src.bare.matchAll(new RegExp(`\\b(?:const|let)\\s+(\\{[^}]*\\}|[A-Za-z_$][\\w$]*)\\s*(?::[^=;]+)?=\\s*${hook}\\s*\\(`, 'g'))) {
    const lhs = m[1];
    if (!lhs.startsWith('{')) { out.push(lhs); continue; }
    for (const part of lhs.slice(1, -1).split(',')) {
      const name = part.split(':').pop()?.split('=')[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// FR-FEX-008 — the bottom status bar and the popover
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-008-AC4-02 FileJobStatusBar 가 App.tsx 에서 렌더되고 useSyncExternalStore(subscribeFileJobs) 로 selectStatusBarView 를 읽는다', () => {
  requireSources([T.app, T.statusBar]);
  const app = read(T.app);
  const bar = read(T.statusBar);

  requireImport(app, M.statusBar, 'FileJobStatusBar');
  assert.equal(openingTags(app, 'FileJobStatusBar').length, 1, `${app.path} must render <FileJobStatusBar> exactly once — one bar for the whole app`);

  // components/StatusBar is dead code that no render path reaches; the file-job
  // bar is its own component and must not revive or extend it.
  for (const src of [app, bar]) {
    for (const i of importsOf(src)) {
      assert.ok(!/^components\/StatusBar(?:\/|$)/.test(i.module), `${src.path} imports src/${i.module} — the unused StatusBar is not where file-job progress goes`);
    }
  }

  const [view] = storeReads(bar, 'selectStatusBarView');
  const v = view.memo!;
  // One job: its bar and the current file's name. Two or more: the count and a spinner.
  assert.match(bar.code, /['"]single['"]/, `${bar.path} never tells the single-job view apart`);
  assert.match(bar.code, /['"]multiple['"]/, `${bar.path} never tells the several-jobs view apart`);
  assert.ok(/\.\s*currentFile\b|\{[^}]*\bcurrentFile\b[^}]*\}\s*=/.test(bar.bare), `${bar.path} never shows the current file's name (view.currentFile)`);
  assert.ok(/\.\s*count\b|\{[^}]*\bcount\b[^}]*\}\s*=/.test(bar.bare), `${bar.path} never shows the job count (view.count)`);
  assert.match(bar.bare, new RegExp(`\\b${v}\\b[\\s\\S]*\\b${v}\\b`), `${bar.path}: the status-bar view (${v}) is computed but never drawn`);
});

test('TC-REQ-FR-FEX-008-AC6-02 FileJobPopover 의 줄 취소 버튼이 fileJobApi.cancel 을 부른다', () => {
  requireSources([T.popover]);
  const pop = read(T.popover);
  requireImport(pop, M.api, 'fileJobApi');

  const [rows] = storeReads(pop, 'selectPopoverRows');
  const maps = callArgs(pop, `${rows.memo!}\\s*\\.\\s*map`);
  assert.ok(maps.length > 0, `${pop.path}: the popover rows (${rows.memo}) are never mapped to one line per job`);
  const cancels = maps.flatMap(span => clicksWithin([pop], pop, span))
    .flatMap(c => cancelArgs(locatedText(c.located, 'code')).map(arg => ({ at: c.at, arg })));
  assert.ok(cancels.length > 0, `${pop.path}: no button in a popover line calls fileJobApi.cancel`);
  for (const c of cancels) {
    assert.match(c.arg, /\bjobId\b/, `${where(pop, c.at)}: the line's cancel must cancel that line's job (…jobId)`);
  }
});

test('TC-REQ-FR-FEX-008-AC7-02 FileJobPopover 에 WindowDialog·useDialogStack·registerDialogStackEntry·Rnd 가 없고 document pointerdown 리스너가 decidePopoverOutsideClose 로 닫는다', () => {
  requireSources([T.popover]);
  const pop = read(T.popover);

  // A popover: no dialog-stack entry, no dragging, no resizing.
  assert.doesNotMatch(pop.bare, /\b(?:WindowDialog|useDialogStack|registerDialogStackEntry|raiseDialogById|Rnd)\b/,
    `${pop.path} joins the dialog stack or becomes draggable/resizable — the popover is neither`);
  for (const i of importsOf(pop)) {
    assert.ok(!/^components\/dialog\//.test(i.module) && i.module !== 'react-rnd', `${pop.path} imports src/${i.module} — a popover needs no dialog machinery`);
  }

  requireImport(pop, M.store, 'decidePopoverOutsideClose');
  const adds = callArgs(pop, 'document\\s*\\.\\s*addEventListener')
    .filter(args => /^\s*['"]pointerdown['"]/.test(pop.code.slice(args.start, args.end)));
  assert.ok(adds.length > 0, `${pop.path}: no document pointerdown listener — a press outside must close the popover`);
  for (const args of adds) {
    const listener = secondArg(pop, args);
    assert.ok(listener !== null, `${where(pop, args.start)}: pointerdown listener missing`);
    const text = spansText(pop, expand(pop, listener));
    assert.match(text.bare, /\bdecidePopoverOutsideClose\s*\(/, `${where(pop, args.start)}: the outside press is not judged by decidePopoverOutsideClose — a press on the status bar would close and reopen it`);
    assert.match(text.bare, /\.\s*contains\s*\(/, `${where(pop, args.start)}: decidePopoverOutsideClose is not given where the press landed (….contains(target))`);
    assert.match(text.bare, /\bif\s*\(\s*!?\s*decidePopoverOutsideClose\s*\(|\bdecidePopoverOutsideClose\s*\([^;]*\)\s*\)?\s*(?:&&|\?)/,
      `${where(pop, args.start)}: decidePopoverOutsideClose(…) does not gate the close`);
    assert.ok(effects(pop).some(e => e.callback.start <= args.start && args.end <= e.callback.end),
      `${where(pop, args.start)}: the listener is not added in an effect`);
  }
  assert.match(pop.bare, /\bdocument\s*\.\s*removeEventListener\s*\(/, `${pop.path}: the pointerdown listener is never removed`);
});

test('TC-REQ-FR-FEX-008-AC8-02 FileJobStatusBar·FileExplorerProgressRow·FileJobPopover 가 뷰(줄)가 비면 null 을 반환한다(자리 없음)', () => {
  requireSources([T.statusBar, T.progressRow, T.popover]);
  const bar = read(T.statusBar);
  const row = read(T.progressRow);
  const pop = read(T.popover);

  const [barView] = storeReads(bar, 'selectStatusBarView');
  const barGuards = nullGuards(bar, componentBody(bar, 'FileJobStatusBar'));
  assert.ok(barGuards.some(g => /\bkind\s*===\s*['"]hidden['"]/.test(g.code) && refersDeep(bar, g.bare, barView.memo!)),
    `${bar.path}: FileJobStatusBar does not return null when the view is hidden — an empty bar would still take a row`);

  const rowGuards = nullGuards(row, componentBody(row, 'FileExplorerProgressRow'));
  assert.ok(rowGuards.some(g => /===\s*null\b|^\s*!\s*[A-Za-z_$][\w$.]*\s*$/.test(g.bare)),
    `${row.path}: FileExplorerProgressRow does not return null when there is no progress view`);

  const [rows] = storeReads(pop, 'selectPopoverRows');
  const popGuards = nullGuards(pop, componentBody(pop, 'FileJobPopover'));
  assert.ok(popGuards.some(g => refersDeep(pop, g.bare, rows.memo!) && /\.\s*length\s*===\s*0|!\s*[\w$.]*\.\s*length\b/.test(g.bare)),
    `${pop.path}: FileJobPopover does not return null when there are no rows`);
});

test('TC-REQ-FR-FEX-008-AC5-02 FileJobStatusBar·FileJobPopover 가 셀렉터의 indeterminate 플래그로 회전 요소와 막대 요소를 분기한다 — phase 를 무시한 막대 고정 렌더 없음', () => {
  requireSources([T.statusBar, T.popover]);
  for (const path of [T.statusBar, T.popover]) assertIndeterminateBranch(read(path));
});

test('TC-REQ-FR-FEX-008-AC9-02 file-job WS 라우팅이 App 수준 useFileJobStoreSync(registerFileJobHandler) 에서 저장소로 가고 FileExplorerWindow 의 submit 이 JOB_STARTED 를 origin.workspaceId 와 함께 dispatch 한다', () => {
  requireSources([T.app, T.sync, T.window, T.opsHook]);
  const app = read(T.app);
  const sync = read(T.sync);
  const win = read(T.window);
  const ops = read(T.opsHook);

  // At the app, not in a window: a closed or minimized window must not stop
  // the store from hearing about its jobs.
  requireImport(app, M.sync, 'useFileJobStoreSync');
  assert.equal(callArgs(app, 'useFileJobStoreSync').length, 1, `${app.path} must call useFileJobStoreSync exactly once`);

  assert.ok(namesFrom(sync, M.ws).some(n => n === 'useWebSocketActions' || n === 'useWebSocket'), `${sync.path} must take registerFileJobHandler from the WebSocket context`);
  requireImport(sync, M.store, 'dispatchFileJob');
  requireImport(sync, M.events, 'routeFileJobMessage');
  const registrations = callArgs(sync, 'registerFileJobHandler');
  assert.ok(registrations.length > 0, `${sync.path} never calls registerFileJobHandler`);
  for (const args of registrations) {
    const handler = spansText(sync, expand(sync, firstArg(sync, args))).bare;
    assert.match(handler, /\brouteFileJobMessage\s*\(/, `${where(sync, args.start)}: the handler does not route through routeFileJobMessage`);
    assert.match(handler, /\bdispatchFileJob\s*\(/, `${where(sync, args.start)}: the handler does not dispatch into the store`);
    assert.ok(effects(sync).some(e => e.callback.start <= args.start && args.end <= e.callback.end),
      `${where(sync, args.start)}: registerFileJobHandler is not called in an effect`);
    assert.match(sync.bare.slice(0, args.start - 1), /(?:=>|\breturn)\s*registerFileJobHandler\s*$/,
      `${where(sync, args.start)}: the effect must return what registerFileJobHandler returns, or the handler outlives the app`);
  }

  // The panel's submit is useFileTreeOperations' job client: the hook
  // dispatches JOB_STARTED with the origin it is given, and the window gives it
  // an origin carrying its own workspaceId.
  requireImport(ops, M.store, 'dispatchFileJob');
  const started = dispatches(ops, 'JOB_STARTED');
  assert.ok(started.length > 0, `${ops.path} never dispatches JOB_STARTED — a submitted job would have no window to show it`);
  for (const args of started) {
    assert.ok(originCarriesWorkspace(ops, args), `${where(ops, args.start)}: JOB_STARTED's origin must carry the given origin's workspaceId`);
    const fn = enclosingFunction(ops, args.start);
    assert.ok(fn !== null && /\bfileJobApi\s*\.\s*submit\s*\(/.test(ops.bare.slice(fn.start, fn.end)),
      `${where(ops, args.start)}: JOB_STARTED is not dispatched where fileJobApi.submit answered`);
    assert.match(ops.bare.slice(args.start, args.end), /\bjobId\b/, `${where(ops, args.start)}: JOB_STARTED does not name the submitted job`);
  }
  assert.doesNotMatch(win.bare, /\bfileJobApi\s*\.\s*submit\s*\(/, `${win.path} submits a job itself — a second job client would bypass the store's JOB_STARTED`);
  requireImport(win, M.opsHook, 'useFileTreeOperations');
  const opsCalls = callArgs(win, 'useFileTreeOperations');
  assert.ok(opsCalls.length > 0, `${win.path} never calls useFileTreeOperations — the panel submits no job`);
  for (const args of opsCalls) {
    assert.ok(originCarriesWorkspace(win, args), `${where(win, args.start)}: useFileTreeOperations' origin must carry the window's workspaceId`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-009 — a job waiting for an answer
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-009-AC2-01 상태바의 \'응답 대기 중\' 버튼(뷰의 awaiting 이 있을 때만 렌더) onClick 이 explorer.reviveFileExplorer 또는 openFileExplorer 로 그 워크스페이스 창을 연다', () => {
  requireSources([T.app, T.statusBar]);
  const app = read(T.app);
  const bar = read(T.statusBar);
  storeReads(bar, 'selectStatusBarView');

  const branches = conditionalBranches(bar, /\bawaiting\b(?:\s*!==?\s*null)?/);
  const buttons = branches.flatMap(b => clicksWithin([bar, app], bar, b.whenTrue).map(c => ({ ...c, branch: b.whenTrue })));
  assert.ok(buttons.length > 0, `${bar.path}: no clickable element rendered only when the view has awaiting`);
  let opens = 0;
  for (const b of buttons) {
    const code = bar.code.slice(b.branch.start, b.branch.end);
    assert.ok(/\bAWAITING_LABEL\b|\.\s*label\b/.test(code), `${where(bar, b.at)}: the awaiting button does not show AWAITING_LABEL (awaiting.label)`);
    const own = locatedText(b.located.filter(l => l.src === bar), 'bare');
    const other = locatedText(b.located.filter(l => l.src === app), 'bare');
    if (/\bexplorer\s*\.\s*(?:reviveFileExplorer|openFileExplorer)\b/.test(other)) {
      opens += 1;
      assert.match(own, /\bworkspaceId\b/, `${where(bar, b.at)}: the awaiting button does not pass the waiting job's workspaceId`);
    }
  }
  assert.ok(opens > 0, `${bar.path}: the awaiting button's handler does not reach explorer.reviveFileExplorer / openFileExplorer in ${app.path}`);
  requireImport(bar, M.store, 'AWAITING_LABEL');
});

test('TC-REQ-FR-FEX-009-AC2-02 useFileJobStoreSync 가 WS (재)연결 시 fileJobApi.list() 결과를 SYNC_LIST 로 넣는다', () => {
  requireSources([T.sync]);
  const sync = read(T.sync);
  requireImport(sync, M.api, 'fileJobApi');
  requireImport(sync, M.store, 'dispatchFileJob');

  const statusNames = [...boundTo(sync, 'useWebSocketState'), ...boundTo(sync, 'useWebSocket')];
  assert.ok(statusNames.length > 0, `${sync.path} does not read the connection state (useWebSocketState / useWebSocket)`);

  const adopting = effects(sync).filter((e) => {
    const text = spansText(sync, expand(sync, e.callback));
    return /\bfileJobApi\s*\.\s*list\s*\(/.test(text.bare) && dispatches(sync, 'SYNC_LIST').some(d => expand(sync, e.callback).some(s => s.start <= d.start && d.end <= s.end));
  });
  assert.ok(adopting.length > 0, `${sync.path}: no effect lists the server's jobs (fileJobApi.list) and dispatches SYNC_LIST`);
  for (const e of adopting) {
    const code = sync.code.slice(e.callback.start, e.callback.end);
    const cmp = /([A-Za-z_$][\w$.]*)\s*[!=]==\s*['"]connected['"]|['"]connected['"]\s*[!=]==\s*([A-Za-z_$][\w$.]*)/.exec(code);
    assert.ok(cmp !== null, `${where(sync, e.callback.start)}: the re-adopt effect does not wait for the socket to be 'connected'`);
    const root = (cmp[1] ?? cmp[2]).split('.')[0];
    assert.ok(statusNames.includes(root), `${where(sync, e.callback.start)}: '${root}' is not the WebSocket context's connection state`);
    assert.ok(e.deps !== null && new RegExp(`\\b${root}\\b`).test(sync.bare.slice(e.deps.start, e.deps.end)),
      `${where(sync, e.callback.start)}: the effect's deps do not include the connection state — a reconnect would not re-adopt`);
  }
  for (const d of dispatches(sync, 'SYNC_LIST')) {
    assert.match(sync.bare.slice(d.start, d.end), /\bworkspaceOfSession\b/, `${where(sync, d.start)}: SYNC_LIST without workspaceOfSession cannot give a listed job back to its window`);
  }
});

// ---------------------------------------------------------------------------
// FR-FEX-008 — the row inside the explorer window
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-008-AC1-02 FileExplorerWindow 가 FileExplorerProgressRow 를 selectWindowJobs(workspaceId) 로 렌더한다', () => {
  requireSources([T.window, T.progressRow]);
  const win = read(T.window);
  const row = read(T.progressRow);

  requireImport(win, M.progressRow, 'FileExplorerProgressRow');
  const tags = openingTags(win, 'FileExplorerProgressRow');
  assert.equal(tags.length, 1, `${win.path} must render <FileExplorerProgressRow> exactly once`);

  // Only this window's jobs: selectWindowJobs(snapshot, workspaceId), read in
  // the window and passed down, or read in the row from a workspaceId prop.
  const readers = [win, row].filter(f => callArgs(f, 'selectWindowJobs').length > 0);
  assert.ok(readers.length > 0, `neither ${win.path} nor ${row.path} calls selectWindowJobs — the row would show other windows' jobs`);
  for (const f of readers) {
    for (const r of storeReads(f, 'selectWindowJobs')) {
      const second = secondArg(f, r.args);
      assert.ok(second !== null && refersDeep(f, f.bare.slice(second.start, second.end), 'workspaceId'),
        `${where(f, r.args.start)}: selectWindowJobs must be given the window's workspaceId`);
      const tagText = tagValues(win, tags[0]);
      const needle = f === win ? r.memo! : 'workspaceId';
      assert.ok(refersDeep(win, tagText, needle),
        `${where(win, tags[0].start)}: <FileExplorerProgressRow> is not given ${f === win ? `the window's jobs (${needle})` : 'workspaceId'}`);
    }
  }
  const viewers = [win, row].filter(f => callArgs(f, 'selectProgressRowView').length > 0);
  assert.ok(viewers.length > 0, 'the row view never comes from selectProgressRowView');
  for (const f of viewers) memoCalls(f, 'selectProgressRowView');
});

test('TC-REQ-FR-FEX-008-AC2-02 진행 줄 취소 버튼이 fileJobApi.cancel 을 부른다', () => {
  requireSources([T.window, T.progressRow]);
  const win = read(T.window);
  const row = read(T.progressRow);
  const cancels = clicksWithin([row, win], row, WHOLE(row))
    .flatMap(c => cancelArgs(locatedText(c.located, 'code')).map(arg => ({ at: c.at, arg })));
  assert.ok(cancels.length > 0, `${row.path}: no button in the row reaches fileJobApi.cancel`);
  for (const c of cancels) {
    assert.match(c.arg, /\bjobId\b/, `${where(row, c.at)}: the row's cancel must cancel the job it shows (…jobId)`);
  }
});

test('TC-REQ-FR-FEX-008-AC3-02 진행 줄의 \'외 N개\' 버튼이 알림창을 연다(저장소의 popover open 상태를 공유)', () => {
  requireSources([T.window, T.progressRow, T.popover, T.statusBar]);
  const win = read(T.window);
  const row = read(T.progressRow);
  const pop = read(T.popover);
  const bar = read(T.statusBar);

  const branches = conditionalBranches(row, /\bmoreCount\b(?:\s*>\s*0)?/);
  const buttons = branches.flatMap(b => clicksWithin([row, win], row, b.whenTrue).map(c => ({ ...c, branch: b.whenTrue })));
  assert.ok(buttons.length > 0, `${row.path}: no clickable '외 N개' rendered only when moreCount is above zero`);

  const OWN_POPOVER = new Set(['selectPopoverRows', 'decidePopoverOutsideClose', 'FileJobPopover']);
  const sharedModules = new Set([pop, bar].flatMap(f => importsOf(f)
    .filter(i => i.names.some(n => /popover/i.test(n) && !OWN_POPOVER.has(n)))
    .map(i => i.module)));
  let shared = 0;
  for (const b of buttons) {
    assert.match(row.bare.slice(b.branch.start, b.branch.end), /\bmoreCount\b/, `${where(row, b.at)}: the button does not show how many more jobs there are`);
    for (const l of b.located) {
      const text = l.src.code.slice(l.span.start, l.span.end);
      for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\?\.\s*)?\(([^)]*)/g)) {
        if (!/popover/i.test(m[0])) continue;
        const from = importsOf(l.src).find(i => i.names.includes(m[1]));
        if (from && from.module !== M.api && from.module !== 'react' && sharedModules.has(from.module)) shared += 1;
      }
    }
  }
  assert.ok(shared > 0,
    `${row.path}: '외 N개' does not open the popover through state the popover shares — it must call a popover opener imported from a module ${pop.path} or ${bar.path} also reads a popover name from`);
});

test('TC-REQ-FR-FEX-008-AC5-03 FileExplorerProgressRow 가 indeterminate 플래그로 회전 요소와 막대 요소를 분기한다', () => {
  requireSources([T.progressRow]);
  assertIndeterminateBranch(read(T.progressRow));
});

// ---------------------------------------------------------------------------
// FR-FEX-009 — the question comes back with the window
// ---------------------------------------------------------------------------

test('TC-REQ-FR-FEX-009-AC3-02 창의 모달 큐가 selectPendingDecisionsForWindow(workspaceId) 에서 채워진다 — 창이 마운트되면 기다리던 결정이 뜬다', () => {
  requireSources([T.window]);
  const win = read(T.window);

  const [pending] = storeReads(win, 'selectPendingDecisionsForWindow');
  const second = secondArg(win, pending.args);
  assert.ok(second !== null && refersDeep(win, win.bare.slice(second.start, second.end), 'workspaceId'),
    `${where(win, pending.args.start)}: selectPendingDecisionsForWindow must be given the window's workspaceId`);
  const asking = effects(win).filter(e => new RegExp(`\\b${pending.memo!}\\b`).test(win.bare.slice(e.callback.start, e.callback.end)));
  assert.ok(asking.some(e => /\bfileJobApi\s*\.\s*decide\s*\(/.test(spansText(win, expand(win, e.callback)).bare)),
    `${win.path}: no effect takes the pending decisions (${pending.memo}) to a question that answers with fileJobApi.decide`);

  const answered = dispatches(win, 'DECISION_ANSWERED');
  assert.ok(answered.length > 0, `${win.path} never dispatches DECISION_ANSWERED — an answered question would be asked again`);
  for (const d of answered) assert.match(win.bare.slice(d.start, d.end), /\bdecisionId\b/, `${where(win, d.start)}: DECISION_ANSWERED must name the decision it answers`);

  const [failures] = storeReads(win, 'selectWindowFailures');
  const shown = dispatches(win, 'FAILURE_SHOWN');
  assert.ok(shown.length > 0, `${win.path} never dispatches FAILURE_SHOWN — a shown failure would stay in the store`);
  assert.ok(effects(win).some(e => new RegExp(`\\b${failures.memo!}\\b`).test(win.bare.slice(e.callback.start, e.callback.end))
      && shown.some(d => expand(win, e.callback).some(s => s.start <= d.start && d.end <= s.end))),
    `${win.path}: FAILURE_SHOWN is not dispatched by the effect that shows the window's failures (${failures.memo})`);

  // The store keeps a question until its window returns, so nothing may cancel
  // a job because a window went away.
  assert.doesNotMatch(win.bare, /\bcreateFileJobOwnership\b/, `${win.path} still creates a fileJobOwnership — its dispose cancels a waiting job on unmount`);
  assert.ok(!namesFrom(win, M.ownership).includes('createFileJobOwnership'), `${win.path} still imports createFileJobOwnership`);
  for (const e of effects(win)) {
    for (const cleanup of effectCleanups(win, e.callback)) {
      const text = spansText(win, expand(win, cleanup)).bare;
      assert.doesNotMatch(text, /\.\s*cancel\s*\(|\bdispose\s*\(/, `${where(win, cleanup.start)}: an effect cleanup cancels a job when the window unmounts`);
    }
  }
});

test('TC-REQ-FR-FEX-009-AC4-01 응답 대기 경로의 결정도 FileExplorerWindowModal 로만 그리고 portal·dialog stack 을 쓰지 않는다', () => {
  requireSources([T.window, T.windowModal, T.progressRow, T.statusBar, T.popover]);
  const win = read(T.window);

  requireImport(win, M.windowModal, 'useFileExplorerWindowModal');
  requireImport(win, M.windowModal, 'FileExplorerWindowModal');
  assert.ok(openingTags(win, 'FileExplorerWindowModal').length > 0, `${win.path} never renders <FileExplorerWindowModal>`);
  const modal = boundTo(win, 'useFileExplorerWindowModal');
  assert.ok(modal.length > 0, `${win.path}: what useFileExplorerWindowModal() returns is never bound`);

  const [pending] = storeReads(win, 'selectPendingDecisionsForWindow');
  const asking = effects(win).filter(e => new RegExp(`\\b${pending.memo!}\\b`).test(win.bare.slice(e.callback.start, e.callback.end)));
  assert.ok(asking.length > 0, `${win.path}: the pending decisions (${pending.memo}) never reach an effect`);
  for (const e of asking) {
    const text = spansText(win, expand(win, e.callback)).bare;
    assert.ok(modal.some(n => new RegExp(`\\b${n}\\s*(?:\\.|\\(|\\?\\.)`).test(text)),
      `${where(win, e.callback.start)}: a waiting decision is not asked through the window modal (${modal.join(', ')})`);
    // decideJob on the window modal is the withdrawable entry (dropJob takes the question back when
    // its job ends elsewhere), so it is allowed; what must not happen is asking through the confirm row.
    for (const bar of boundTo(win, 'useFileExplorerConfirmBar')) {
      assert.doesNotMatch(text, new RegExp(`\\b${bar}\\s*(?:\\.|\\?\\.)`), `${where(win, e.callback.start)}: a waiting decision is asked through the confirm row (${bar}), not the window modal`);
    }
  }

  for (const path of [T.window, T.windowModal, T.progressRow, T.statusBar, T.popover]) {
    const src = read(path);
    assert.doesNotMatch(src.bare, /\bcreatePortal\b/, `${src.path} portals out — the question must stay inside its window`);
    if (path !== T.window) {
      assert.doesNotMatch(src.bare, /\b(?:useDialogStack|registerDialogStackEntry)\b/, `${src.path} joins the dialog stack`);
    }
  }
});
