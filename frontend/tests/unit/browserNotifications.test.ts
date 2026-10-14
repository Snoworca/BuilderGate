import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createNotificationCenter,
  decideNotificationPresentation,
  parseNotificationPayload,
  readNotificationPermission,
  titleWithUnseenCount,
} from '../../src/utils/browserNotifications.ts';
import type { BrowserNotificationPayload } from '../../src/utils/browserNotifications.ts';

// FR-MCP-012 — how a page shows a notification sent by buildergate.notify.

const payload: BrowserNotificationPayload = {
  id: 'notify_1', title: 'Build done', body: 'ok', level: 'success', at: '2026-10-15T00:00:00Z',
  from: { alias: 'worker', sessionKey: 'k-1', workspaceId: 'ws-1', tabId: 'tab-1' },
};

test('FR-MCP-012 AC-1: a server payload is parsed, and a malformed one is ignored', () => {
  assert.deepEqual(parseNotificationPayload(payload), payload);
  assert.deepEqual(parseNotificationPayload({ ...payload, from: null, level: 'shout' })?.level, 'info');
  assert.equal(parseNotificationPayload({ ...payload, from: null })?.from, null);
  assert.equal(parseNotificationPayload({ title: 'no id' }), null);
  assert.equal(parseNotificationPayload(null), null);
});

test('FR-MCP-012 AC-4/AC-5: a hidden page with permission uses the system notification, otherwise the page shows it', () => {
  assert.equal(decideNotificationPresentation({ inView: false, permission: 'granted' }), 'system');
  assert.equal(decideNotificationPresentation({ inView: true, permission: 'granted' }), 'in-page');
  for (const permission of ['default', 'denied', 'unavailable'] as const) {
    assert.equal(decideNotificationPresentation({ inView: false, permission }), 'in-page', permission);
  }
});

test('FR-MCP-012 AC-6: permission reads unavailable without the API or a secure context', () => {
  assert.equal(readNotificationPermission({ secure: true, api: { permission: 'granted' } }), 'granted');
  assert.equal(readNotificationPermission({ secure: true, api: { permission: 'denied' } }), 'denied');
  assert.equal(readNotificationPermission({ secure: true, api: { permission: 'default' } }), 'default');
  assert.equal(readNotificationPermission({ secure: true, api: undefined }), 'unavailable');
  assert.equal(readNotificationPermission({ secure: false, api: { permission: 'granted' } }), 'unavailable');
});

test('FR-MCP-012 AC-5: the tab title carries the unseen count', () => {
  assert.equal(titleWithUnseenCount('BuilderGate', 0), 'BuilderGate');
  assert.equal(titleWithUnseenCount('BuilderGate', 3), '(3) BuilderGate');
});

test('FR-MCP-012 AC-5: in-page notifications stay until dismissed, duplicates are dropped, and seen clears the count', () => {
  const center = createNotificationCenter();
  const seen: number[] = [];
  const stop = center.subscribe(() => seen.push(center.list().length));
  center.push(payload, { unseen: true });
  center.push(payload, { unseen: true });
  center.push({ ...payload, id: 'notify_2' }, { unseen: false });
  assert.deepEqual(center.list().map(n => n.id), ['notify_2', 'notify_1'], 'newest first, one per id');
  assert.equal(center.unseenCount(), 1);
  center.markSeen();
  assert.equal(center.unseenCount(), 0);
  assert.equal(center.list().length, 2, 'seen does not dismiss');
  center.dismiss('notify_1');
  assert.deepEqual(center.list().map(n => n.id), ['notify_2']);
  stop();
  center.dismiss('notify_2');
  assert.deepEqual(seen, [1, 2, 2, 1], 'listeners hear each change until they stop');
});

test('FR-MCP-012 AC-5: the page keeps at most 5 notifications', () => {
  const center = createNotificationCenter();
  for (let i = 0; i < 8; i += 1) center.push({ ...payload, id: `n${i}` }, { unseen: false });
  assert.deepEqual(center.list().map(n => n.id), ['n7', 'n6', 'n5', 'n4', 'n3']);
});
