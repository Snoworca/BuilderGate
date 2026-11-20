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
