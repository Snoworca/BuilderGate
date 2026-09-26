import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from '@codemirror/language';
import {
  atomicEditorTheme,
  atomicMarkdownSyntax,
} from '../../src/editor/vendor/atomic-editor/atomic-theme.ts';
import type * as CodeEditorExtensionsModule from '../../src/components/editor/codeEditorExtensions.ts';

// FR-MDE-014 -- the code-mode editor: the extension bundle, the global wrap
// preference and the lazy language load, all without a DOM.
//
// Contract fixed here for src/components/editor/codeEditorExtensions.ts:
//   buildCodeEditorExtensions({ wrap: boolean, language: <nullable> })
//       -> { extensions: Extension[], features: readonly string[] }
//     `features` names what the bundle carries so a DOM-less test can see it.
//   WRAP_PREFERENCE_KEY: string                      one global localStorage key
//   readWrapPreference(storage?)  -> boolean          default false, never throws
//   writeWrapPreference(value, storage?) -> void      never throws
//   loadLanguageSupport(id, describe?) -> Promise<LanguageSupport | null>
//     `describe` defaults to languages.ts's languageDescriptionFor; injected here.
//     Resolves null (plain text) for a null/unknown id or a failing loader.
//
// The module must load under `node --experimental-strip-types`: relative
// imports carry the `.ts` suffix, and nothing reachable at module top level
// may pull an extensionless import chain (languages.ts does -- load it lazily).
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named. The `import type` line is erased
// at runtime and lets tsc check every call against the real signature.
const MODULE_PATH = '../../src/components/editor/codeEditorExtensions.ts';
type Mod = typeof CodeEditorExtensionsModule;

async function loadModule(): Promise<Mod> {
  return await import(MODULE_PATH) as Mod;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function memoryStorage(): StorageLike & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, String(v)); },
    keys: () => [...map.keys()],
  };
}

const throwingStorage: StorageLike = {
  getItem: () => { throw new Error('SecurityError: storage blocked'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

// Every leaf extension object, walking arrays, Prec wrappers (`extension`)
// and compartment instances (`inner`). StateField, Facet providers and other
// @codemirror/state leaves expose `get extension() { return this; }`, so each
// object is walked once -- without the guard the walk never terminates.
function flatten(ext: Extension, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (Array.isArray(ext)) {
    for (const e of ext) flatten(e, out, seen);
    return out;
  }
  if (seen.has(ext)) return out;
  seen.add(ext);
  out.push(ext);
  if (ext !== null && typeof ext === 'object') {
    const rec = ext as Record<string, unknown>;
    if ('extension' in rec) flatten(rec.extension as Extension, out, seen);
    if ('inner' in rec) flatten(rec.inner as Extension, out, seen);
  }
  return out;
}

// Comment-stripped source text. String literals are kept on purpose: a colour
// literal inside a string is exactly what the AC-5 guard must catch.
function sourceWithoutComments(relativeFromTest: string): string {
  const url = new URL(relativeFromTest, import.meta.url);
  assert.ok(existsSync(url), `${relativeFromTest} must exist`);
  return readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const EXTENSIONS_SOURCE = '../../src/components/editor/codeEditorExtensions.ts';
const COMPONENT_SOURCE = '../../src/components/editor/CodeFileEditor.tsx';

test('TC-REQ-FR-MDE-014-AC1-01 buildCodeEditorExtensions 가 lineNumbers·highlightActiveLine·foldGutter·bracketMatching·closeBrackets·allowMultipleSelections·search keymap·문서 단어 completion 을 포함한다(식별 가능한 이름 목록 반환)', async () => {
  const { buildCodeEditorExtensions } = await loadModule();
  assert.equal(typeof buildCodeEditorExtensions, 'function', 'exports buildCodeEditorExtensions');

  const bundle = buildCodeEditorExtensions({ wrap: false, language: null });
  for (const name of [
    'lineNumbers',
    'highlightActiveLine',
    'foldGutter',
    'bracketMatching',
    'closeBrackets',
    'allowMultipleSelections',
    'searchKeymap',
    'wordCompletion',
  ]) {
    assert.ok(bundle.features.includes(name), `AC-1: feature "${name}" missing -- got [${bundle.features.join(', ')}]`);
  }

  // The names must describe real extensions: the bundle builds a state and
  // multi-cursor is actually on in it.
  const state = EditorState.create({ doc: 'a\nb', extensions: bundle.extensions });
  assert.equal(state.facet(EditorState.allowMultipleSelections), true, 'AC-1: allowMultipleSelections facet is on');
});

test('TC-REQ-FR-MDE-014-AC2-01 코드 모드 확장 목록에 라이브 프리뷰·표 위젯·이미지 블록·마크다운 입력 보조가 없다; 소스 가드: codeEditorExtensions.ts 가 atomic-editor 의 markdown 확장을 import 하지 않는다', async () => {
  const { buildCodeEditorExtensions } = await loadModule();
  const bundle = buildCodeEditorExtensions({ wrap: false, language: null });

  for (const feature of bundle.features) {
    assert.doesNotMatch(
      feature,
      /markdown|livePreview|table|image|listContinuation|emphasis/i,
      `AC-2: markdown decoration "${feature}" must not be in code mode`,
    );
  }
  // atomicMarkdownSyntax is an array and flatten spreads arrays, so the array
  // itself never appears among the leaves -- compare its own top-level parts,
  // minus the ones every syntaxHighlighting() call shares (the module-level
  // tree-highlighter plugin), which cannot tell this instance apart.
  const leaves = flatten(bundle.extensions);
  const sharedParts = ([] as unknown[]).concat(syntaxHighlighting(HighlightStyle.define([])));
  const markdownSyntaxParts = ([] as unknown[])
    .concat(atomicMarkdownSyntax)
    .filter((part) => !sharedParts.includes(part));
  assert.ok(markdownSyntaxParts.length > 0, 'AC-2: atomicMarkdownSyntax has parts to compare');
  assert.ok(
    !markdownSyntaxParts.some((part) => leaves.includes(part)),
    'AC-2: atomicMarkdownSyntax (markdown highlight) must not be in code mode',
  );

  const src = sourceWithoutComments(EXTENSIONS_SOURCE);
  const specifiers = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specifiers) {
    assert.notEqual(spec, '@codemirror/lang-markdown', 'AC-2: no markdown language import');
    assert.doesNotMatch(spec, /doculight-extensions|\/core\//, `AC-2: no markdown live-preview import (${spec})`);
    if (/atomic-editor/.test(spec)) {
      assert.match(spec, /atomic-editor\/atomic-theme(\.ts)?$/, `AC-2: only the theme may come from atomic-editor (${spec})`);
    }
  }
});

test('TC-REQ-FR-MDE-014-AC3-01 readWrapPreference 기본 false; writeWrapPreference 가 localStorage 전역 키에 저장하고 문서 본문을 바꾸지 않는다; storage 예외 시 false', async () => {
  const { readWrapPreference, writeWrapPreference, WRAP_PREFERENCE_KEY, buildCodeEditorExtensions } = await loadModule();
  assert.equal(typeof readWrapPreference, 'function', 'exports readWrapPreference');
  assert.equal(typeof writeWrapPreference, 'function', 'exports writeWrapPreference');
  assert.equal(typeof WRAP_PREFERENCE_KEY, 'string', 'exports WRAP_PREFERENCE_KEY');

  const storage = memoryStorage();
  assert.equal(readWrapPreference(storage), false, 'AC-3: wrap is off by default');

  writeWrapPreference(true, storage);
  assert.equal(readWrapPreference(storage), true, 'AC-3: toggled preference reads back');
  assert.deepEqual(storage.keys(), [WRAP_PREFERENCE_KEY], 'AC-3: one global key, nothing per document');
  writeWrapPreference(false, storage);
  assert.equal(readWrapPreference(storage), false, 'AC-3: toggles back off');

  assert.equal(readWrapPreference(throwingStorage), false, 'AC-3: storage failure reads as false');
  assert.doesNotThrow(() => writeWrapPreference(true, throwingStorage), 'AC-3: storage failure on write is swallowed');

  // Wrap is a view option, not content: the bundle adds lineWrapping only when
  // asked and the document text is untouched either way.
  const doc = 'const x = 1;\n  line two with trailing space   \n\tindented\n';
  const on = buildCodeEditorExtensions({ wrap: true, language: null });
  const off = buildCodeEditorExtensions({ wrap: false, language: null });
  assert.ok(flatten(on.extensions).includes(EditorView.lineWrapping), 'AC-3: wrap=true carries lineWrapping');
  assert.ok(!flatten(off.extensions).includes(EditorView.lineWrapping), 'AC-3: wrap=false has no lineWrapping');
  const a = EditorState.create({ doc, extensions: on.extensions }).doc.toString();
  const b = EditorState.create({ doc, extensions: off.extensions }).doc.toString();
  assert.equal(a, doc, 'AC-3: wrap=true leaves the document text untouched');
  assert.equal(a, b, 'AC-3: wrap on/off yields the same document text');
});

test('TC-REQ-FR-MDE-014-AC4-01 loadLanguageSupport: 로더 reject·미등록 language 는 null(일반 텍스트)로 끝나고 throw 하지 않는다', async () => {
  const { loadLanguageSupport } = await loadModule();
  assert.equal(typeof loadLanguageSupport, 'function', 'exports loadLanguageSupport');

  const fakeSupport = { extension: [] } as unknown as LanguageSupport;
  const calls: (string | null)[] = [];
  const describe = (id: string | null) => {
    calls.push(id);
    if (id === 'ok') return { load: async () => fakeSupport };
    if (id === 'broken') return { load: () => Promise.reject(new Error('chunk load failed')) };
    if (id === 'throws') return { load: () => { throw new Error('sync failure'); } };
    return null;
  };
  type Describe = NonNullable<Parameters<Mod['loadLanguageSupport']>[1]>;
  const d = describe as unknown as Describe;

  assert.equal(await loadLanguageSupport(null, d), null, 'AC-4: null id -> plain text');
  assert.equal(await loadLanguageSupport('not-a-language', d), null, 'AC-4: unknown id -> plain text');
  assert.equal(await loadLanguageSupport('broken', d), null, 'AC-4: rejected loader -> plain text, no throw');
  assert.equal(await loadLanguageSupport('throws', d), null, 'AC-4: throwing loader -> plain text, no throw');
  assert.equal(await loadLanguageSupport('ok', d), fakeSupport, 'AC-4: a loaded grammar is returned');
  assert.ok(calls.includes('ok'), 'AC-4: the injected resolver is consulted');
});

test('TC-REQ-FR-MDE-014-AC5-01 소스 가드: CodeFileEditor.tsx·codeEditorExtensions.ts 에 #hex·rgb( 색 리터럴이 없고 atomic-theme 를 재사용한다', () => {
  const sources = [EXTENSIONS_SOURCE, COMPONENT_SOURCE].map((p) => [p, sourceWithoutComments(p)] as const);
  for (const [path, src] of sources) {
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, `AC-5: ${path} has a #hex colour literal`);
    assert.doesNotMatch(src, /\b(?:rgba?|hsla?)\s*\(/, `AC-5: ${path} has an rgb()/hsl() colour literal`);
  }
  assert.ok(
    sources.some(([, src]) => /\batomicEditorTheme\b/.test(src)),
    'AC-5: the existing atomicEditorTheme is reused',
  );
  // Touch the import so the theme module is proven loadable in this runner.
  assert.ok(atomicEditorTheme);
});

// TC-REQ-FR-MDE-014-AC1-02 -- the sticky gutter must be opaque: with a
// transparent gutter, text scrolled sideways shows through the line numbers.
test('TC-REQ-FR-MDE-014-AC1-02: the code-mode gutter is painted with the document panel background, not left transparent', () => {
  const src = readFileSync(new URL('../../src/components/editor/codeEditorExtensions.ts', import.meta.url), 'utf8');
  const gutters = src.match(/'\.cm-gutters':\s*\{([^}]*)\}/);
  assert.ok(gutters, 'no .cm-gutters rule in the code theme');
  assert.doesNotMatch(gutters![1], /backgroundColor:\s*'transparent'/);
  assert.match(gutters![1], /backgroundColor:\s*'var\(--editor-doc-bg\)'/);
  const css = readFileSync(new URL('../../src/components/editor/EditorWindow.css', import.meta.url), 'utf8');
  assert.match(css, /\.editor-document-panel\s*\{[^}]*--editor-doc-bg:\s*var\(--bg-paper\)/);
  assert.match(css, /\.editor-document-panel\[data-editor-theme='dark'\]\s*\{[^}]*--editor-doc-bg:\s*var\(--bg-surface\)/);
});

// TC-REQ-FR-MDE-014-AC3-03 -- the vendor stylesheet puts `text-wrap: pretty`
// on .cm-content, which in Chromium also sets text-wrap-mode: wrap and so wraps
// code with the toggle off. Code mode turns the mode back off unless the
// wrap toggle's cm-lineWrapping class is present.
test('TC-REQ-FR-MDE-014-AC3-03: code mode keeps lines unwrapped while the wrap toggle is off', () => {
  const css = readFileSync(new URL('../../src/components/editor/EditorWindow.css', import.meta.url), 'utf8');
  assert.match(css, /\[data-editor-mode='code'\][^{]*\.cm-content:not\(\.cm-lineWrapping\)[^{]*\{[^}]*text-wrap-mode:\s*nowrap/);
  assert.match(css, /\.svg-file-tab-source[^{]*\.cm-content:not\(\.cm-lineWrapping\)[^{]*\{[^}]*text-wrap-mode:\s*nowrap/);
});

// TC-REQ-FR-MDE-014-AC1-03 -- the text does not touch the editor's edges: code
// mode pads the content top and bottom and each line left and right, and the
// line numbers sit off the gutter's left edge.
test('TC-REQ-FR-MDE-014-AC1-03: code mode pads the text away from the edges', () => {
  const src = readFileSync(new URL('../../src/components/editor/codeEditorExtensions.ts', import.meta.url), 'utf8');
  const rule = (selector: string) => src.match(new RegExp(`'${selector.replace(/[.]/g, '\\.')}':\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  assert.match(rule('.cm-content'), /padding:\s*'8px 0'/);
  assert.match(rule('.cm-line'), /padding:\s*'0 16px 0 10px'/);
  assert.match(rule('.cm-gutterElement'), /padding:\s*'0 6px 0 10px'/);
});
