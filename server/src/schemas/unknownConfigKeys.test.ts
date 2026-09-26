import assert from 'node:assert/strict';
import test from 'node:test';

import { findUnknownConfigKeys } from './unknownConfigKeys.js';

// #62: a typo'd config key was accepted, dropped and never mentioned. These assertions pair
// every "is reported" case with a "is NOT reported" case, so a reporter that flagged everything
// would fail just as surely as one that flagged nothing.

test('#62 a typo at the top level is reported with its known siblings', () => {
  const found = findUnknownConfigKeys({ serverr: { port: 4242 } });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'serverr');
  assert.ok(found[0].knownSiblings.includes('server'),
    'the report must name the key the operator probably meant');
});

test('#62 a typo inside a loose block is reported — this is the case that was silent', () => {
  // `server` was NOT .strict(), so this used to be dropped without a word.
  const found = findUnknownConfigKeys({ server: { port: 4242, prot: 4243 } });
  assert.deepEqual(found.map(entry => entry.path), ['server.prot']);
});

test('#62 a typo inside an already-strict block is reported by the same walk', () => {
  const found = findUnknownConfigKeys({ resourceLimits: { terminal: { scrollbackLinez: 10 } } });
  assert.deepEqual(found.map(entry => entry.path), ['resourceLimits.terminal.scrollbackLinez']);
});

test('#62 a fully valid config reports nothing', () => {
  const found = findUnknownConfigKeys({
    server: { port: 4242 },
    resourceLimits: { terminal: { scrollbackLines: 1000 } },
    stabilityModes: { headlessQueueMode: 'observe' },
    workspace: { maxWorkspaces: 10 },
    twoFactor: { enabled: false },
  });
  assert.deepEqual(found, [], 'known keys must never be reported');
});

test('#62 the walk descends through optional and defaulted blocks', () => {
  // twoFactor is `.optional()`, workspace is `.optional()`, resourceLimits is defaultObject().
  // If the unwrapping were wrong these would silently report nothing, which is the vacuous
  // pass this whole issue is about.
  assert.deepEqual(
    findUnknownConfigKeys({ twoFactor: { enabledd: true } }).map(e => e.path),
    ['twoFactor.enabledd']);
  assert.deepEqual(
    findUnknownConfigKeys({ workspace: { maxWorkspacez: 3 } }).map(e => e.path),
    ['workspace.maxWorkspacez']);
});
