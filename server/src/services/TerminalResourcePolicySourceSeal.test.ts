// Issue #71: the consumer manifest's sourceHashes were sha256 of WORKING-TREE bytes, and 32 of
// the 35 hashed paths carry no .gitattributes eol setting. git hands out CRLF on one platform
// and LF on another, so the seal moved with no edit -- #25 measured exactly that, confirming one
// previous value was a CRLF digest of the same content. Two developers on different platforms
// invalidate each other's seals forever, and a mismatch throws in the evidence-bundle build
// step, which takes every test command, local build, release build and CI job red for a reason
// that has nothing to do with the code.
//
// Normalising line endings where source text enters the module removes the platform axis
// structurally, rather than asking 32 .gitattributes entries to be maintained correctly forever.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { normaliseSourceLineEndings } from './TerminalResourcePolicyInventory.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const LF = "const a = 1;\nconst b = 2;\n\nexport function c() {\n  return a + b;\n}\n";
const CRLF = LF.replace(/\n/gu, '\r\n');

test('#71 a CRLF checkout and an LF checkout of the same content seal identically', () => {
  assert.notEqual(digest(LF), digest(CRLF), 'the two spellings must differ before normalisation, or this proves nothing');
  assert.equal(
    digest(normaliseSourceLineEndings(CRLF)),
    digest(normaliseSourceLineEndings(LF)),
    'the same content checked out on two platforms must produce one seal',
  );
});

test('#71 normalisation is idempotent and leaves an LF file untouched', () => {
  assert.equal(normaliseSourceLineEndings(LF), LF);
  assert.equal(normaliseSourceLineEndings(normaliseSourceLineEndings(CRLF)), normaliseSourceLineEndings(CRLF));
});

test('#71 a lone CR is content, not a line ending, and survives', () => {
  // Old Mac line endings are not a checkout spelling git produces, and a bare CR inside a string
  // literal is ordinary content. Rewriting those would change what the file means.
  const withBareCr = 'const marker = "progress\rredraw";\n';
  assert.equal(normaliseSourceLineEndings(withBareCr), withBareCr);
});

test('#71 character offsets stop depending on the checkout spelling', () => {
  // The seal is not the only thing that moved: AST evidence digests are built from character
  // offsets, and every preceding CRLF shifts them by one. Normalising at read fixes both.
  const needle = 'export function c';
  assert.equal(
    normaliseSourceLineEndings(CRLF).indexOf(needle),
    normaliseSourceLineEndings(LF).indexOf(needle),
  );
  assert.notEqual(CRLF.indexOf(needle), LF.indexOf(needle),
    'the raw offsets must differ, or this case proves nothing');
});
