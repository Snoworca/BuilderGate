// A workspace with a test folder, for specs that open files the server can see.
//
// Shape (code-editor-image.spec.ts's): one workspace created through createOwnedWorkspaceViaApi
// under the caller's owner id, removed only through cleanupOwnedWorkspaces for that owner; a
// "base" tab whose session cwd is where the folder is made; the folder filled through node:fs
// (the spec runs on the server's host, which the listing check proves); a "work" tab whose cwd is
// the folder and which is the active tab. The folder is removed by its exact absolute path.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { expect, createOwnedWorkspaceViaApi, type APIRequestContext, type Page } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

export const ORIGIN = 'https://localhost:2222';

export interface OwnedFolder {
  ownerId: string;
  token: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  baseSessionId: string | null;
  folder: string | null;
  workTabId: string | null;
  workSessionId: string | null;
  apiCreationStarted: boolean;
}

export function newOwnedFolder(ownerId: string): OwnedFolder {
  return {
    ownerId, token: null, workspaceId: null, workspaceName: null, baseSessionId: null,
    folder: null, workTabId: null, workSessionId: null, apiCreationStarted: false,
  };
}

function registryOptions(): RegistryOptions {
  return {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '',
    baseUrl: ORIGIN,
  };
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function separatorOf(path: string): string {
  return /^[A-Za-z]:/.test(path) || path.includes('\\') ? '\\' : '/';
}

export function joinPath(base: string, ...names: string[]): string {
  const sep = separatorOf(base);
  return [base.replace(/[\\/]+$/, ''), ...names].join(sep);
}

interface WorkspaceState {
  tabs: { id: string; workspaceId: string; sessionId?: string }[];
}

async function readState(request: APIRequestContext, token: string): Promise<WorkspaceState> {
  const response = await request.get(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token) });
  expect(response.status(), 'workspace list').toBe(200);
  return await response.json() as WorkspaceState;
}

async function addTab(
  request: APIRequestContext, token: string, workspaceId: string, name: string, cwd?: string,
): Promise<{ tabId: string; sessionId: string }> {
  const response = await request.post(`${ORIGIN}/api/workspaces/${workspaceId}/tabs`, {
    headers: authHeaders(token),
    data: cwd === undefined ? { name } : { name, cwd },
  });
  expect(response.status(), `tab create ${name}`).toBe(201);
  const tab = await response.json() as { id: string };
  const found = (await readState(request, token)).tabs.find(item => item.id === tab.id);
  if (!found?.sessionId) throw new Error(`tab ${tab.id} has no session in the workspace list`);
  return { tabId: tab.id, sessionId: found.sessionId };
}

async function sessionCwd(request: APIRequestContext, token: string, sessionId: string): Promise<string> {
  const response = await request.get(`${ORIGIN}/api/sessions/${sessionId}/cwd`, { headers: authHeaders(token) });
  expect(response.status(), 'session cwd').toBe(200);
  const body = await response.json() as { cwd: string };
  if (!body.cwd) throw new Error(`session ${sessionId} reported an empty cwd`);
  return body.cwd;
}

/** Files by relative path ('img/a.png'); parent directories are made. */
export async function setUpOwnedFolder(
  page: Page, request: APIRequestContext, record: OwnedFolder, prefix: string, files: Record<string, Buffer | string>,
): Promise<void> {
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('login left no auth token in localStorage');
  record.token = token;

  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `${prefix}-${suffix}`;
  record.apiCreationStarted = true;
  const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), record.ownerId, {
    headers: authHeaders(token), data: { name: workspaceName },
  });
  record.workspaceId = workspace.id;
  record.workspaceName = workspaceName;

  const base = await addTab(request, token, workspace.id, `${prefix}-base`);
  record.baseSessionId = base.sessionId;
  const baseCwd = await sessionCwd(request, token, base.sessionId);
  const folderName = `bg-${prefix}-${suffix}`;
  const mkdir = await request.post(`${ORIGIN}/api/sessions/${base.sessionId}/files/mkdir`, {
    headers: authHeaders(token), data: { path: baseCwd, name: folderName },
  });
  expect(mkdir.status(), `mkdir ${folderName}`).toBe(200);
  const folder = joinPath(baseCwd, folderName);
  record.folder = folder;

  for (const [relative, bytes] of Object.entries(files)) {
    const parts = relative.split('/');
    if (parts.length > 1) mkdirSync(joinPath(folder, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(joinPath(folder, ...parts), bytes);
  }
  const listing = await request.get(
    `${ORIGIN}/api/sessions/${base.sessionId}/files?path=${encodeURIComponent(folder)}`,
    { headers: authHeaders(token) },
  );
  expect(listing.status(), 'fixture listing').toBe(200);
  const listed = ((await listing.json()) as { entries: { name: string }[] }).entries.map(entry => entry.name);
  const topLevel = [...new Set(Object.keys(files).map(path => path.split('/')[0]))];
  for (const name of topLevel) expect(listed, 'fixture files are visible to the server').toContain(name);

  const work = await addTab(request, token, workspace.id, `${prefix}-work`, folder);
  record.workTabId = work.tabId;
  record.workSessionId = work.sessionId;
  const workCwd = await sessionCwd(request, token, work.sessionId);
  expect(workCwd.replace(/[\\/]+$/, '').endsWith(folderName), 'work tab starts in the test folder').toBe(true);

  await page.evaluate((id) => localStorage.setItem('active_workspace_id', id), workspace.id);
  await page.reload();
  await page.waitForSelector('.workspace-screen', { timeout: 20000 });
  // The work tab must be the active one: the explorer opens on the active tab's directory.
  const workTab = page.locator('.workspace-tabbar [role="tab"]', { hasText: `${prefix}-work` }).first();
  await workTab.click();
  await expect(workTab).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  // A terminal whose input is enabled means the WebSocket is connected; broadcasts sent before
  // that (an MCP editor:open, for one) would reach no browser.
  await expect.poll(() => page.evaluate(() => {
    const view = Array.from(document.querySelectorAll('.terminal-view')).find((node) => {
      const rect = (node as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const input = view?.querySelector('textarea.xterm-helper-textarea');
    return input instanceof HTMLTextAreaElement && !input.disabled;
  }), { timeout: 30000 }).toBe(true);
}

export async function tearDownOwnedFolder(request: APIRequestContext, record: OwnedFolder): Promise<void> {
  const failures: unknown[] = [];
  // The work tab's shell sits in the folder, and Windows refuses to remove a directory a live
  // process has as its cwd. Only this workspace's tabs, by id.
  if (record.token && record.workspaceId && record.baseSessionId) {
    try {
      const doomed = (await readState(request, record.token)).tabs.filter(tab =>
        tab.workspaceId === record.workspaceId && tab.sessionId !== record.baseSessionId);
      for (const tab of doomed) {
        const response = await request.delete(`${ORIGIN}/api/workspaces/${record.workspaceId}/tabs/${tab.id}`,
          { headers: authHeaders(record.token) });
        if (response.status() !== 200) throw new Error(`owned tab ${tab.id} delete returned ${response.status()}`);
      }
    } catch (error) { failures.push(error); }
  }
  if (record.token && record.baseSessionId && record.folder) {
    try {
      const deadline = Date.now() + 20000;
      for (;;) {
        const response = await request.delete(
          `${ORIGIN}/api/sessions/${record.baseSessionId}/files?path=${encodeURIComponent(record.folder)}`,
          { headers: authHeaders(record.token) },
        );
        if (response.status() === 200) break;
        if (Date.now() > deadline) throw new Error(`test folder delete of ${record.folder} kept failing: ${response.status()}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) { failures.push(error); }
  }
  if (record.apiCreationStarted) {
    try {
      const result = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId: record.ownerId });
      if (result.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(result.failed)}`);
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'owned folder teardown failed');
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A solid-colour RGB PNG. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
