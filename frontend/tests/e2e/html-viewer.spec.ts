// #141, end to end: an HTML file opened in the editor renders in a sandboxed frame (FR-MDE-028)
// whose files come from the token route (SEC-MDE-002), and MCP opens HTML text rendered
// (FR-MCP-013).
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD. The
// MCP test also needs BUILDERGATE_E2E_MCP_URL and BUILDERGATE_E2E_MCP_KEY (as mcp-editor-open.spec.ts)
// and is skipped without them.
//
// Weak assertions avoided (what would satisfy them cheaply):
//   * "the frame is there" -- an empty or error page would pass. The page's own scripts write what
//     they did into its DOM (inline and external script ran, the stylesheet applied, the image
//     decoded, the parent unreachable), and that is read through the frame.
//   * "the unsaved banner shows" -- a frame still showing the file would pass. The inline script's
//     text changes with the edit, so the frame must run the new text.
//   * "the hidden file is blocked" -- a page that never asked would pass. The page reports the
//     status its own fetch got, and the server's response is caught on the wire.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { test, expect, type Locator, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, authHeaders, joinPath, newOwnedFolder, setUpOwnedFolder, solidPng, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const MCP_URL = process.env.BUILDERGATE_E2E_MCP_URL ?? '';
const MCP_KEY = process.env.BUILDERGATE_E2E_MCP_KEY ?? '';

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

const ANCHOR = 'anchor.txt';
const STYLED_COLOR = 'rgb(10, 120, 30)';

/** The page under site/: relative css, js and image, an inline script, a missing stylesheet and two hidden fetches. */
function pageHtml(inlineText: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>E2E page</title>
<link rel="stylesheet" href="css/style.css">
<link rel="stylesheet" href="css/missing.css">
</head><body>
<p id="inline">pending</p>
<p id="external">pending</p>
<p id="styled">styled</p>
<img id="pic" src="img/a.png" alt="a">
<p id="origin">pending</p>
<p id="parent-ls">pending</p>
<p id="parent-doc">pending</p>
<p id="cookie">pending</p>
<p id="env-up">pending</p>
<p id="env-here">pending</p>
<script>
const out = (id, value) => { document.getElementById(id).textContent = value; };
out('inline', ${JSON.stringify(inlineText)});
out('origin', String(self.origin));
try { out('parent-ls', 'read:' + String(parent.localStorage.getItem('cws_auth_token'))); } catch (e) { out('parent-ls', 'threw:' + e.name); }
try { out('parent-doc', 'read:' + parent.document.title); } catch (e) { out('parent-doc', 'threw:' + e.name); }
try { out('cookie', 'read:' + JSON.stringify(document.cookie)); } catch (e) { out('cookie', 'threw:' + e.name); }
fetch('../.env').then((r) => out('env-up', 'status:' + r.status), (e) => out('env-up', 'error:' + e.name));
fetch('.env').then((r) => out('env-here', 'status:' + r.status), (e) => out('env-here', 'error:' + e.name));
</script>
<script src="js/app.js"></script>
</body></html>
`;
}

const PAGE_V1 = pageHtml('inline ran v1');
const PAGE_V2 = pageHtml('inline ran v2');
const MCP_DOC = (marker: string) => `<!doctype html><html><head><link rel="stylesheet" href="mcp.css"></head>
<body><p id="mcp">pending</p><script>document.getElementById('mcp').textContent = ${JSON.stringify(marker)};</script></body></html>
`;

const FIXTURE: Record<string, Buffer | string> = {
  [ANCHOR]: 'anchor\n',
  // A hidden file beside the site folder; the page asks for it as ../.env.
  '.env': 'SECRET=do-not-serve\n',
  'site/page.html': PAGE_V1,
  'site/.env': 'SECRET=do-not-serve-either\n',
  'site/css/style.css': `#styled { color: ${STYLED_COLOR}; }\n`,
  'site/js/app.js': "document.getElementById('external').textContent = 'external ran';\n",
  'site/img/a.png': solidPng(24, 16, [200, 40, 40]),
  'phone.html': '<!doctype html><html><body><p id="phone">pending</p><script>document.getElementById(\'phone\').textContent = \'phone ran\';</script></body></html>\n',
  // A page inside a hidden folder may still load its own folder's files (SEC-MDE-002 AC-7).
  '.buildergate/mcp-docs/hidden-page.html': '<!doctype html><html><head><link rel="stylesheet" href="mcp.css"></head><body><p id="h">pending</p><script>document.getElementById(\'h\').textContent = \'hidden page ran\';</script></body></html>\n',
  '.buildergate/mcp-docs/mcp.css': `#mcp, #h { color: ${STYLED_COLOR}; }\n`,
};

function explorerRow(page: Page, name: string): Locator {
  return page.locator(`.window-dialog [data-path$="${name}"]`).first();
}

function editorWindow(page: Page): Locator {
  return page.locator('.window-dialog-surface.editor-window-surface:visible');
}

function panelFor(page: Page, fileName: string): Locator {
  return editorWindow(page).locator(`.editor-document-panel[data-document-id$="${fileName}"]`);
}

function frameOf(page: Page, fileName: string) {
  return panelFor(page, fileName).frameLocator('iframe.html-tab-frame');
}

async function openExplorer(page: Page, phone: boolean): Promise<void> {
  const button = page.locator('button[aria-label="파일 탐색기"]').first();
  if (phone) await button.tap(); else await button.click();
  await expect(explorerRow(page, ANCHOR)).toBeVisible({ timeout: 15000 });
}

async function closeExplorer(page: Page): Promise<void> {
  const explorer = page.locator('.window-dialog-surface.fx-window:visible');
  if (await explorer.count() === 0) return;
  await explorer.locator('button[aria-label="닫기"]').first().click();
  await expect(explorer).toHaveCount(0, { timeout: 10000 });
}

/** Opens site/page.html from the explorer and closes the explorer so it cannot cover the editor. */
async function openSitePage(page: Page): Promise<Locator> {
  await openExplorer(page, false);
  await explorerRow(page, 'site').dblclick();
  await expect(explorerRow(page, 'page.html')).toBeVisible({ timeout: 15000 });
  await explorerRow(page, 'page.html').dblclick();
  const panel = panelFor(page, 'page.html');
  await expect(panel.locator('.html-file-tab')).toBeVisible({ timeout: 15000 });
  await closeExplorer(page);
  return panel;
}

// Node's fetch, as mcp-editor-open.spec.ts: the MCP listener is plain HTTP on loopback.
class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  private async rpc(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${MCP_KEY}`,
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
      headers['mcp-protocol-version'] = '2025-11-25';
    }
    const endpoint = new URL('/mcp', new URL(MCP_URL).origin);
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    this.sessionId ??= response.headers.get('mcp-session-id');
    const text = await response.text();
    if (!text) return null;
    const line = text.split('\n').find(candidate => candidate.startsWith('data:'));
    return JSON.parse(line ? line.slice(5) : text) as Record<string, unknown>;
  }

  async connect(): Promise<void> {
    await this.rpc({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
    await this.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.rpc({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
    const result = (reply?.result ?? {}) as Record<string, unknown>;
    if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
    const content = result.content as { text?: string }[] | undefined;
    return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
  }
}

test.describe('HTML viewer', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`html-viewer/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-html', FIXTURE);
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-MDE-028 AC-1..AC-4, AC-6; SEC-MDE-002 AC-2, AC-3, AC-7
  test('desktop: the page renders by default with its scripts, stylesheet and image, isolated from the app', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop');
    const envResponse = page.waitForResponse(response => /\/api\/html-view\/[^/]+\/\.env$/.test(new URL(response.url()).pathname), { timeout: 30000 });
    const panel = await openSitePage(page);
    await expect(panel.locator('.html-file-tab')).toHaveAttribute('data-html-view', 'rendered');
    await expect(panel.locator('.html-tab-seg button', { hasText: '렌더링' })).toHaveAttribute('aria-pressed', 'true');

    const iframe = panel.locator('iframe.html-tab-frame');
    const sandbox = (await iframe.getAttribute('sandbox')) ?? '';
    expect(sandbox.split(/\s+/), 'scripts run').toContain('allow-scripts');
    expect(sandbox.split(/\s+/), 'never the app origin').not.toContain('allow-same-origin');
    expect(await iframe.getAttribute('src')).toMatch(/^\/api\/html-view\/[^/]+\/site\/page\.html/);

    const frame = frameOf(page, 'page.html');
    await expect(frame.locator('#inline')).toHaveText('inline ran v1', { timeout: 15000 });
    await expect(frame.locator('#external')).toHaveText('external ran');
    await expect.poll(() => frame.locator('#styled').evaluate(node => getComputedStyle(node).color), { timeout: 10000 }).toBe(STYLED_COLOR);
    await expect.poll(() => frame.locator('#pic').evaluate(node => (node as HTMLImageElement).naturalWidth), { timeout: 10000 }).toBe(24);

    // AC-4: an opaque origin; the parent's storage and DOM are out of reach, and no cookie is readable.
    await expect(frame.locator('#origin')).toHaveText('null');
    await expect(frame.locator('#parent-ls')).toHaveText(/^threw:/);
    await expect(frame.locator('#parent-doc')).toHaveText(/^threw:/);
    await expect(frame.locator('#cookie')).toHaveText(/^(threw:.*|read:"")$/);

    // SEC-MDE-002 AC-7: hidden files are refused, beside the folder and inside it.
    await expect(frame.locator('#env-up')).toHaveText('status:403', { timeout: 15000 });
    await expect(frame.locator('#env-here')).toHaveText('status:403');
    expect((await envResponse).status(), 'the server refused the hidden file').toBe(403);
    await page.screenshot({ path: '../.playwright-mcp/e2e-html-viewer-rendered.png' });
  });

  // FR-MDE-028 AC-5, AC-9; SEC-MDE-002 AC-6
  test('desktop: an unsaved source edit renders before saving, and Ctrl+S writes it', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop');
    const panel = await openSitePage(page);
    const frame = frameOf(page, 'page.html');
    await expect(frame.locator('#inline')).toHaveText('inline ran v1', { timeout: 15000 });

    const drafts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/files\/html-view\/[^/]+\/draft$/.test(request.url())) drafts.push(request.url());
    });
    await panel.locator('.html-tab-seg button', { hasText: '소스' }).click();
    await expect(panel.locator('.html-file-tab')).toHaveAttribute('data-html-view', 'source');
    const content = panel.locator('.html-tab-source .cm-content');
    await expect(content).toContainText('inline ran v1', { timeout: 15000 });
    await content.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText(PAGE_V2);
    await expect(content).toContainText('inline ran v2');
    await expect(editorWindow(page)).toHaveAttribute('data-dirty', 'true', { timeout: 10000 });

    await panel.locator('.html-tab-seg button', { hasText: '렌더링' }).click();
    await expect(panel.locator('.html-tab-unsaved')).toBeVisible();
    await expect(panel.locator('.html-tab-unsaved')).toContainText('저장하지 않은 수정을 보여 주는 중');
    // The draft runs under the route, so its inline script and relative files still work.
    await expect(frame.locator('#inline')).toHaveText('inline ran v2', { timeout: 15000 });
    await expect(frame.locator('#external')).toHaveText('external ran');
    expect(drafts.length, 'the unsaved text went to the server as a draft').toBeGreaterThan(0);
    expect(readFileSync(joinPath(record.folder!, 'site', 'page.html'), 'utf8'), 'nothing written before the save').toBe(PAGE_V1);
    await page.screenshot({ path: '../.playwright-mcp/e2e-html-viewer-unsaved.png' });

    await panel.locator('.html-tab-seg button', { hasText: '소스' }).click();
    await content.click();
    await page.keyboard.press('Control+s');
    await expect(editorWindow(page)).not.toHaveAttribute('data-dirty', 'true', { timeout: 10000 });
    await expect.poll(() => readFileSync(joinPath(record.folder!, 'site', 'page.html'), 'utf8'), { timeout: 10000 }).toBe(PAGE_V2);
    await panel.locator('.html-tab-seg button', { hasText: '렌더링' }).click();
    await expect(panel.locator('.html-tab-unsaved')).toHaveCount(0);
    await expect(frame.locator('#inline')).toHaveText('inline ran v2', { timeout: 15000 });
    expect(await panel.locator('iframe.html-tab-frame').getAttribute('src'), 'the saved file, not a draft').not.toMatch(/[?&]draft=/);
  });

  // FR-MDE-028 AC-8; SEC-MDE-002 AC-5
  test('desktop: the resource list shows what loaded, what is missing and what was blocked', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop');
    const panel = await openSitePage(page);
    const frame = frameOf(page, 'page.html');
    await expect(frame.locator('#env-here')).toHaveText('status:403', { timeout: 15000 });

    const button = panel.locator('.html-tab-resources');
    await expect(button).toHaveText(/실패 [1-9]/, { timeout: 15000 });
    await expect(button).toHaveClass(/has-fail/);
    await button.click();
    const list = panel.locator('.html-tab-resource-panel');
    await expect(list).toBeVisible();
    const entry = (name: string) => list.locator('li').filter({ has: page.locator('span', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) });
    await expect(entry('site/css/missing.css').locator('em')).toHaveClass(/html-resource-not-found/);
    await expect(entry('site/css/style.css').locator('em')).toHaveClass(/html-resource-loaded/);
    await expect(entry('site/js/app.js').locator('em')).toHaveClass(/html-resource-loaded/);
    await expect(entry('.env').locator('em')).toHaveClass(/html-resource-blocked/);
    await page.screenshot({ path: '../.playwright-mcp/e2e-html-viewer-resources.png' });
  });

  // SEC-MDE-002 AC-1..AC-4, AC-7; FR-MDE-028 AC-7 (the token URL in a tab of its own)
  test('the token route: sandbox CSP on every response, a hidden folder page loads its own files, revoke ends it', async ({ request, context }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'route checks run once');
    const issued = await request.post(`${ORIGIN}/api/sessions/${record.workSessionId}/files/html-view`, {
      headers: authHeaders(record.token!), data: { path: '.buildergate/mcp-docs/hidden-page.html' },
    });
    expect(issued.status(), await issued.text()).toBe(200);
    const { token, url, baseUrl } = await issued.json() as { token: string; url: string; baseUrl: string };
    expect(url).toBe(`/api/html-view/${token}/.buildergate/mcp-docs/hidden-page.html`);
    expect(baseUrl).toBe(`/api/html-view/${token}/.buildergate/mcp-docs/`);

    const expectSandboxed = (headers: Record<string, string>, what: string) => {
      const csp = headers['content-security-policy'] ?? '';
      expect(csp, `${what}: CSP sandbox`).toMatch(/(^|;)\s*sandbox\b/);
      expect(csp, `${what}: no same-origin`).not.toContain('allow-same-origin');
      expect(headers['x-content-type-options'], what).toBe('nosniff');
      expect(headers['cache-control'], what).toContain('no-store');
    };
    // No Authorization header: the token alone opens it.
    const pageResponse = await request.get(`${ORIGIN}${url}`, { headers: {} });
    expect(pageResponse.status()).toBe(200);
    expectSandboxed(pageResponse.headers(), 'page');
    const sibling = await request.get(`${ORIGIN}${baseUrl}mcp.css`);
    expect(sibling.status(), 'a page in a hidden folder loads its own folder').toBe(200);
    expect(sibling.headers()['content-type']).toMatch(/^text\/css/);
    const hidden = await request.get(`${ORIGIN}/api/html-view/${token}/.env`);
    expect(hidden.status(), 'a hidden file elsewhere is refused').toBe(403);
    expectSandboxed(hidden.headers(), 'refusal');
    const missing = await request.get(`${ORIGIN}${baseUrl}none.css`);
    expect(missing.status()).toBe(404);
    expectSandboxed(missing.headers(), 'not found');

    // Opened as a tab of its own, the document still runs sandboxed in an opaque origin.
    const tab = await context.newPage();
    try {
      const response = await tab.goto(`${ORIGIN}${url}`);
      expect(response?.status()).toBe(200);
      expectSandboxed(await response!.allHeaders(), 'tab');
      await expect(tab.locator('#h')).toHaveText('hidden page ran', { timeout: 10000 });
      expect(await tab.evaluate(() => self.origin)).toBe('null');
      await expect.poll(() => tab.locator('#h').evaluate(node => getComputedStyle(node).color)).toBe(STYLED_COLOR);
      await tab.screenshot({ path: '../.playwright-mcp/e2e-html-viewer-token-tab.png' });
    } finally {
      await tab.close();
    }

    const revoked = await request.delete(`${ORIGIN}/api/html-view/${token}`, { headers: authHeaders(record.token!) });
    expect(revoked.status()).toBe(204);
    const after = await request.get(`${ORIGIN}${url}`);
    expect(after.status(), 'a revoked token serves nothing').toBe(404);
  });

  // FR-MCP-013
  test('MCP open_html saves HTML text and opens it rendered', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop');
    test.skip(!MCP_URL || !MCP_KEY, 'BUILDERGATE_E2E_MCP_URL and BUILDERGATE_E2E_MCP_KEY are not set');
    const mcp = new McpClient();
    await mcp.connect();
    const marker = `mcp-html-${randomUUID().slice(0, 8)}`;
    const html = MCP_DOC(marker);
    const opened = await mcp.call('buildergate.editor.open_html', { terminalId: record.workTabId, html, title: 'E2E Html' });
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, kind: 'html', view: 'rendered', created: true, terminalId: record.workTabId });
    const filePath = String(opened.filePath);
    expect(filePath.startsWith(joinPath(record.folder!, '.buildergate', 'mcp-docs')), filePath).toBe(true);
    expect(readFileSync(filePath, 'utf8'), 'the saved file holds the text').toBe(html);

    const name = filePath.split(/[\\/]/).pop()!;
    const panel = panelFor(page, name);
    await expect(panel.locator('.html-file-tab')).toHaveAttribute('data-html-view', 'rendered', { timeout: 15000 });
    const frame = frameOf(page, name);
    await expect(frame.locator('#mcp')).toHaveText(marker, { timeout: 15000 });
    // Saved in the hidden mcp-docs folder, it still loads its sibling stylesheet.
    await expect.poll(() => frame.locator('#mcp').evaluate(node => getComputedStyle(node).color), { timeout: 10000 }).toBe(STYLED_COLOR);

    expect((await mcp.call('buildergate.editor.open_html', { terminalId: record.workTabId, filePath: 'site/page.html', view: 'source' })).ok).toBe(true);
    await expect(panelFor(page, 'page.html').locator('.html-file-tab')).toHaveAttribute('data-html-view', 'source', { timeout: 15000 });
    expect((await mcp.call('buildergate.editor.open_html', { terminalId: record.workTabId, html, content: 'x' })).code).toBe('VALIDATION_ERROR');
    expect((await mcp.call('buildergate.editor.open_html', { terminalId: record.workTabId, filePath: 'anchor.txt' })).code).toBe('VALIDATION_ERROR');
    await page.screenshot({ path: '../.playwright-mcp/e2e-html-viewer-mcp.png' });
  });

  // FR-MDE-028 AC-9 (phone)
  test('phone: the toggle fills the toolbar and the page renders', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project), 'phone');
    await openExplorer(page, true);
    // FR-FEX-020: a 1.5 s hold opens the row, as a double tap does.
    await explorerRow(page, 'phone.html').evaluate(async (element) => {
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      const x = rect.left + Math.min(60, rect.width / 2);
      const y = rect.top + rect.height / 2;
      const touch = { identifier: 1, target: element, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 0.5 } as unknown as Touch;
      const dispatch = (type: string, touches: Touch[]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: touches, configurable: true });
        Object.defineProperty(event, 'targetTouches', { value: touches, configurable: true });
        Object.defineProperty(event, 'changedTouches', { value: [touch], configurable: true });
        element.dispatchEvent(event);
      };
      dispatch('touchstart', [touch]);
      await new Promise(resolve => setTimeout(resolve, 1700));
      dispatch('touchend', []);
    });
    const panel = page.locator(`.editor-document-panel[data-document-id$="phone.html"]`);
    await expect(panel.locator('.html-file-tab')).toHaveAttribute('data-html-view', 'rendered', { timeout: 15000 });
    const buttons = panel.locator('.html-tab-seg button');
    await expect(buttons).toHaveText(['렌더링', '소스']);
    for (const button of await buttons.all()) await expect(button).toBeVisible();
    const seg = await panel.locator('.html-tab-seg').boundingBox();
    const bar = await panel.locator('.html-tab-toolbar').boundingBox();
    expect(seg && bar && seg.width >= bar.width * 0.85, `toggle ${seg?.width} of toolbar ${bar?.width}`).toBe(true);
    await expect(panel.frameLocator('iframe.html-tab-frame').locator('#phone')).toHaveText('phone ran', { timeout: 15000 });
    await page.screenshot({ path: '../.playwright-mcp/e2e-html-viewer-phone.png' });

    await buttons.filter({ hasText: '소스' }).tap();
    await expect(panel.locator('.html-file-tab')).toHaveAttribute('data-html-view', 'source');
    await expect(panel.locator('.html-tab-source .cm-content')).toContainText('phone ran');
  });
});
