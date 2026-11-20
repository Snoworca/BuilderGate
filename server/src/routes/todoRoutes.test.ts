// FR-TODO-001/003/004 — the REST surface the panel uses. Served over withLocalHttpServer's
// pipe/socket, so no TCP port is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createTodoRoutes } from './todoRoutes.js';
import { TodoService } from '../services/todo/TodoService.js';

async function withRoutes(run: (req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-todo-routes-'));
  const service = new TodoService({ dataPath: path.join(dir, 'todos.json') });
  await service.initialize();
  const app = express();
  app.use(express.json());
  app.use('/api/todos', createTodoRoutes(service));
  try {
    await withLocalHttpServer(app, async (fixture) => {
      await run(async (method, p, data) => {
        const response = await fixture.request({
          method,
          path: p,
          headers: data === undefined ? {} : { 'content-type': 'application/json' },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FR-TODO-003/004: add, list, update, delete over REST', async () => {
  await withRoutes(async (req) => {
    const created = await req('POST', '/api/todos', { title: 'Category' });
    assert.equal(created.status, 201);
    assert.equal(created.json.todo.id, 1);
    const child = await req('POST', '/api/todos', { parentId: 1, title: 'Item' });
    assert.equal(child.json.todo.parentId, 1);

    const updated = await req('PATCH', '/api/todos/2', { detail: 'how', done: true });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.todo.detail, 'how');
    assert.equal(updated.json.todo.done, true);

    const listed = await req('GET', '/api/todos');
    assert.deepEqual(listed.json.todos.map((todo: { id: number }) => todo.id), [1, 2]);

    const removed = await req('DELETE', '/api/todos/1');
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.json.removed.sort(), [1, 2]);
    assert.deepEqual((await req('GET', '/api/todos')).json.todos, []);
  });
});

test('FR-TODO-001 AC-3/AC-4: invalid input is 400, a missing id is 404', async () => {
  await withRoutes(async (req) => {
    assert.equal((await req('POST', '/api/todos', { title: '' })).status, 400);
    assert.equal((await req('PATCH', '/api/todos/7', { done: true })).status, 404);
    assert.equal((await req('DELETE', '/api/todos/abc')).status, 404);
  });
});

test('FR-TODO-001 AC-7: an entry added from the panel is the user\'s, whatever the body says', async () => {
  await withRoutes(async (req) => {
    const created = await req('POST', '/api/todos', { title: 'Mine', author: { kind: 'session', sessionKey: 'x', name: 'fake' } });
    assert.deepEqual(created.json.todo.author, { kind: 'user' });
  });
});
