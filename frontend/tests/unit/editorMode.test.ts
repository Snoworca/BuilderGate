import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as EditorModeModule from '../../src/editor/editorMode.ts';

// FR-MDE-013 -- one table decides, from the file name alone, which editor mode
// a file opens in (markdown / code / image) or that it does not open (none).
//
// Contract fixed here for src/editor/editorMode.ts:
//   resolveEditorMode(name: string)
//       -> { kind: 'markdown' | 'code' | 'image' | 'none', language: string | null }
//   language is non-null only for kind 'code'; null there means plain text.
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named. The `import type` line is erased
// at runtime and lets tsc check every call against the real signature.
const EDITOR_MODE_PATH = '../../src/editor/editorMode.ts';
type EditorMode = typeof EditorModeModule;

async function loadEditorMode(): Promise<EditorMode['resolveEditorMode']> {
  const m = await import(EDITOR_MODE_PATH) as EditorMode;
  assert.equal(
    typeof (m as unknown as Record<string, unknown>).resolveEditorMode,
    'function',
    'editorMode exports resolveEditorMode',
  );
  return m.resolveEditorMode;
}

const MARKDOWN = { kind: 'markdown', language: null } as const;
const IMAGE = { kind: 'image', language: null } as const;
const NONE = { kind: 'none', language: null } as const;
const code = (language: string | null) => ({ kind: 'code', language });

// ---------------------------------------------------------------------------
// docs/research/2026-09-26.code-and-data-file-editor.md §3.4 (language table),
// copied as test data. Language ids are this test's contract.
//
// Deliberate departures from the research table, each decided by the SRS:
//   - `cfg` `conf` are listed there under INI/Properties, but FR-MDE-013 AC-4
//     makes them plain-text code mode. They live in TEXT_EXTENSIONS instead.
//   - `svg` is listed there under XML, but AC-5 makes it an image, and the
//     image rule runs before the language rule (AC-1).
//   - The "Ruby / Perl / ... 표준 확장자" row names no extension, so AC-3 has
//     nothing to pin for it.
//   - `bat` `cmd` are "일반 텍스트" in the table: language null.
//   - `SCSS·Less` share one row there; here they are separate ids `scss` and
//     `less`, since each resolves to its own CodeMirror language.
// ---------------------------------------------------------------------------
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  typescript: ['ts', 'mts', 'cts', 'tsx'],
  python: ['py', 'pyw', 'pyi'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  scala: ['scala', 'sc'],
  csharp: ['cs'],
  dart: ['dart'],
  objectivec: ['m', 'mm'],
  c: ['c', 'h'],
  cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'],
  go: ['go'],
  rust: ['rs'],
  php: ['php'],
  sql: ['sql'],
  html: ['html', 'htm', 'xhtml', 'vue', 'svelte'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'pom', 'csproj', 'props', 'targets', 'xaml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sass: ['sass'],
  stylus: ['styl'],
  json: ['json', 'json5', 'jsonc', 'jsonl', 'webmanifest'],
  yaml: ['yml', 'yaml'],
  toml: ['toml'],
  properties: ['ini', 'properties', 'editorconfig', 'gitconfig'],
  shell: ['sh', 'bash', 'zsh', 'ksh'],
  powershell: ['ps1', 'psm1', 'psd1'],
  makefile: ['mk', 'mak'],
  cmake: ['cmake'],
  nginx: ['nginx'],
  diff: ['diff', 'patch'],
};

const PLAIN_CODE_EXTENSIONS = ['bat', 'cmd'] as const;

// §3.4 file names that carry a language.
const LANGUAGE_FILE_NAMES: Readonly<Record<string, string>> = {
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
};

// §3.1 step 1, the exact-file-name table, every entry. Value = expected
// language. §3.4 names a language for the Dockerfile/Makefile families by file
// name, so Containerfile and GNUmakefile follow their family. `.editorconfig`
// gets `properties` because §3.4 lists `editorconfig` in that row. Every other
// entry has no language in §3.4 and is plain-text code mode (AC-4).
const EXACT_FILE_NAMES: Readonly<Record<string, string | null>> = {
  Dockerfile: 'dockerfile',
  Containerfile: 'dockerfile',
  Makefile: 'makefile',
  GNUmakefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  Jenkinsfile: null,
  Vagrantfile: null,
  Gemfile: null,
  Rakefile: null,
  Procfile: null,
  Justfile: null,
  '.gitignore': null,
  '.gitattributes': null,
  '.gitmodules': null,
  '.editorconfig': 'properties',
  '.npmrc': null,
  '.nvmrc': null,
  '.yarnrc': null,
  '.dockerignore': null,
  '.eslintignore': null,
  '.prettierignore': null,
  '.babelrc': 'json',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.htaccess': null,
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.profile': 'shell',
  LICENSE: null,
  README: null,
};

const TEXT_EXTENSIONS = ['txt', 'log', 'lock', 'csv', 'tsv', 'conf', 'cfg'] as const;

const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdx', 'mkd'] as const;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'] as const;

// AC-9 -- snapshot of VIEWABLE_EXTENSIONS in src/utils/viewableExtensions.ts
// as of this commit. Copied, not imported: AC-8 retires that set, and this
// list must keep testing the old promise after the source is gone.
const VIEWABLE_EXTENSIONS_SNAPSHOT = [
  '.md', '.markdown', '.mdx',
  '.txt',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.java', '.c', '.h', '.cpp', '.cc', '.hpp',
  '.go', '.rs', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.css', '.scss',
  '.json', '.json5', '.yml', '.yaml', '.xml', '.svg', '.sql',
] as const;

test('규칙 순서: 정확한 파일명 > .env 접두사 > 마크다운 > 이미지 > 언어 > 텍스트; 대소문자 무시(README.MD, Dockerfile, .ENV.local)', async () => {
  const resolveEditorMode = await loadEditorMode();
  // exact name beats the text extension
  assert.deepEqual(resolveEditorMode('CMakeLists.txt'), code('cmake'));
  assert.deepEqual(resolveEditorMode('notes.txt'), code(null));
  // mdx is markdown, not a language mode (AC-2); svg is an image even though
  // §3.4 lists it under XML (AC-1 order, AC-5)
  assert.deepEqual(resolveEditorMode('page.mdx'), MARKDOWN);
  assert.deepEqual(resolveEditorMode('logo.svg'), IMAGE);
  // .env prefix rule: `.env` and `.env.*` only
  assert.deepEqual(resolveEditorMode('.env'), code('shell'));
  assert.deepEqual(resolveEditorMode('.env.production'), code('shell'));
  assert.deepEqual(resolveEditorMode('.envrc'), NONE);
  // case-insensitive everywhere
  assert.deepEqual(resolveEditorMode('README.MD'), MARKDOWN);
  assert.deepEqual(resolveEditorMode('readme'), code(null));
  assert.deepEqual(resolveEditorMode('dockerfile'), code('dockerfile'));
  assert.deepEqual(resolveEditorMode('DOCKERFILE'), code('dockerfile'));
  assert.deepEqual(resolveEditorMode('.ENV.local'), code('shell'));
  assert.deepEqual(resolveEditorMode('MAIN.TS'), code('typescript'));
  assert.deepEqual(resolveEditorMode('PHOTO.JPG'), IMAGE);
});

test('md·markdown·mdx·mkd → markdown (mdx 가 언어표에 있어도 markdown)', async () => {
  const resolveEditorMode = await loadEditorMode();
  for (const ext of MARKDOWN_EXTENSIONS) {
    assert.deepEqual(resolveEditorMode(`doc.${ext}`), MARKDOWN, `doc.${ext}`);
  }
});

test('연구 문서 3.4 표의 모든 확장자·파일명이 해당 language 의 code 모드', async () => {
  const resolveEditorMode = await loadEditorMode();
  for (const [language, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
    for (const ext of exts) {
      assert.deepEqual(resolveEditorMode(`file.${ext}`), code(language), `file.${ext}`);
    }
  }
  for (const ext of PLAIN_CODE_EXTENSIONS) {
    assert.deepEqual(resolveEditorMode(`run.${ext}`), code(null), `run.${ext}`);
  }
  for (const [name, language] of Object.entries(LANGUAGE_FILE_NAMES)) {
    assert.deepEqual(resolveEditorMode(name), code(language), name);
  }
});

test('연구 문서 3.1 1번 목록 전부 판정; 언어 없는 항목과 txt·log·lock·csv·tsv·conf·cfg 는 language=null code 모드', async () => {
  const resolveEditorMode = await loadEditorMode();
  for (const [name, language] of Object.entries(EXACT_FILE_NAMES)) {
    assert.deepEqual(resolveEditorMode(name), code(language), name);
  }
  for (const ext of TEXT_EXTENSIONS) {
    assert.deepEqual(resolveEditorMode(`data.${ext}`), code(null), `data.${ext}`);
  }
});

test('png·jpg·jpeg·gif·webp·bmp·ico·avif·svg → image', async () => {
  const resolveEditorMode = await loadEditorMode();
  for (const ext of IMAGE_EXTENSIONS) {
    assert.deepEqual(resolveEditorMode(`pic.${ext}`), IMAGE, `pic.${ext}`);
  }
});

test('.gitignore·.npmrc 는 이름 전체로 먼저 찾고, 미등록 dotfile(.foo)은 none', async () => {
  const resolveEditorMode = await loadEditorMode();
  // A dotfile's "extension" is its whole name; the name table must win.
  assert.deepEqual(resolveEditorMode('.gitignore'), code(null));
  assert.deepEqual(resolveEditorMode('.npmrc'), code(null));
  assert.deepEqual(resolveEditorMode('.babelrc'), code('json'));
  assert.deepEqual(resolveEditorMode('.foo'), NONE);
});

test('기존 VIEWABLE_EXTENSIONS 스냅샷(테스트 내 상수) 전 항목이 markdown·code·image 중 하나', async () => {
  const resolveEditorMode = await loadEditorMode();
  for (const ext of VIEWABLE_EXTENSIONS_SNAPSHOT) {
    const mode = resolveEditorMode(`file${ext}`);
    assert.ok(
      mode.kind === 'markdown' || mode.kind === 'code' || mode.kind === 'image',
      `file${ext} opens (got ${JSON.stringify(mode)})`,
    );
  }
});

test('resolveEditorMode("a.exe") / ("noext") → none', async () => {
  const resolveEditorMode = await loadEditorMode();
  assert.deepEqual(resolveEditorMode('a.exe'), NONE);
  assert.deepEqual(resolveEditorMode('noext'), NONE);
});
