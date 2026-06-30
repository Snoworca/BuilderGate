import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ensureTerminalRef,
  pruneTerminalRefsMap,
  type TerminalRuntimeRefsMap,
} from '../../src/components/Terminal/terminalRuntimeRefs.ts';

test('ensureTerminalRef creates and reuses terminal runtime refs', () => {
  const refs: TerminalRuntimeRefsMap = new Map();

  const first = ensureTerminalRef(refs, 'tab-1');
  const second = ensureTerminalRef(refs, 'tab-1');

  assert.equal(first, second);
  assert.equal(refs.size, 1);
  assert.deepEqual(first, { current: null });
});

test('pruneTerminalRefsMap removes refs outside resident tab ids', () => {
  const refs: TerminalRuntimeRefsMap = new Map();
  ensureTerminalRef(refs, 'visible');
  ensureTerminalRef(refs, 'resident-hidden');
  ensureTerminalRef(refs, 'evicted');

  const removed = pruneTerminalRefsMap(refs, new Set(['visible', 'resident-hidden']));

  assert.deepEqual(removed, ['evicted']);
  assert.equal(refs.has('visible'), true);
  assert.equal(refs.has('resident-hidden'), true);
  assert.equal(refs.has('evicted'), false);
});
