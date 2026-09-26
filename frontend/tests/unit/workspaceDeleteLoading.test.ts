import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// FR-UIDS-006 — the delete confirmation shows a loading state until the server
// answers; the workspace leaves the list as the dialog closes. Supersedes
// PERF-BGSTAB-015 AC-2/AC-3 (optimistic removal and rollback), whose checks
// used to live in this file.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} not found after ${start}`);
  return source.slice(from, to);
}

test('FR-UIDS-006 AC-2: deleteWorkspace changes nothing on screen until the server answers', () => {
  const body = stripComments(sliceBetween(
    read('../../src/hooks/useWorkspaceManager.ts'),
    'const deleteWorkspace = useCallback',
    'const reorderWorkspaces = useCallback',
  ));
  const apiAt = body.indexOf('await workspaceApi.delete(id)');
  const holdAt = body.indexOf('await options?.holdUntil');
  assert.notEqual(apiAt, -1);
  assert.ok(holdAt > apiAt, 'the minimum loading time is waited out after the server answers');
  for (const setter of ['setWorkspaces(', 'setTabs(', 'setGridLayouts(']) {
    const at = body.indexOf(setter);
    assert.ok(at > holdAt, `${setter} runs only after the server answered and the loading time passed`);
  }
  const removedAt = body.indexOf('options?.onRemoved?.()');
  assert.ok(removedAt > body.indexOf('setGridLayouts('), 'the dialog closes in the same block as the removal');
  assert.match(body, /isWorkspaceAlreadyDeletedError\(/, 'a workspace already gone counts as deleted');
  assert.match(body, /releaseMosaicLayoutSaveSuppression\(id\)[\s\S]*throw /, 'a failure is handed to the dialog');
  assert.doesNotMatch(body, /restoreRemoved|snapshotWorkspaceRemoval|setError\(/, 'nothing was removed, so nothing is restored');
  assert.equal(existsSync(new URL('../../src/hooks/workspaceRemoval.ts', import.meta.url)), false);
});

test('FR-UIDS-006 AC-1/AC-4: the confirm handler shows the loading state first and guards a second press', () => {
  const app = read('../../src/App.tsx');
  const body = stripComments(sliceBetween(app, 'const handleConfirmDeleteWorkspace = useCallback', '}, []);'));
  const startAt = body.indexOf('startWorkspaceDelete(');
  const busyAt = body.indexOf('setWorkspaceDelete(next)');
  const deleteAt = body.indexOf('deleteWorkspace(');
  assert.ok(startAt !== -1 && busyAt > startAt && deleteAt > busyAt, 'the loading state is set before the delete starts');
  assert.match(body, /workspaceDeleteInFlightRef\.current/, 'a press in the same frame is refused');
  assert.match(body, /holdUntil:/);
  assert.match(body, /onRemoved:\s*\(\)\s*=>\s*setWorkspaceDelete\(null\)/, 'the dialog closes with the removal');
  assert.match(body, /failWorkspaceDelete\(/);
  assert.doesNotMatch(body.slice(0, deleteAt), /setWorkspaceDelete\(null\)/, 'the dialog is not closed before the server answers');
  assert.match(app, /onCancel=\{[^}]*canDismissWorkspaceDelete\(/, 'cancel is ignored while deleting');
});

test('FR-UIDS-006 AC-7: an empty workspace that fails to delete opens the dialog in its error state', () => {
  const body = stripComments(sliceBetween(read('../../src/App.tsx'), 'const handleDeleteWorkspace = useCallback', '}, []);'));
  assert.match(body, /failWorkspaceDelete\(openWorkspaceDelete\(id, 0\)/);
});

test('FR-UIDS-006 AC-1/AC-6: ConfirmModal is an alert dialog with a busy state that keeps focus', () => {
  const source = stripComments(read('../../src/components/Modal/ConfirmModal.tsx'));
  for (const attribute of ['role="alertdialog"', 'aria-modal="true"', 'aria-labelledby=', 'aria-describedby=', 'aria-live="polite"']) {
    assert.ok(source.includes(attribute), `ConfirmModal carries ${attribute}`);
  }
  assert.match(source, /aria-disabled=\{busy/, 'the busy button is aria-disabled');
  assert.doesNotMatch(source, /className=\{`btn-submit[^>]*(?<!aria-)disabled=\{busy/, 'the busy button is not disabled, which would drop focus');
  assert.match(source, /<BusyLabel/);
  assert.match(source, /spinnerTone="on-fill"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /ui-inline-alert/);
  assert.match(source, /hideConfirm/);
  assert.match(source, /initialFocus/);
  assert.match(source, /Escape[\s\S]*busy/, 'Esc is ignored while busy');
});

test('FR-UIDS-006 AC-6: the shared busy label, on-fill spinner and inline alert exist', () => {
  assert.match(read('../../src/components/ui/index.ts'), /\bBusyLabel\b/);
  assert.match(read('../../src/components/ui/ProgressBar.tsx'), /on-fill/);
  const css = read('../../src/components/ui/ui.css');
  for (const selector of ['.ui-spinner-on-fill', '.ui-busy-label', '.ui-inline-alert']) {
    assert.ok(css.includes(selector), `ui.css defines ${selector}`);
  }
  assert.match(read('./uiDesignSystem.test.ts'), /'components\/ui\/BusyLabel\.tsx'/, 'BusyLabel is under the design-system guard');
});
