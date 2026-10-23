// FR-GIT-004, FR-GIT-009: the Git window's banners, rendered under jsdom (test:unit:git-viewer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();
const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
const { installCatalog } = await import('../../src/i18n/i18n.ts');
installCatalog('en', en);
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { GitWindowBanner, pickGitBanner } = await import('../../src/components/Git/GitWindowBanner.tsx');

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { container, cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

// @req FR-GIT-004
test('FR-GIT-004/009: which banner shows: ended, moved, vanished, then compare', () => {
  const base = { ended: false, moved: null, vanished: null, compare: null };
  assert.equal(pickGitBanner(base), null);
  assert.equal(pickGitBanner({ ...base, compare: { base: 'origin/main', mergeBase: 'abc1234', commits: 3, fetchedAt: null } })?.kind, 'compare');
  assert.equal(pickGitBanner({ ...base, vanished: { sha: 'deadbeef', subject: 's' }, compare: { base: 'b', mergeBase: 'm', commits: 0, fetchedAt: null } })?.kind, 'vanished');
  assert.equal(pickGitBanner({ ...base, moved: { path: '/home/x', repo: true }, vanished: { sha: 'd', subject: 's' } })?.kind, 'moved');
  assert.equal(pickGitBanner({ ...base, ended: true, moved: { path: '/x', repo: false } })?.kind, 'ended');
});

// @req FR-GIT-004, FR-GIT-009
test('FR-GIT-004/009: banner texts and their buttons', async () => {
  const calls: string[] = [];
  const handlers = { onFollow: () => calls.push('follow'), onStay: () => calls.push('stay'), onLatestHead: () => calls.push('head') };
  const moved = await render(React.createElement(GitWindowBanner, { banner: { kind: 'moved', path: '/home/beom/web', repo: true }, ...handlers }));
  assert.match(moved.container.textContent ?? '', /moved to another folder · \/home\/beom\/web/);
  const [follow, stay] = [...moved.container.querySelectorAll('button')];
  follow.click(); stay.click();
  await moved.cleanup();
  const outside = await render(React.createElement(GitWindowBanner, { banner: { kind: 'moved', path: '/tmp', repo: false }, ...handlers }));
  assert.equal(outside.container.querySelectorAll('button').length, 1, 'no "follow" outside a repository');
  await outside.cleanup();
  const vanished = await render(React.createElement(GitWindowBanner, { banner: { kind: 'vanished', sha: 'deadbeefcafe', subject: 's' }, ...handlers }));
  assert.match(vanished.container.textContent ?? '', /deadbee/);
  vanished.container.querySelector('button')!.click();
  await vanished.cleanup();
  const ended = await render(React.createElement(GitWindowBanner, { banner: { kind: 'ended' }, ...handlers }));
  assert.match(ended.container.textContent ?? '', /session ended/i);
  assert.equal(ended.container.querySelector('[role="status"]') !== null, true);
  await ended.cleanup();
  const cmp = await render(React.createElement(GitWindowBanner, { banner: { kind: 'compare', base: 'origin/main', mergeBase: 'abc1234def', commits: 3, fetchedAt: null }, ...handlers }));
  assert.match(cmp.container.textContent ?? '', /Compare: origin\/main · fork point abc1234 · 3 commits/);
  await cmp.cleanup();
  assert.deepEqual(calls, ['follow', 'stay', 'head']);
});
