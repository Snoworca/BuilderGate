import assert from 'node:assert/strict';
import { test } from 'node:test';

import { workspacesCreatedDuringRun } from '../e2e/workspaceLeakGuard.ts';

/**
 * Workspaces are a bounded resource — `maxLiveWorkspaces` defaults to 10 — and
 * the e2e specs create them under a dozen different naming schemes without
 * removing them. Measured 2026-08-30, all ten slots were leftovers from earlier
 * runs, and `POST /api/workspaces` answered 409 and then 500: unrelated specs
 * failed in a way that reads exactly like a product defect.
 *
 * Matching names would need every scheme enumerated and would still delete a
 * workspace that merely looked like a test one. The set difference does not: a
 * workspace that existed before the run is never a candidate, whatever it is
 * called.
 */

const before = [
  { id: 'w-keep-1', name: 'Main' },
  { id: 'w-keep-2', name: 'E2E-looking-but-preexisting' },
];

test('only workspaces that appeared during the run are returned', () => {
  const after = [
    ...before,
    { id: 'w-new-1', name: 'AuthoritySource-1788097781999' },
    { id: 'w-new-2', name: 'anything at all' },
  ];

  assert.deepEqual(
    workspacesCreatedDuringRun(before, after).map(w => w.id),
    ['w-new-1', 'w-new-2'],
  );
});

test('a workspace that existed before the run is never a candidate', () => {
  const after = [{ id: 'w-keep-2', name: 'E2E-looking-but-preexisting' }];
  assert.deepEqual(workspacesCreatedDuringRun(before, after), []);
});

test('an unchanged instance yields nothing to delete', () => {
  assert.deepEqual(workspacesCreatedDuringRun(before, before), []);
});

test('an empty baseline still protects nothing that was not created', () => {
  const after = [{ id: 'w-new', name: 'Created' }];
  assert.deepEqual(workspacesCreatedDuringRun([], after).map(w => w.id), ['w-new']);
});

test('identity is the id, not the name', () => {
  // Two runs can pick the same name; only the id says whether it is the same
  // workspace.
  const after = [{ id: 'w-new', name: 'Main' }];
  assert.deepEqual(
    workspacesCreatedDuringRun(before, after).map(w => w.id),
    ['w-new'],
    'a recreated workspace sharing a name was mistaken for the original',
  );
});
