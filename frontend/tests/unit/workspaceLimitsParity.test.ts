import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// #66: App.tsx hardcoded maxSessions={32} while the server read workspace.maxTotalSessions
// from config and enforced it. Four of the five limit props read server values; this one did not.
//
// The assertions below are written so that re-introducing a literal fails, and so that a
// pass cannot be bought by deleting the prop: the prop must be PRESENT and must be bound.

const appSource = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const serviceSource = readFileSync(
  new URL('../../../server/src/services/WorkspaceService.ts', import.meta.url), 'utf8');

test('#66 App.tsx binds maxSessions to the served limit rather than a literal', () => {
  const bound = appSource.match(/maxSessions=\{wm\.limits\.maxTotalSessions\}/gu) ?? [];
  assert.equal(bound.length, 1, 'maxSessions must be bound to wm.limits.maxTotalSessions exactly once');

  const literal = appSource.match(/maxSessions=\{\s*\d+\s*\}/gu) ?? [];
  assert.deepEqual(literal, [], 'maxSessions must not be a numeric literal');
});

test('#66 the server actually publishes the limit the browser now reads', () => {
  // Without this, the binding above could read undefined and render nothing, which looks
  // like a fix and is a different defect.
  assert.match(serviceSource, /maxTotalSessions: this\.config\.maxTotalSessions/u,
    'getLimits must publish maxTotalSessions');
});
