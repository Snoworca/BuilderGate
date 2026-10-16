// FR-MCP-012 and FR-MDE-027, end to end: an MCP client opens markdown (as a file and as text),
// a saved source file and images in the browser's editor window, and the image viewer's ‹ ›
// steps through the folder's images in place.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD, and
// only when the runner gives it an MCP endpoint and a fixed access key of that runtime:
//   BUILDERGATE_E2E_MCP_URL  e.g. http://127.0.0.1:3334/mcp (its origin is used, path /mcp)
//   BUILDERGATE_E2E_MCP_KEY  the fixed access key (never written anywhere by this spec)
// The spec does not enable MCP or rotate the key itself: a rotation cannot be undone, and the key
// the user set on the runtime would be lost. Without the two variables every test is skipped.
//
// Weak assertions avoided (what would satisfy them cheaply):
//   * "the tool answered ok" -- a tool that opens nothing would pass. The editor tab and the text
//     inside it have to appear in the browser.
//   * "the text file was created" -- a file with other content would pass. Its bytes are compared.
//   * "the position label changed" -- a label over the old image would pass. The active tab's
//     name and the tab count are read with it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, solidPng, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const MCP_URL = process.env.BUILDERGATE_E2E_MCP_URL ?? '';
const MCP_KEY = process.env.BUILDERGATE_E2E_MCP_KEY ?? '';

const FILES: Record<string, Buffer | string> = {
  'readme.md': '# Fixture readme\n\nreadme-body\n',
  'app.ts': 'export const answer = 42;\n',
  'img/a-red.png': solidPng(40, 40, [220, 30, 30]),
  'img/b-green.png': solidPng(40, 40, [30, 180, 30]),
  'img/c-blue.png': solidPng(40, 40, [30, 30, 220]),
};

type Rec = Record<string, unknown>;

// Node's fetch, not the page's request context: the MCP listener is plain HTTP on loopback and
// nothing it is sent touches the workspace API the ownership scanner guards.
class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  private async rpc(body: Rec): Promise<Rec | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${MCP_KEY}`,
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = '2025-11-25';
    }
    // A literal path on the configured origin, which the ownership scanner can classify.
    const endpoint = new URL('/mcp', new URL(MCP_URL).origin);
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    this.sessionId ??= response.headers.get('mcp-session-id');
    const text = await response.text();
    if (!text) return null;
    const line = text.split('\n').find(candidate => candidate.startsWith('data:'));
    return JSON.parse(line ? line.slice(5) : text) as Rec;
  }

  async connect(): Promise<void> {
    await this.rpc({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    await this.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name: string, args: Rec): Promise<Rec> {
    const reply = await this.rpc({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
    const result = (reply?.result ?? {}) as Rec;
    if (result.structuredContent) return result.structuredContent as Rec;
    const content = result.content as { text?: string }[] | undefined;
    return JSON.parse(content?.[0]?.text ?? '{}') as Rec;
  }
}

function editorTabs(page: Page) {
  return page.locator('.editor-tab-label');
}

async function activeEditorTab(page: Page): Promise<string> {
  return (await page.locator('.editor-tab.is-active .editor-tab-label').innerText()).trim();
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

test.describe('MCP editor tools and image viewer navigation', () => {
  let record: OwnedFolder;
  let mcp: McpClient;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.skip(!MCP_URL || !MCP_KEY, 'BUILDERGATE_E2E_MCP_URL and BUILDERGATE_E2E_MCP_KEY are not set');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`mcp-editor-open/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-mcpedit', FILES);
    mcp = new McpClient();
    await mcp.connect();
  });

  test.afterEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || !MCP_URL || !MCP_KEY || !record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-MCP-012 AC-1, AC-2, AC-3, AC-5, AC-7
  test('markdown as text, markdown and code files open in the editor; refusals open nothing', async ({ page }) => {
    const marker = `mcp-e2e-${randomUUID().slice(0, 8)}`;
    const content = `# MCP E2E\n\n${marker}\n`;
    const fromText = await mcp.call('buildergate.editor.open_markdown', { terminalId: record.workTabId, content, title: 'E2E Doc' });
    expect(fromText, JSON.stringify(fromText)).toMatchObject({ ok: true, kind: 'markdown', created: true, terminalId: record.workTabId });
    const textPath = String(fromText.filePath);
    expect(textPath.startsWith(joinPath(record.folder!, '.buildergate', 'mcp-docs')), textPath).toBe(true);
    expect(basename(textPath)).toMatch(/^\d{8}-\d{6}-e2e-doc\.md$/);
    expect(readFileSync(textPath, 'utf8'), 'the saved file holds the text').toBe(content);
    await expect(editorTabs(page).filter({ hasText: basename(textPath) })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.editor-window-documents').getByText(marker)).toBeVisible({ timeout: 15000 });

    const fromFile = await mcp.call('buildergate.editor.open_markdown', { terminalId: record.workTabId, filePath: 'readme.md' });
    expect(fromFile).toMatchObject({ ok: true, kind: 'markdown', created: false });
    await expect(editorTabs(page).filter({ hasText: 'readme.md' })).toBeVisible({ timeout: 15000 });

    const code = await mcp.call('buildergate.editor.open_code', { terminalId: record.workTabId, filePath: 'app.ts' });
    expect(code).toMatchObject({ ok: true, kind: 'code' });
    await expect(editorTabs(page).filter({ hasText: 'app.ts' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.editor-window-documents').getByText('answer = 42')).toBeVisible({ timeout: 15000 });

    const before = await editorTabs(page).count();
    expect((await mcp.call('buildergate.editor.open_code', { terminalId: record.workTabId, filePath: 'missing.ts' })).code).toBe('FILE_NOT_FOUND');
    expect((await mcp.call('buildergate.editor.open_code', { terminalId: record.workTabId, filePath: 'app.ts', content: 'x' })).code).toBe('VALIDATION_ERROR');
    expect((await mcp.call('buildergate.editor.open_markdown', { terminalId: record.workTabId, filePath: '../escape.md', content: 'x' })).code).toBe('PATH_TRAVERSAL');
    expect((await mcp.call('buildergate.editor.open_image', { terminalId: record.workTabId, filePath: 'readme.md' })).code).toBe('VALIDATION_ERROR');
    await page.waitForTimeout(1500);
    expect(await editorTabs(page).count(), 'a refused call opens no tab').toBe(before);
    await page.screenshot({ path: '../.playwright-mcp/e2e-mcp-editor-open.png' });
  });

  // FR-MCP-012 AC-4, FR-MDE-027 AC-1..AC-3
  test('the image viewer steps through the folder with ‹ › and the arrow keys', async ({ page }) => {
    expect((await mcp.call('buildergate.editor.open_image', { terminalId: record.workTabId, filePath: 'img/c-blue.png' })).ok).toBe(true);
    await expect(editorTabs(page).filter({ hasText: 'c-blue.png' })).toBeVisible({ timeout: 15000 });
    expect((await mcp.call('buildergate.editor.open_image', { terminalId: record.workTabId, filePath: 'img/b-green.png' })).ok).toBe(true);
    const position = page.locator('.image-viewer-position:visible');
    await expect(position).toHaveText('2 / 3', { timeout: 15000 });
    expect(await activeEditorTab(page)).toBe('b-green.png');
    const tabCount = await editorTabs(page).count();

    // AC-3: c-blue.png is already open, so › selects its tab rather than opening it again.
    await page.locator('.image-viewer-next:visible').click();
    await expect(position).toHaveText('3 / 3');
    expect(await activeEditorTab(page)).toBe('c-blue.png');
    await expect(page.locator('.image-viewer-next:visible')).toBeDisabled();
    expect(await editorTabs(page).count()).toBe(tabCount);

    // AC-2: back on b-green.png, ‹ replaces that tab with a-red.png in place.
    await editorTabs(page).filter({ hasText: 'b-green.png' }).click();
    await expect(position).toHaveText('2 / 3');
    await page.locator('.image-viewer-previous:visible').click();
    await expect(position).toHaveText('1 / 3', { timeout: 15000 });
    expect(await activeEditorTab(page)).toBe('a-red.png');
    await expect(page.locator('.image-viewer-previous:visible')).toBeDisabled();
    expect(await editorTabs(page).count(), 'the step replaced the tab').toBe(tabCount);
    await expect(editorTabs(page).filter({ hasText: 'b-green.png' })).toHaveCount(0);

    // AC-2: the arrow keys step while the viewer has focus, twice in a row.
    await page.locator('.image-viewer-stage:visible').click();
    await page.keyboard.press('ArrowRight');
    await expect(position).toHaveText('2 / 3', { timeout: 15000 });
    expect(await activeEditorTab(page)).toBe('b-green.png');
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowRight');
    await expect(position).toHaveText('3 / 3', { timeout: 15000 });
    expect(await activeEditorTab(page)).toBe('c-blue.png');
    await page.screenshot({ path: '../.playwright-mcp/e2e-image-viewer-nav.png' });
  });
});
