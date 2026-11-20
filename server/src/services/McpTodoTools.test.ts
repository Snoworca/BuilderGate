// FR-TODO-005: the to-do list over MCP — buildergate.todo.* against a real TodoService.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpToolService } from './McpToolService.js';
import { getDefaultMcpSessionScopes, getFixedMcpAccessKeyScopes } from './McpSecurityContract.js';
import { TodoService } from './todo/TodoService.js';

type Rec = Record<string, unknown>;

async function withTools(body: (call: (name: string, args?: Rec, scopes?: string[]) => Promise<Rec>, todos: TodoService, listTools: () => Rec) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-mcp-todo-'));
  const todos = new TodoService({ dataPath: path.join(dir, 'todos.json') });
  await todos.initialize();
  const tools = createMcpToolService({ todoControl: todos }) as { callTool: (request: unknown) => Promise<Rec>; listTools: () => Rec };
  try {
    await body(
      (name, args = {}, scopes = getDefaultMcpSessionScopes()) => tools.callTool({ name, arguments: args, actor: { type: 'mcp-session', scopes } }),
      todos,
      () => tools.listTools(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FR-TODO-005: tools/list advertises the to-do tools', async () => {
  await withTools(async (_call, _todos, listTools) => {
    const tools = listTools().tools as Rec[];
    for (const name of ['list', 'add', 'update', 'delete']) {
      const tool = tools.find((entry) => entry.name === `buildergate.todo.${name}`);
      assert.ok(tool, `buildergate.todo.${name}`);
      assert.equal((tool.inputSchema as Rec).type, 'object');
    }
  });
});

test('FR-TODO-005 AC-4: session agents and the fixed key hold the to-do scopes; without them the tool is refused', async () => {
  for (const scopes of [getDefaultMcpSessionScopes(), getFixedMcpAccessKeyScopes()]) {
    assert.ok(scopes.includes('mcp:todos.read'));
    assert.ok(scopes.includes('mcp:todos.write'));
  }
  await withTools(async (call) => {
    assert.equal((await call('buildergate.todo.add', { title: 'x' }, ['mcp:todos.read'])).code, 'INVALID_SCOPE');
    assert.equal((await call('buildergate.todo.list', {}, ['mcp:self.read'])).code, 'INVALID_SCOPE');
  });
});

test('FR-TODO-005 AC-1/AC-2: add returns the new id, list returns the tree, depth beyond three is refused', async () => {
  await withTools(async (call) => {
    const category = await call('buildergate.todo.add', { title: 'Release', detail: 'v1' });
    assert.equal(category.ok, true);
    assert.equal((category.todo as Rec).id, 1);
    const item = await call('buildergate.todo.add', { parentId: 1, title: 'Build' });
    const sub = await call('buildergate.todo.add', { parentId: (item.todo as Rec).id, title: 'Windows' });
    const tooDeep = await call('buildergate.todo.add', { parentId: (sub.todo as Rec).id, title: 'x' });
    assert.equal(tooDeep.ok, false);
    assert.equal(tooDeep.code, 'VALIDATION_ERROR');
    const listed = await call('buildergate.todo.list');
    const tree = listed.todos as Rec[];
    assert.equal(tree.length, 1);
    assert.equal(tree[0].title, 'Release');
    const children = tree[0].children as Rec[];
    assert.equal(children[0].id, 2);
    assert.equal(((children[0].children as Rec[])[0]).id, 3);
  });
});

test('FR-TODO-005 AC-1/AC-3: update changes only given fields, list can leave out done entries, delete needs confirm', async () => {
  await withTools(async (call, todos) => {
    await call('buildergate.todo.add', { title: 'A' });
    await call('buildergate.todo.add', { parentId: 1, title: 'B' });
    const updated = await call('buildergate.todo.update', { id: 2, done: true });
    assert.equal((updated.todo as Rec).done, true);
    assert.equal((updated.todo as Rec).title, 'B');
    const open = await call('buildergate.todo.list', { includeDone: false });
    assert.deepEqual((open.todos as Rec[])[0].children, []);
    assert.equal((await call('buildergate.todo.update', { id: 99, done: true })).code, 'TARGET_NOT_FOUND');
    assert.equal((await call('buildergate.todo.delete', { id: 1 })).ok, false);
    const deleted = await call('buildergate.todo.delete', { id: 1, confirm: true });
    assert.equal(deleted.ok, true);
    assert.deepEqual(todos.list(), []);
  });
});
