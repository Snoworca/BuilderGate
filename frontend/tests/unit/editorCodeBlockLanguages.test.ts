// FR-MDE-026: fenced code blocks cover nearly every programming language and data format,
// with the cursor outside the block (shiki) and inside it (CodeMirror, or shiki tokens
// where CodeMirror has no parser).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanguageDescription } from '@codemirror/language';
import { bundledLanguages } from 'shiki';

import {
  CODE_BLOCK_LANGUAGES,
  shikiLanguageFor,
} from '../../src/editor/core/code-block-languages.ts';
import { tokenizeCode } from '../../src/editor/core/code-highlight.ts';

/** Fence names people actually write: languages, their usual short forms, and data formats. */
const FENCE_NAMES = (
  'java python py js javascript ts typescript tsx jsx c cpp c++ h hpp cs csharp c# go golang rust rs '
  + 'kotlin kt kts swift ruby rb php scala dart lua perl pl r sh bash zsh shell console powershell ps1 '
  + 'pwsh bat cmd batch sql mysql postgresql plsql html htm xml svg css scss sass less json jsonc json5 '
  + 'jsonl yaml yml toml ini cfg conf properties env dockerfile docker makefile make cmake diff patch '
  + 'markdown md haskell hs elixir ex exs erlang erl clojure clj fsharp fs ocaml ml groovy gradle vb '
  + 'vbnet vbscript vue svelte astro graphql gql proto protobuf nginx apache latex tex bibtex csv tsv '
  + 'matlab octave julia jl nim zig v solidity sol fortran f90 cobol pascal delphi ada asm nasm x86asm '
  + 'objectivec objc objective-c verilog vhdl systemverilog tcl elm purescript racket scheme lisp '
  + 'commonlisp elisp crystal d haxe hcl terraform tf nix prisma razor cshtml jinja twig liquid '
  + 'handlebars hbs mustache pug haml http regex log'
).split(' ');

test('FR-MDE-026 AC-1: every common fence name is highlighted with the cursor outside the block', () => {
  const shiki = new Set(Object.keys(bundledLanguages));
  const missing = FENCE_NAMES.filter((name) => !shiki.has(shikiLanguageFor(name)));
  assert.deepEqual(missing, []);
});

test('FR-MDE-026 AC-2: short forms reach the language CodeMirror parses', () => {
  const pairs: Array<[string, string]> = [
    ['golang', 'Go'], ['h', 'C'], ['hpp', 'C++'], ['kt', 'Kotlin'], ['pl', 'Perl'], ['ps1', 'PowerShell'],
    ['pwsh', 'PowerShell'], ['svg', 'XML'], ['patch', 'diff'], ['hs', 'Haskell'], ['erl', 'Erlang'],
    ['clj', 'Clojure'], ['fs', 'F#'], ['ml', 'OCaml'], ['gradle', 'Groovy'], ['proto', 'ProtoBuf'],
    ['jl', 'Julia'], ['docker', 'Dockerfile'], ['objectivec', 'Objective-C'],
    ['json', 'JSON'], ['xml', 'XML'], ['yaml', 'YAML'], ['toml', 'TOML'], ['csharp', 'C#'],
  ];
  for (const [fence, expected] of pairs) {
    const found = LanguageDescription.matchLanguageName(CODE_BLOCK_LANGUAGES, fence, true);
    assert.equal(found?.name, expected, fence);
  }
});

test('FR-MDE-026 AC-3: a language CodeMirror cannot parse is still tokenized with colours', async () => {
  for (const [fence, code] of [['elixir', 'defmodule A do\n  def f(x), do: x + 1\nend'], ['graphql', 'query { user(id: 1) { name } }'], ['zig', 'const x: i32 = 42;']] as const) {
    assert.equal(LanguageDescription.matchLanguageName(CODE_BLOCK_LANGUAGES, fence, true), null, `${fence} has no CodeMirror parser`);
    const lines = await tokenizeCode(code, fence);
    assert.ok(lines, `${fence} tokenized`);
    assert.equal(lines.length, code.split('\n').length, `${fence}: one token line per source line`);
    assert.equal(lines.map((line) => line.map((t) => t.content).join('')).join('\n'), code, `${fence}: tokens cover the source exactly`);
    const colours = new Set(lines.flat().map((t) => (t.htmlStyle as Record<string, string> | undefined)?.color));
    assert.ok(colours.size > 2, `${fence}: ${colours.size} colours`);
  }
});

test('FR-MDE-026: an unknown language tokenizes to null and does not throw', async () => {
  assert.equal(await tokenizeCode('x', 'no-such-language'), null);
});
