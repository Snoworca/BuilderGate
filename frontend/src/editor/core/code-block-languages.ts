// Which languages a fenced code block can be highlighted in (`FR-MDE-026`).
//
// Two engines highlight a fence: shiki while the cursor is outside it (≈330 bundled
// grammars), CodeMirror while the cursor is inside it. This module is the one place that
// decides how a fence name maps to each:
// - CodeMirror gets the vendor's curated list first (its entries carry options such as JSX),
//   then `@codemirror/language-data` (≈140 languages, each loaded only when used), then the
//   short forms people write that neither list knows (`golang`, `ps1`, `svg`, …).
// - shiki gets the same short forms mapped to its own ids.
// A language CodeMirror has no parser for at all is coloured from shiki tokens instead
// (`code-edit-highlight.ts`), so editing covers what viewing covers.

import { LanguageDescription } from '@codemirror/language';
import { languages as languageData } from '@codemirror/language-data';

import { ATOMIC_CODE_LANGUAGES } from '../vendor/atomic-editor/code-languages.ts';

/** Fence name → CodeMirror language name, for names no list carries. */
const CODEMIRROR_ALIASES: Record<string, string> = {
  golang: 'Go',
  h: 'C',
  hpp: 'C++',
  hh: 'C++',
  cc: 'C++',
  kt: 'Kotlin',
  kts: 'Kotlin',
  pl: 'Perl',
  pm: 'Perl',
  console: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  pwsh: 'PowerShell',
  svg: 'XML',
  xsd: 'XML',
  xsl: 'XML',
  plist: 'XML',
  cfg: 'Properties files',
  conf: 'Properties files',
  env: 'Properties files',
  docker: 'Dockerfile',
  patch: 'diff',
  hs: 'Haskell',
  erl: 'Erlang',
  clj: 'Clojure',
  fs: 'F#',
  fsharp: 'F#',
  ml: 'OCaml',
  gradle: 'Groovy',
  vb: 'VB.NET',
  vbnet: 'VB.NET',
  proto: 'ProtoBuf',
  matlab: 'Octave',
  jl: 'Julia',
  f90: 'Fortran',
  delphi: 'Pascal',
  asm: 'Gas',
  assembly: 'Gas',
  nasm: 'Gas',
  x86asm: 'Gas',
  objectivec: 'Objective-C',
  racket: 'Scheme',
};

/** Fence name → shiki language id, for names shiki does not bundle under that spelling. */
const SHIKI_ALIASES: Record<string, string> = {
  h: 'c',
  hpp: 'cpp',
  hh: 'cpp',
  cc: 'cpp',
  golang: 'go',
  pl: 'perl',
  pm: 'perl',
  pwsh: 'powershell',
  psm1: 'powershell',
  mysql: 'sql',
  postgresql: 'sql',
  htm: 'html',
  svg: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  plist: 'xml',
  cfg: 'ini',
  conf: 'ini',
  env: 'dotenv',
  patch: 'diff',
  ex: 'elixir',
  exs: 'elixir',
  ml: 'ocaml',
  gradle: 'groovy',
  vbnet: 'vb',
  vbscript: 'vb',
  octave: 'matlab',
  sol: 'solidity',
  fortran: 'fortran-free-form',
  f90: 'fortran-free-form',
  delphi: 'pascal',
  assembly: 'asm',
  nasm: 'asm',
  x86asm: 'asm',
  objectivec: 'objective-c',
  systemverilog: 'system-verilog',
  commonlisp: 'common-lisp',
  cshtml: 'razor',
  mustache: 'handlebars',
  rest: 'http',
};

function withAliases(base: readonly LanguageDescription[]): LanguageDescription[] {
  const extra: LanguageDescription[] = [];
  for (const [alias, name] of Object.entries(CODEMIRROR_ALIASES)) {
    const target = base.find((language) => language.name === name);
    if (!target) continue;
    extra.push(LanguageDescription.of({ name: target.name, alias: [alias], load: () => target.load() }));
  }
  return [...base, ...extra];
}

/** Every language CodeMirror can highlight inside a fence, in match order. */
export const CODE_BLOCK_LANGUAGES: readonly LanguageDescription[] = withAliases([
  ...ATOMIC_CODE_LANGUAGES,
  ...languageData.filter((language) => !ATOMIC_CODE_LANGUAGES.some((own) => own.name === language.name)),
]);

/** The fence's language as shiki names it. */
export function shikiLanguageFor(fence: string): string {
  const name = fence.trim().toLowerCase();
  return SHIKI_ALIASES[name] ?? name;
}

/** Whether CodeMirror parses this fence's language (otherwise shiki tokens colour it while editing). */
export function codeMirrorParses(fence: string): boolean {
  return LanguageDescription.matchLanguageName(CODE_BLOCK_LANGUAGES, fence.trim(), true) !== null;
}
