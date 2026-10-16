// FR-MCP-012: MCP tools that open markdown, source code and image files in the editor window.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createMcpToolService } from './McpToolService.js';
import { getDefaultMcpSessionScopes, getFixedMcpAccessKeyScopes } from './McpSecurityContract.js';
import type { McpEditorOpenRequest, McpTerminalView, McpWorkspaceControl, McpWorkspaceView } from './McpManagementTools.js';

type Rec = Record<string, unknown>;

const NOW = '2026-10-16T05:07:09.000Z';

function stamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function createFakeControl() {
  const workspaces: McpWorkspaceView[] = [
    { id: 'ws-1', name: 'Main', sortOrder: 0, activeTabId: 'tab-1' },
    { id: 'ws-2', name: 'Docs', sortOrder: 1, activeTabId: null },
  ];
  const terminals: McpTerminalView[] = [
    { id: 'tab-1', workspaceId: 'ws-1', sessionId: 's-1', sessionKey: 'k-1', name: 'build', shellType: 'bash', lifecycleState: 'active', cwd: '/w' },
    { id: 'tab-2', workspaceId: 'ws-2', sessionId: 's-2', sessionKey: 'k-2', name: 'docs', shellType: 'bash', lifecycleState: 'active', cwd: '/d' },
  ];
  const cwdOf: Record<string, string> = { 's-1': '/w', 's-2': '/d' };
  const files = new Map<string, string>([
    ['/w/README.md', '# hi'],
    ['/w/notes.markdown', 'x'],
    ['/w/src/app.ts', 'export {}'],
    ['/w/img/logo.png', 'PNG'],
    ['/w/img/icon.SVG', '<svg/>'],
    ['/d/guide.md', '# guide'],
  ]);
  const dirs = new Set(['/w', '/w/src', '/w/img', '/w/docs.md', '/d']);
  const opened: McpEditorOpenRequest[] = [];
  const writes: Rec[] = [];
  const resolve = (sessionId: string, filePath: string): string => {
    const base = cwdOf[sessionId];
    const resolved = path.posix.resolve(base, filePath);
    if (resolved !== base && !resolved.startsWith(`${base}/`)) throw codeError('PATH_TRAVERSAL');
    if (resolved.split('/').includes('.ssh') || resolved.endsWith('.exe')) throw codeError('PATH_BLOCKED');
    return resolved;
  };
  const control: McpWorkspaceControl = {
    listWorkspaces: () => workspaces.map(w => ({ ...w })),
    listTerminals: () => terminals.map(t => ({ ...t })),
    createWorkspace: async () => { throw new Error('unused'); },
    renameWorkspace: async () => { throw new Error('unused'); },
    deleteWorkspace: async () => { throw new Error('unused'); },
    createTerminal: async () => { throw new Error('unused'); },
    deleteTerminal: async () => { throw new Error('unused'); },
    execTerminal: async () => { throw new Error('unused'); },
    readTerminalText: () => null,
    inspectEditorFile: async (sessionId, filePath) => {
      const resolved = resolve(sessionId, filePath);
      return { path: resolved, exists: files.has(resolved) || dirs.has(resolved), isFile: files.has(resolved) };
    },
    writeEditorFile: async (sessionId, filePath, content) => {
      const resolved = resolve(sessionId, filePath);
      writes.push({ sessionId, path: resolved, content });
      files.set(resolved, content);
      return resolved;
    },
    openEditor: (request) => { opened.push(request); },
  };
  return { control, opened, writes, files };
}

function setup(scopes: string[] = getFixedMcpAccessKeyScopes(), actorExtra: Rec = {}) {
  const fake = createFakeControl();
  const service = createMcpToolService({
    workspaceControl: fake.control,
    now: () => NOW,
  }) as { callTool: (request: unknown) => Promise<Rec>; listTools: () => Rec };
  const call = (name: string, args: Rec = {}) => service.callTool({
    name,
    arguments: args,
    actor: { type: 'mcp-fixed-access-key', scopes, ...actorExtra },
  });
  return { ...fake, service, call };
}

const MD = 'buildergate.editor.open_markdown';
const CODE = 'buildergate.editor.open_code';
const IMAGE = 'buildergate.editor.open_image';

test('FR-MCP-012 AC-1: open_markdown opens an existing markdown file', async () => {
  const { call, opened, writes } = setup();
  const result = await call(MD, { terminalId: 'tab-1', filePath: 'README.md' });
  assert.deepEqual(result, {
    ok: true, terminalId: 'tab-1', workspaceId: 'ws-1', filePath: '/w/README.md', kind: 'markdown', created: false,
  });
  assert.deepEqual(opened, [{ workspaceId: 'ws-1', terminalId: 'tab-1', filePath: '/w/README.md', kind: 'markdown' }]);
  assert.deepEqual(writes, []);
  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: '/w/notes.markdown' })).ok, true);
});

test('FR-MCP-012 AC-1: open_markdown refuses a missing file and another extension', async () => {
  const { call, opened } = setup();
  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: 'missing.md' })).code, 'FILE_NOT_FOUND');
  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: 'src/app.ts' })).code, 'VALIDATION_ERROR');
  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: 'docs.md' })).code, 'FILE_NOT_FOUND', 'a directory is not a file');
  assert.equal((await call(MD, { terminalId: 'tab-1' })).code, 'VALIDATION_ERROR', 'filePath or content is required');
  assert.deepEqual(opened, []);
});

test('FR-MCP-012 AC-2: content without filePath is saved under .buildergate/mcp-docs and opened', async () => {
  const { call, opened, writes } = setup();
  const result = await call(MD, { terminalId: 'tab-1', content: '# Plan\n', title: 'Release Plan v2!' });
  const expected = `/w/.buildergate/mcp-docs/${stamp(NOW)}-release-plan-v2.md`;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.filePath, expected);
  assert.equal(result.created, true);
  assert.deepEqual(writes, [{ sessionId: 's-1', path: expected, content: '# Plan\n' }]);
  assert.deepEqual(opened, [{ workspaceId: 'ws-1', terminalId: 'tab-1', filePath: expected, kind: 'markdown' }]);

  const untitled = setup();
  const plain = await untitled.call(MD, { terminalId: 'tab-1', content: 'x' });
  assert.equal(plain.filePath, `/w/.buildergate/mcp-docs/${stamp(NOW)}.md`);
});

test('FR-MCP-012 AC-2: content with filePath writes there and refuses an existing file unless overwrite', async () => {
  const { call, writes, opened, files } = setup();
  const fresh = await call(MD, { terminalId: 'tab-1', filePath: 'docs/new.md', content: 'new' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.filePath, '/w/docs/new.md');
  assert.equal(files.get('/w/docs/new.md'), 'new');

  const clash = await call(MD, { terminalId: 'tab-1', filePath: 'README.md', content: 'gone' });
  assert.equal(clash.code, 'FILE_EXISTS');
  assert.equal(files.get('/w/README.md'), '# hi', 'nothing was written');

  const over = await call(MD, { terminalId: 'tab-1', filePath: 'README.md', content: 'replaced', overwrite: true });
  assert.equal(over.ok, true);
  assert.equal(files.get('/w/README.md'), 'replaced');
  assert.equal(writes.length, 2);
  assert.equal(opened.length, 2);

  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: 'a.txt', content: 'x' })).code, 'VALIDATION_ERROR');
});

test('FR-MCP-012 AC-3: open_code opens only a saved file and refuses content and images', async () => {
  const { call, opened, writes } = setup();
  const result = await call(CODE, { terminalId: 'tab-1', filePath: 'src/app.ts' });
  assert.deepEqual(result, {
    ok: true, terminalId: 'tab-1', workspaceId: 'ws-1', filePath: '/w/src/app.ts', kind: 'code', created: false,
  });
  assert.equal((await call(CODE, { terminalId: 'tab-1', filePath: 'src/missing.ts' })).code, 'FILE_NOT_FOUND');
  assert.equal((await call(CODE, { terminalId: 'tab-1', filePath: 'src/app.ts', content: 'x' })).code, 'VALIDATION_ERROR');
  const image = await call(CODE, { terminalId: 'tab-1', filePath: 'img/logo.png' });
  assert.equal(image.code, 'VALIDATION_ERROR');
  assert.match(JSON.stringify(image), /open_image/);
  assert.equal(opened.length, 1);
  assert.deepEqual(writes, []);
});

test('FR-MCP-012 AC-4: open_image opens an existing image and refuses other files', async () => {
  const { call, opened } = setup();
  const result = await call(IMAGE, { terminalId: 'tab-1', filePath: 'img/logo.png' });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'image');
  assert.equal((await call(IMAGE, { terminalId: 'tab-1', filePath: 'img/icon.SVG' })).ok, true, 'extension is case-insensitive');
  assert.equal((await call(IMAGE, { terminalId: 'tab-1', filePath: 'img/none.png' })).code, 'FILE_NOT_FOUND');
  assert.equal((await call(IMAGE, { terminalId: 'tab-1', filePath: 'README.md' })).code, 'VALIDATION_ERROR');
  assert.equal(opened.length, 2);
});

test('FR-MCP-012 AC-5: paths outside the working directory or blocked are refused and nothing opens', async () => {
  const { call, opened, writes } = setup();
  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: '../etc/x.md' })).code, 'PATH_TRAVERSAL');
  assert.equal((await call(MD, { terminalId: 'tab-1', filePath: '../etc/x.md', content: 'x' })).code, 'PATH_TRAVERSAL');
  assert.equal((await call(CODE, { terminalId: 'tab-1', filePath: '.ssh/id_rsa' })).code, 'PATH_BLOCKED');
  assert.deepEqual(opened, []);
  assert.deepEqual(writes, []);
});

test('FR-MCP-012 AC-6: a session actor defaults to its own terminal and cannot reach another', async () => {
  const scopes = getDefaultMcpSessionScopes();
  assert.ok(scopes.includes('mcp:editor.open'), 'session actors hold mcp:editor.open');
  assert.ok(getFixedMcpAccessKeyScopes().includes('mcp:editor.open'), 'the fixed key holds it too');

  const own = setup(scopes, { type: 'mcp-session', sessionKey: 'k-2' });
  const result = await own.call(MD, { filePath: 'guide.md' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.terminalId, 'tab-2');
  assert.equal(result.filePath, '/d/guide.md');
  assert.equal((await own.call(MD, { terminalId: 'tab-2', filePath: 'guide.md' })).ok, true, 'naming itself is fine');
  assert.equal((await own.call(MD, { terminalId: 'tab-1', filePath: 'README.md' })).code, 'INVALID_SCOPE');
  assert.equal(own.opened.length, 2);

  const fixed = setup();
  assert.equal((await fixed.call(MD, { filePath: 'README.md' })).code, 'VALIDATION_ERROR', 'the fixed key must name a terminal');
  assert.equal((await fixed.call(MD, { workspaceName: 'Main', terminalName: 'build', filePath: 'README.md' })).ok, true);

  const noScope = setup(['mcp:terminals.read']);
  assert.equal((await noScope.call(MD, { terminalId: 'tab-1', filePath: 'README.md' })).code, 'INVALID_SCOPE');
  assert.equal(noScope.opened.length, 0);
});

test('FR-MCP-012 AC-8: tools/list advertises the editor tools with schemas', () => {
  const { service } = setup();
  const tools = service.listTools().tools as Rec[];
  const keys = (name: string) => Object.keys(((tools.find(t => t.name === name)?.inputSchema as Rec)?.properties ?? {}) as Rec).sort();
  assert.deepEqual(keys(MD), ['content', 'filePath', 'overwrite', 'terminalId', 'terminalName', 'title', 'workspaceId', 'workspaceName']);
  assert.deepEqual(keys(CODE), ['filePath', 'terminalId', 'terminalName', 'workspaceId', 'workspaceName']);
  assert.deepEqual(keys(IMAGE), ['filePath', 'terminalId', 'terminalName', 'workspaceId', 'workspaceName']);
  for (const name of [MD, CODE, IMAGE]) {
    const tool = tools.find(t => t.name === name)!;
    assert.equal((tool.inputSchema as Rec).additionalProperties, false, name);
    assert.ok(String(tool.description).length > 10, name);
  }
});
