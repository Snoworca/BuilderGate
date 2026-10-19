import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// REL-BGSTAB-047 (#145): switching tab -> grid left TUIs drawn halfway down, and a reload
// showed the same, because the server skips a resize to the size the PTY already has. The
// program inside must be told its size again: a one-row shrink and a restore, which the
// pty-size reporter sees as two 'resize' events ending at the xterm's size.

const ORIGIN = 'https://localhost:2222';
const REPORTER = fileURLToPath(new URL('./fixtures/pty-size-reporter.mjs', import.meta.url));

function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}
function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

async function reported(page: Page, sessionId: string): Promise<{ view: string | null; events: string[] }> {
  return page.evaluate((id) => {
    const debug = window.__buildergateTerminalDebug;
    const lengths = debug?.captureTerminalBufferLengths?.(id) ?? null;
    const text = debug?.captureTerminalText?.(id) ?? '';
    return {
      view: lengths ? `${lengths.cols}x${lengths.rows}` : null,
      events: [...text.matchAll(/PTYSIZE (\d+x\d+)/g)].map((m) => m[1]),
    };
  }, sessionId);
}

test.describe('grid redraw nudge', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, isMobile: false });

  test('REL-BGSTAB-047: tab -> grid tells every grid program its size again with a one-row shrink and restore', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
    test.setTimeout(180_000);
    const ownerId = `grid-redraw-nudge/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    const headers = { Authorization: `Bearer ${token}` };
    const name = `e2e-nudge-${randomUUID().slice(0, 6)}`;
    const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
    const tabsOf = async () => ((await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as {
      tabs: Array<{ id: string; workspaceId: string; sessionId: string }>;
    }).tabs.filter((t) => t.workspaceId === ws.id);
    if ((await tabsOf()).length < 2) {
      expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: 'n2' } })).status()).toBe(201);
    }
    await request.patch(`${ORIGIN}/api/workspaces/${ws.id}`, { headers, data: { viewMode: 'grid' } });
    const tabs = await tabsOf();

    await page.reload();
    await page.waitForSelector('.workspace-screen');
    await page.locator('.workspace-item', { hasText: name }).first().click();
    await page.waitForTimeout(2000);
    for (const tab of tabs) await sendVisibleTerminalCommand(page, `node "${hostPath(REPORTER)}"`, { sessionId: tab.sessionId });
    for (const tab of tabs) {
      await expect.poll(async () => (await reported(page, tab.sessionId)).events.length, { timeout: 20_000 }).toBeGreaterThan(0);
    }

    const toggle = page.locator('.header-view-toggle-button');
    await toggle.click(); // to tab
    await page.waitForTimeout(1500);
    const before = new Map<string, number>();
    for (const tab of tabs) before.set(tab.sessionId, (await reported(page, tab.sessionId)).events.length);
    await toggle.click(); // back to grid
    await page.waitForTimeout(3000);

    for (const tab of tabs) {
      const { view, events } = await reported(page, tab.sessionId);
      const fresh = events.slice(before.get(tab.sessionId) ?? 0);
      console.log(`${tab.sessionId.slice(0, 8)} view=${view} events after grid=${fresh.join(',')}`);
      expect(view, 'the xterm has a size').not.toBeNull();
      expect(fresh.at(-1), 'the program ends at the xterm size').toBe(view);
      const [cols, rows] = view!.split('x').map(Number);
      expect(fresh, 'the program saw the one-row shrink').toContain(`${cols}x${rows - 1}`);
    }
  });
});
