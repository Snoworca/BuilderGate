import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RETAINED_STATE_DIGEST_VERSION,
  buildRetainedStateDigestCanonicalInput,
  computeRetainedStateDigest,
} from './retainedStateDigest.js';

// The fields that stay put across every golden vector.
const FIXED = {
  dataDigest: 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  cols: 120,
  rows: 40,
  modes: { applicationCursorKeysMode: true, bracketedPasteMode: false },
  activeBuffer: 'normal' as const,
  cursor: { x: 7, y: 11 },
  savedCursor: { x: 3, y: 5 },
};

function withTail(parserTailSource: string) {
  return { ...FIXED, parserTailSource };
}

// IR-BGSTAB-002 AC-3. These hex literals were assembled by hand from the
// contract wording, not by calling this module. A server and a browser that are
// wrong in the same way would agree with each other, so the expected value has
// to come from a third place.
const GOLDEN: ReadonlyArray<readonly [string, string, string]> = [
  ['empty', '', 'sha256:18dcd5f93397585893f1ec43aa6946d6d0b8137db3b3e3d02af6fa1204c385ed'],
  ['ascii', 'abc', 'sha256:5e33ba90597462e2c9ceca0ec91b812f88234b4dc622e7a699c1f9e2ab4e57b3'],
  ['incomplete-ansi', '\u001b[', 'sha256:f64310890ef238b4c2c64eaf23aa08b3eb566c4e762a25e9afa80e2fb9473a74'],
  ['cjk-wide', '한글', 'sha256:9108477e590c1004b093c39a3b8f59be41cf2efe240cd3d23e91292421e46728'],
  ['combining', 'é', 'sha256:6cabf5aacbc260346fe2ff426f183b51f51ae5c7203a9dd3a95d07b50bab720f'],
  ['zwj-emoji', '👩‍💻', 'sha256:d8ae76c81757643ee99185b599cb10e8b82b212626d6fecf6580c77d6c33d83d'],
  ['four-byte-utf8', '🙂', 'sha256:04f870fc8fae33c63012881cc8199892a4bfb1ed611a6c13a7ee0232b3d050e3'],
];

test('IR-BGSTAB-002 AC-3 matches the hand-assembled golden vectors', () => {
  assert.equal(GOLDEN.length >= 7, true, 'AC-3 requires at least seven fixed inputs');
  for (const [name, tail, expected] of GOLDEN) {
    assert.equal(computeRetainedStateDigest(withTail(tail)), expected, name);
  }
  // The seven inputs must actually differ, or the table would prove nothing.
  assert.equal(new Set(GOLDEN.map(([, , digest]) => digest)).size, GOLDEN.length);
});

test('IR-BGSTAB-002 AC-1 derives the parser tail from source bytes, never from base64', () => {
  // 'abc' encodes to 'YWJj'. The previous contract fed the base64 text into the
  // digest, so treating the two as the same input is exactly the defect.
  const fromSource = computeRetainedStateDigest(withTail('abc'));
  const fromBase64Text = computeRetainedStateDigest(withTail('YWJj'));
  assert.notEqual(fromSource, fromBase64Text);

  // Distinct source bytes must stay distinct.
  assert.notEqual(computeRetainedStateDigest(withTail('a')), computeRetainedStateDigest(withTail('b')));
  // Equal source bytes must agree regardless of how they were spelled in the caller.
  assert.equal(computeRetainedStateDigest(withTail('\u001b[')), computeRetainedStateDigest(withTail('\x1b[')));
});

test('IR-BGSTAB-002 AC-1 keeps every transport encoding out of the canonical builder', () => {
  const source = readFileSync(new URL('./retainedStateDigest.ts', import.meta.url), 'utf8');
  assert.equal(source.length > 0, true, 'the module source must be readable for this contract test');
  // Comments explain why the encoding is excluded, so they name it. Strip them and
  // read the code alone, which is what the criterion constrains.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('createHash'), true, 'comment stripping must not empty the module');
  for (const forbidden of ['base64', 'toString(', 'encodeCheckpointPayload']) {
    assert.equal(
      code.includes(forbidden),
      false,
      `the canonical builder must not reach a transport encoding: ${forbidden}`,
    );
  }
});

test('IR-BGSTAB-002 AC-5 fixes the canonical field set, order, and cursor key set', () => {
  const canonical = buildRetainedStateDigestCanonicalInput(withTail('abc'));
  assert.deepEqual(Object.keys(canonical), [
    'version',
    'dataDigest',
    'parserTailDigest',
    'cols',
    'rows',
    'modes',
    'activeBuffer',
    'cursor',
    'savedCursor',
  ]);
  assert.equal(canonical.version, RETAINED_STATE_DIGEST_VERSION);
  assert.equal(RETAINED_STATE_DIGEST_VERSION, 2);
  assert.deepEqual(Object.keys(canonical.cursor), ['x', 'y']);
  assert.deepEqual(Object.keys(canonical.savedCursor ?? {}), ['x', 'y']);

  // A caller that hands over a richer cursor must not widen the canonical input.
  const widened = buildRetainedStateDigestCanonicalInput({
    ...withTail('abc'),
    cursor: { x: 7, y: 11, buffer: 'normal' } as unknown as { x: number; y: number },
  });
  assert.deepEqual(Object.keys(widened.cursor), ['x', 'y']);
  assert.equal(
    computeRetainedStateDigest({
      ...withTail('abc'),
      cursor: { x: 7, y: 11, buffer: 'normal' } as unknown as { x: number; y: number },
    }),
    computeRetainedStateDigest(withTail('abc')),
  );
});

test('IR-BGSTAB-002 AC-5 carries a null saved cursor without inventing keys', () => {
  const canonical = buildRetainedStateDigestCanonicalInput({ ...withTail('abc'), savedCursor: null });
  assert.equal(canonical.savedCursor, null);
  assert.notEqual(
    computeRetainedStateDigest({ ...withTail('abc'), savedCursor: null }),
    computeRetainedStateDigest(withTail('abc')),
  );
});
