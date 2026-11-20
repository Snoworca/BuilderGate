import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TodoNotFoundError, TodoService, TodoValidationError } from './TodoService.js';

// FR-TODO-001: one server-wide to-do list with absolute ids and three levels.

function tempService(onChange?: () => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'todo-'));
  const dataPath = path.join(dir, 'todos.json');
  const service = new TodoService({ dataPath, ...(onChange ? { onChange } : {}) });
  return { service, dataPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('FR-TODO-001 AC-2: ids are absolute and grow by one for every item created, never reused', async () => {
  const { service, cleanup } = tempService();
  try {
    await service.initialize();
    const a = await service.add({ title: 'Category' });
    const b = await service.add({ parentId: a.id, title: 'Item' });
    const c = await service.add({ parentId: b.id, title: 'Sub' });
    assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
    await service.remove(c.id);
    const d = await service.add({ parentId: b.id, title: 'Next' });
    assert.equal(d.id, 4);
  } finally {
    cleanup();
  }
});

test('FR-TODO-001 AC-3: at most three levels', async () => {
  const { service, cleanup } = tempService();
  try {
    await service.initialize();
    const a = await service.add({ title: 'Category' });
    const b = await service.add({ parentId: a.id, title: 'Item' });
    const c = await service.add({ parentId: b.id, title: 'Sub' });
    await assert.rejects(service.add({ parentId: c.id, title: 'Too deep' }), (error: unknown) => error instanceof TodoValidationError && error.reason === 'depth');
    await assert.rejects(service.add({ parentId: 99, title: 'Orphan' }), TodoNotFoundError);
  } finally {
    cleanup();
  }
});

test('FR-TODO-001 AC-4: title is required, update changes only given fields, delete removes the subtree', async () => {
  const { service, cleanup } = tempService();
  try {
    await service.initialize();
    await assert.rejects(service.add({ title: '   ' }), (error: unknown) => error instanceof TodoValidationError && error.reason === 'title');
    const a = await service.add({ title: 'Category', detail: 'why' });
    const b = await service.add({ parentId: a.id, title: 'Item' });
    await service.add({ parentId: b.id, title: 'Sub' });
    const other = await service.add({ title: 'Other' });
    const updated = await service.update(b.id, { done: true });
    assert.equal(updated.done, true);
    assert.equal(updated.title, 'Item');
    await assert.rejects(service.update(b.id, { title: '' }), TodoValidationError);
    const removed = await service.remove(a.id);
    assert.deepEqual(removed.sort(), [1, 2, 3]);
    assert.deepEqual(service.list().map((item) => item.id), [other.id]);
    await assert.rejects(service.update(a.id, { done: true }), TodoNotFoundError);
  } finally {
    cleanup();
  }
});

test('FR-TODO-001 AC-1: the list and the next id survive a restart', async () => {
  const { service, dataPath, cleanup } = tempService();
  try {
    await service.initialize();
    const a = await service.add({ title: 'Category', detail: 'detail' });
    await service.remove((await service.add({ title: 'Gone' })).id);
    await service.flush();
    assert.ok(JSON.parse(readFileSync(dataPath, 'utf-8')).items.length === 1);
    const again = new TodoService({ dataPath });
    await again.initialize();
    assert.deepEqual(again.list().map((item) => [item.id, item.title, item.detail]), [[a.id, 'Category', 'detail']]);
    assert.equal((await again.add({ title: 'New' })).id, 3);
  } finally {
    cleanup();
  }
});

test('FR-TODO-001 AC-5: every change is announced', async () => {
  let changes = 0;
  const { service, cleanup } = tempService(() => { changes += 1; });
  try {
    await service.initialize();
    const a = await service.add({ title: 'Category' });
    await service.update(a.id, { detail: 'x' });
    await service.remove(a.id);
    assert.equal(changes, 3);
  } finally {
    cleanup();
  }
});

// FR-TODO-001 AC-6: the list lives in memory; writes are queued and coalesced off the request path.

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

function memoryWriter() {
  const writes: string[] = [];
  let pending: { opened: Promise<void>; open: () => void } | null = null;
  let failNext = 0;
  const writeStore = async (_path: string, contents: string) => {
    if (pending) await pending.opened;
    if (failNext > 0) {
      failNext -= 1;
      throw new Error('disk full');
    }
    writes.push(contents);
  };
  return {
    writes,
    writeStore,
    hold() { pending = gate(); return pending; },
    release() { pending?.open(); pending = null; },
    failOnce() { failNext = 1; },
  };
}

test('FR-TODO-001 AC-6: a change answers and is announced without waiting for the disk', async () => {
  const writer = memoryWriter();
  let changes = 0;
  const service = new TodoService({ dataPath: path.join(os.tmpdir(), `todo-never-written-${process.pid}-${Math.random()}.json`), writeStore: writer.writeStore, onChange: () => { changes += 1; }, onPersistError: () => undefined });
  await service.initialize();
  writer.hold();
  const added = await Promise.race([
    service.add({ title: 'Category' }),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 200)),
  ]);
  assert.notEqual(added, 'blocked');
  assert.equal(changes, 1);
  assert.equal(writer.writes.length, 0);
  writer.release();
  await service.flush();
  assert.equal(writer.writes.length, 1);
});

test('FR-TODO-001 AC-6: changes made during a write are coalesced into one write of the latest state', async () => {
  const writer = memoryWriter();
  const service = new TodoService({ dataPath: path.join(os.tmpdir(), `todo-never-written-${process.pid}-${Math.random()}.json`), writeStore: writer.writeStore, onPersistError: () => undefined });
  await service.initialize();
  writer.hold();
  const a = await service.add({ title: 'First' });
  await service.add({ parentId: a.id, title: 'Second' });
  await service.add({ parentId: a.id, title: 'Third' });
  await service.update(a.id, { done: true });
  writer.release();
  await service.flush();
  assert.equal(writer.writes.length, 2);
  const last = JSON.parse(writer.writes[1]!);
  assert.deepEqual(last.items.map((item: { title: string }) => item.title), ['First', 'Second', 'Third']);
  assert.equal(last.items[0].done, true);
  assert.equal(last.nextId, 4);
});

test('FR-TODO-001 AC-6: a failed write is reported and retried, and flush leaves nothing unsaved', async () => {
  const writer = memoryWriter();
  const errors: unknown[] = [];
  const service = new TodoService({ dataPath: path.join(os.tmpdir(), `todo-never-written-${process.pid}-${Math.random()}.json`), writeStore: writer.writeStore, onPersistError: (error) => errors.push(error), retryDelayMs: 10 });
  await service.initialize();
  writer.failOnce();
  await service.add({ title: 'Kept' });
  assert.equal(service.list().length, 1);
  await service.flush();
  assert.equal(errors.length, 1);
  assert.equal(writer.writes.length, 1);
  assert.deepEqual(JSON.parse(writer.writes[0]!).items.map((item: { title: string }) => item.title), ['Kept']);
});

test('FR-TODO-001 AC-6: graceful shutdown flushes the to-do list', () => {
  const source = readFileSync(new URL('../../index.ts', import.meta.url), 'utf-8');
  const shutdown = source.slice(source.indexOf('async function performServerGracefulShutdown'));
  assert.match(shutdown.slice(0, shutdown.indexOf('\n}\n')), /todoService\??\.flush\(\)/);
});

test('FR-TODO-001 AC-7: an entry records who added it; the panel default is the user, and it survives a restart', async () => {
  const { service, dataPath, cleanup } = tempService();
  try {
    await service.initialize();
    const mine = await service.add({ title: 'Mine' });
    const agent = await service.add({ title: 'Agent', author: { kind: 'session', sessionKey: 'k1', name: 'claude-1' } });
    assert.deepEqual(mine.author, { kind: 'user' });
    assert.deepEqual(agent.author, { kind: 'session', sessionKey: 'k1', name: 'claude-1' });
    const edited = await service.update(agent.id, { done: true });
    assert.deepEqual(edited.author, agent.author);
    await service.flush();
    const again = new TodoService({ dataPath });
    await again.initialize();
    assert.deepEqual(again.list().map((item) => item.author), [{ kind: 'user' }, agent.author]);
  } finally {
    cleanup();
  }
});
