import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The Workspace-count and total-session caps were removed by user decision. What remains is
// the per-Workspace tab limit, and the browser must read it from the server, not a literal.

const appSource = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const serviceSource = readFileSync(
  new URL('../../../server/src/services/WorkspaceService.ts', import.meta.url), 'utf8');

test('App.tsx forwards no removed Workspace/session cap', () => {
  assert.doesNotMatch(appSource, /maxWorkspaces|maxSessions|maxTotalSessions|totalSessionCount/u);
});

test('App.tsx binds maxTabs to the served limit rather than a literal', () => {
  const bound = appSource.match(/maxTabs=\{wm\.limits\.maxTabsPerWorkspace\}/gu) ?? [];
  assert.ok(bound.length >= 1, 'maxTabs must be bound to wm.limits.maxTabsPerWorkspace');
  assert.deepEqual(appSource.match(/maxTabs=\{\s*\d+\s*\}/gu) ?? [], [], 'maxTabs must not be a numeric literal');
});

test('the server publishes only the per-Workspace tab limit', () => {
  assert.doesNotMatch(serviceSource, /maxWorkspaces|maxTotalSessions/u);
  assert.match(serviceSource, /maxTabsPerWorkspace/u);
});
