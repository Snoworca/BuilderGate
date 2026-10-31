import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from '@codemirror/language';
import { ATOMIC_CODE_LANGUAGES } from './vendor/atomic-editor/code-languages';

// FR-MDE-013 -- language id (from editorMode.ts) -> lazily loaded grammar.
// Matching is editorMode.ts's job alone: the descriptions here carry no
// extensions or filename patterns, and nothing calls LanguageDescription's
// matchFilename. The vendored list is reused read-only by name; ids it lacks
// are filled from @codemirror/legacy-modes, each a lazy chunk.

function legacy(parser: StreamParser<unknown>): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

const VENDOR_NAME_BY_ID: Readonly<Record<string, string>> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  php: 'PHP',
  ruby: 'Ruby',
  swift: 'Swift',
  shell: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  xml: 'XML',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  dockerfile: 'Dockerfile',
  // A markdown document shown as raw source (FR-MDE-023).
  markdown: 'Markdown',
};

const EXTRA_LOADERS: Readonly<Record<string, () => Promise<LanguageSupport>>> = {
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.kotlin)),
  scala: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.scala)),
  csharp: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.csharp)),
  dart: () => import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.dart)),
  objectivec: () =>
    import('@codemirror/legacy-modes/mode/clike').then((m) => legacy(m.objectiveC)),
  scss: () => import('@codemirror/legacy-modes/mode/css').then((m) => legacy(m.sCSS)),
  less: () => import('@codemirror/legacy-modes/mode/css').then((m) => legacy(m.less)),
  sass: () => import('@codemirror/legacy-modes/mode/sass').then((m) => legacy(m.sass)),
  stylus: () => import('@codemirror/legacy-modes/mode/stylus').then((m) => legacy(m.stylus)),
  properties: () =>
    import('@codemirror/legacy-modes/mode/properties').then((m) => legacy(m.properties)),
  powershell: () =>
    import('@codemirror/legacy-modes/mode/powershell').then((m) => legacy(m.powerShell)),
  // No makefile grammar ships in legacy-modes; shell covers its recipes and
  // variable syntax closely enough for highlighting.
  makefile: () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(m.shell)),
  cmake: () => import('@codemirror/legacy-modes/mode/cmake').then((m) => legacy(m.cmake)),
  nginx: () => import('@codemirror/legacy-modes/mode/nginx').then((m) => legacy(m.nginx)),
  diff: () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(m.diff)),
  // FR-MDE-013 AC-10 (#215).
  lua: () => import('@codemirror/legacy-modes/mode/lua').then((m) => legacy(m.lua)),
  perl: () => import('@codemirror/legacy-modes/mode/perl').then((m) => legacy(m.perl)),
  groovy: () => import('@codemirror/legacy-modes/mode/groovy').then((m) => legacy(m.groovy)),
  r: () => import('@codemirror/legacy-modes/mode/r').then((m) => legacy(m.r)),
  haskell: () => import('@codemirror/legacy-modes/mode/haskell').then((m) => legacy(m.haskell)),
  erlang: () => import('@codemirror/legacy-modes/mode/erlang').then((m) => legacy(m.erlang)),
  clojure: () => import('@codemirror/legacy-modes/mode/clojure').then((m) => legacy(m.clojure)),
  julia: () => import('@codemirror/legacy-modes/mode/julia').then((m) => legacy(m.julia)),
  ocaml: () => import('@codemirror/legacy-modes/mode/mllike').then((m) => legacy(m.oCaml)),
  fsharp: () => import('@codemirror/legacy-modes/mode/mllike').then((m) => legacy(m.fSharp)),
  vb: () => import('@codemirror/legacy-modes/mode/vb').then((m) => legacy(m.vb)),
  vbscript: () => import('@codemirror/legacy-modes/mode/vbscript').then((m) => legacy(m.vbScript)),
  tcl: () => import('@codemirror/legacy-modes/mode/tcl').then((m) => legacy(m.tcl)),
  coffeescript: () => import('@codemirror/legacy-modes/mode/coffeescript').then((m) => legacy(m.coffeeScript)),
  pascal: () => import('@codemirror/legacy-modes/mode/pascal').then((m) => legacy(m.pascal)),
  fortran: () => import('@codemirror/legacy-modes/mode/fortran').then((m) => legacy(m.fortran)),
  protobuf: () => import('@codemirror/legacy-modes/mode/protobuf').then((m) => legacy(m.protobuf)),
  tex: () => import('@codemirror/legacy-modes/mode/stex').then((m) => legacy(m.stex)),
  verilog: () => import('@codemirror/legacy-modes/mode/verilog').then((m) => legacy(m.verilog)),
  vhdl: () => import('@codemirror/legacy-modes/mode/vhdl').then((m) => legacy(m.vhdl)),
  elm: () => import('@codemirror/legacy-modes/mode/elm').then((m) => legacy(m.elm)),
  crystal: () => import('@codemirror/legacy-modes/mode/crystal').then((m) => legacy(m.crystal)),
  haxe: () => import('@codemirror/legacy-modes/mode/haxe').then((m) => legacy(m.haxe)),
  pug: () => import('@codemirror/legacy-modes/mode/pug').then((m) => legacy(m.pug)),
  gherkin: () => import('@codemirror/legacy-modes/mode/gherkin').then((m) => legacy(m.gherkin)),
  http: () => import('@codemirror/legacy-modes/mode/http').then((m) => legacy(m.http)),
  jinja2: () => import('@codemirror/legacy-modes/mode/jinja2').then((m) => legacy(m.jinja2)),
  nsis: () => import('@codemirror/legacy-modes/mode/nsis').then((m) => legacy(m.nsis)),
  sparql: () => import('@codemirror/legacy-modes/mode/sparql').then((m) => legacy(m.sparql)),
  turtle: () => import('@codemirror/legacy-modes/mode/turtle').then((m) => legacy(m.turtle)),
  sas: () => import('@codemirror/legacy-modes/mode/sas').then((m) => legacy(m.sas)),
};

const cache = new Map<string, LanguageDescription | null>();

/**
 * The lazily loading description for a language id from resolveEditorMode,
 * or null when the id is null or unknown (plain text).
 */
export function languageDescriptionFor(id: string | null): LanguageDescription | null {
  if (id === null) return null;
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  let description: LanguageDescription | null = null;
  const vendorName = VENDOR_NAME_BY_ID[id];
  if (vendorName !== undefined) {
    description = ATOMIC_CODE_LANGUAGES.find((d) => d.name === vendorName) ?? null;
  }
  const extra = EXTRA_LOADERS[id];
  if (description === null && extra !== undefined) {
    description = LanguageDescription.of({ name: id, load: extra });
  }
  cache.set(id, description);
  return description;
}
