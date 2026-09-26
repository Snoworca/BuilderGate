// FR-MDE-013 -- the one table that decides, from a file name alone, which
// editor mode a file opens in. Framework-free on purpose: the explorer, the
// document panel and unit tests all read it without React or CodeMirror.
//
// Rule order (AC-1), first match wins, case-insensitive:
//   exact file name > `.env` / `.env.*` > markdown > image > language > text.
// A name starting with a dot is looked up whole first (AC-7); only then does
// its trailing segment count as an extension.

export type EditorModeKind = 'markdown' | 'code' | 'image' | 'none';

export interface EditorMode {
  kind: EditorModeKind;
  /** Language id for `code` mode; null means plain text. Always null otherwise. */
  language: string | null;
}

// Research doc §3.1 step 1. Keys are lower-case; value is the language id or
// null for plain-text code mode (AC-4).
const EXACT_FILE_NAMES: ReadonlyMap<string, string | null> = new Map<string, string | null>([
  ['dockerfile', 'dockerfile'],
  ['containerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['gnumakefile', 'makefile'],
  ['cmakelists.txt', 'cmake'],
  ['jenkinsfile', null],
  ['vagrantfile', null],
  ['gemfile', null],
  ['rakefile', null],
  ['procfile', null],
  ['justfile', null],
  ['.gitignore', null],
  ['.gitattributes', null],
  ['.gitmodules', null],
  ['.editorconfig', 'properties'],
  ['.npmrc', null],
  ['.nvmrc', null],
  ['.yarnrc', null],
  ['.dockerignore', null],
  ['.eslintignore', null],
  ['.prettierignore', null],
  ['.babelrc', 'json'],
  ['.prettierrc', 'json'],
  ['.eslintrc', 'json'],
  ['.htaccess', null],
  ['.bashrc', 'shell'],
  ['.zshrc', 'shell'],
  ['.profile', 'shell'],
  ['license', null],
  ['readme', null],
]);

const ENV_LANGUAGE = 'shell';

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx', 'mkd']);

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
]);

// Research doc §3.4. `cfg`/`conf` are text (AC-4), `svg` is an image (AC-5).
const LANGUAGE_EXTENSION_TABLE: Readonly<Record<string, readonly string[]>> = {
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

const LANGUAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map(
  Object.entries(LANGUAGE_EXTENSION_TABLE).flatMap(([language, exts]) =>
    exts.map((ext) => [ext, language] as const),
  ),
);

// Plain-text code mode: `bat`/`cmd` are "일반 텍스트" in §3.4, the rest AC-4.
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'log', 'lock', 'csv', 'tsv', 'conf', 'cfg', 'bat', 'cmd',
]);

/** Every language id this table can return, for the language loader. */
export const EDITOR_LANGUAGE_IDS: readonly string[] = [
  ...new Set<string>([
    ...Object.keys(LANGUAGE_EXTENSION_TABLE),
    ENV_LANGUAGE,
    ...[...EXACT_FILE_NAMES.values()].filter((v): v is string => v !== null),
  ]),
];

const NONE: EditorMode = { kind: 'none', language: null };

function baseName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function extensionOf(lowerName: string): string {
  const dot = lowerName.lastIndexOf('.');
  return dot >= 0 ? lowerName.slice(dot + 1) : '';
}

export function resolveEditorMode(name: string): EditorMode {
  const lower = baseName(name).toLowerCase();
  if (lower === '') return NONE;

  const exact = EXACT_FILE_NAMES.get(lower);
  if (exact !== undefined) return { kind: 'code', language: exact };

  if (lower === '.env' || lower.startsWith('.env.')) {
    return { kind: 'code', language: ENV_LANGUAGE };
  }

  const ext = extensionOf(lower);
  if (ext === '') return NONE;
  if (MARKDOWN_EXTENSIONS.has(ext)) return { kind: 'markdown', language: null };
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: 'image', language: null };

  const language = LANGUAGE_EXTENSIONS.get(ext);
  if (language !== undefined) return { kind: 'code', language };

  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'code', language: null };
  return NONE;
}
