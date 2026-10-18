// SEC-MDE-002 AC-6 (#141): the drafts of all HTML view tokens share one memory budget.
// Run: cwd=server/, npx tsx --test src/services/HtmlViewTokenStore.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_VIEW_DRAFT_BUDGET_BYTES, HtmlViewTokenStore } from './HtmlViewTokenStore.js';

const target = (n: number) => ({ sessionId: 's', userId: 'u', root: '/r', filePath: `p${n}.html` });

test('SEC-MDE-002 AC-6: over the total draft budget the least recently used tokens lose their drafts first, the newest stays', () => {
  assert.equal(HTML_VIEW_DRAFT_BUDGET_BYTES, 64 * 1024 * 1024);
  const clock = { now: 1000 };
  const store = new HtmlViewTokenStore({ now: () => clock.now, draftBudgetBytes: 100 });
  const a = store.issue(target(1));
  const b = store.issue(target(2));
  const c = store.issue(target(3));
  clock.now += 1;
  assert.equal(store.setDraft(a, 's', 'u', Buffer.alloc(40)), 1);
  clock.now += 1;
  assert.equal(store.setDraft(b, 's', 'u', Buffer.alloc(40)), 1);
  clock.now += 1;
  store.use(a); // a is now more recently used than b
  clock.now += 1;
  store.setDraft(c, 's', 'u', Buffer.alloc(40)); // 120 > 100: b goes
  assert.notEqual(store.draft(a), null);
  assert.equal(store.draft(b), null, 'the least recently used draft is dropped');
  assert.notEqual(store.draft(c), null, 'the newest draft stays');
  assert.notEqual(store.use(b), null, 'the token itself stays; its page falls back to the file');

  // One draft larger than the budget still stays as the newest; every other draft goes.
  clock.now += 1;
  store.setDraft(b, 's', 'u', Buffer.alloc(150));
  assert.notEqual(store.draft(b), null);
  assert.equal(store.draft(a), null);
  assert.equal(store.draft(c), null);

  // Replacing a draft counts only the new size.
  clock.now += 1;
  store.setDraft(b, 's', 'u', Buffer.alloc(10));
  store.setDraft(a, 's', 'u', Buffer.alloc(80));
  assert.notEqual(store.draft(a), null);
  assert.notEqual(store.draft(b), null, '10 + 80 fits');
});
