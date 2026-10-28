// FR-GIT-013: the commit list's subject wrap option -- off by default, kept in this browser,
// shared by every Git window -- and how the window and the list use it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSubjectWrapStore, SUBJECT_WRAP_KEY } from '../../src/components/Git/gitSubjectWrap.ts';

const read = (rel: string) => readFileSync(new URL(`../../src/components/Git/${rel}`, import.meta.url), 'utf8');

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

// @req FR-GIT-013
test('FR-GIT-013 AC-1: off by default, remembered, and every subscriber hears a change', () => {
  const storage = memoryStorage();
  const store = createSubjectWrapStore(() => storage);
  assert.equal(store.get(), false);
  let heard = 0;
  const off = store.subscribe(() => { heard += 1; });
  store.set(true);
  assert.equal(store.get(), true);
  assert.equal(storage.data.get(SUBJECT_WRAP_KEY), '1');
  assert.equal(heard, 1);
  off();
  store.set(false);
  assert.equal(heard, 1, 'an unsubscribed listener hears nothing');
  assert.equal(createSubjectWrapStore(() => memoryStorage({ [SUBJECT_WRAP_KEY]: '1' })).get(), true, 'read back on load');
});

// @req FR-GIT-013
test('FR-GIT-013 AC-1: without storage (private mode) it still works for the page', () => {
  const store = createSubjectWrapStore(() => null);
  assert.equal(store.get(), false);
  store.set(true);
  assert.equal(store.get(), true);
});

// @req FR-GIT-013
test('FR-GIT-013 AC-1/AC-2/AC-3: the tools row toggles it, the list wraps and stretches each graph', () => {
  const win = read('GitWindow.tsx');
  assert.match(win, /data-opt="wrap"/);
  assert.match(win, /t\('git\.window\.wrapSubjects'\)/);
  assert.match(win, /wrapSubjects=\{wrapSubjects\}/);
  const list = read('GitGraphList.tsx');
  assert.match(list, /data-wrap=\{wrapSubjects \? '' : undefined\}/);
  assert.match(list, /<RowGraph [^>]*stretch=\{wrapSubjects\}/);
  const css = read('gitViewer.css');
  assert.match(css, /\.git-graph-list\[data-wrap\] \.git-row \{[^}]*height:\s*auto/);
  assert.match(css, /\.git-graph-list\[data-wrap\] \.git-row-text \{[^}]*white-space:\s*normal/);
});
