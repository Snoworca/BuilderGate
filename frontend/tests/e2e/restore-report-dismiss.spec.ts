import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { deleteOwnedWorkspace, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

// FR-AITUI-018 AC-1..AC-3 (superseding FR-AITUI-015 AC-7). Reported 2026-10-03: the "restored
// after restart" banner came back on every reload, because the dismissal lived only in component
// state. Since 2026-10-08 the server records that a restore's notice was shown, so no reload,
// reconnect or other browser shows it again; every start restores the newer of the newest manual
// save and the auto save.
// Needs RESTORE_RESTART_CMD: a Windows command that restarts the 2222 server of this checkout.
// The auto save part waits for one auto save cycle (5 minutes at the shortest setting).

const ORIGIN = 'https://localhost:2222';
const RESTART = process.env.RESTORE_RESTART_CMD ?? '';

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

async function restartServer(request: APIRequestContext, page: Page): Promise<void> {
  // No client may be connected across the restart: an open page polls the status every 15 s, and
  // the first client to see a restore's report shows its notice and records it (FR-AITUI-018
  // AC-3). A page left open could take the notice before the test reopens the app -- measured
  // 2026-10-11: the reopened page then rightly showed nothing.
  await page.goto('about:blank');
  console.log(execFileSync('cmd.exe', ['/c', RESTART], { encoding: 'utf8' }).trim());
  await expect.poll(async () => (await request.get(`${ORIGIN}/health`).catch(() => null))?.ok() ?? false, { timeout: 120_000 }).toBe(true);
}

/** After a restart the stored token may still be valid; log in only when asked to. */
async function openAfterRestart(page: Page): Promise<void> {
  await page.goto('/');
  const password = page.locator('input[type="password"]');
  await Promise.race([
    password.waitFor({ timeout: 30_000 }).catch(() => undefined),
    page.waitForSelector('.workspace-screen', { timeout: 30_000 }).catch(() => undefined),
  ]);
  if (await password.isVisible()) await login(page);
  await page.waitForSelector('.workspace-screen');
}

/**
 * Saves a snapshot whose only entry is a tab that is then deleted, so the next restart
 * reports one failure and the banner does not go away on its own.
 */
async function saveFailingSnapshot(request: APIRequestContext, page: Page, ownerId: string): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
    headers, data: { name: `e2e-restore-report-${randomUUID().slice(0, 6)}` },
  });
  expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: 'saved' } })).status()).toBe(201);
  const state = await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json() as { tabs: Array<{ id: string; workspaceId: string }> };
  const tab = state.tabs.find((t) => t.workspaceId === ws.id);
  if (!tab) throw new Error('E2E precondition failed: the new workspace has no tab');
  const saved = await request.post(`${ORIGIN}/api/session-snapshot`, { headers, data: { items: [{ tabId: tab.id, mode: 'command', command: 'echo restore-report-e2e' }] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await deleteOwnedWorkspace({ ...registryOptions(), ownerId, workspaceId: ws.id });
  return ((await saved.json()) as { snapshot: { id: string } }).snapshot.id;
}

interface StatusBody {
  reportId: string | null;
  reportNoticeShown: boolean;
  reportSource: { origin: 'manual' | 'auto'; id: string; savedAt: string } | null;
  autoSave: { lastAt: string | null };
}

async function readStatus(request: APIRequestContext, page: Page): Promise<StatusBody> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  return await (await request.get(`${ORIGIN}/api/session-snapshot`, { headers: { Authorization: `Bearer ${token}` } })).json() as StatusBody;
}

test.describe('Restore report banner', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, isMobile: false });

  test('a shown report never shows again, and each restart restores the newer save — the auto save too', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
    test.skip(!RESTART, 'RESTORE_RESTART_CMD is required');
    test.setTimeout(1_200_000);
    const ownerId = `restore-report-dismiss/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    const banner = page.locator('.session-restore-banner');
    const savedIds: string[] = [];

    try {
      await login(page);
      savedIds.push(await saveFailingSnapshot(request, page, ownerId));
      await restartServer(request, page);
      const restartedAt = Date.now();
      await openAfterRestart(page);
      await expect(banner, 'the restart produced a report').toBeVisible({ timeout: 30_000 });
      // FR-AITUI-018 AC-1/AC-2: the newest save (the manual one just made) was restored, and the report says so.
      await expect.poll(async () => (await readStatus(request, page)).reportNoticeShown, { timeout: 10_000 }).toBe(true);
      const first = await readStatus(request, page);
      console.log(`reportId ${first.reportId} source ${JSON.stringify(first.reportSource)}`);
      expect(first.reportSource).toMatchObject({ origin: 'manual', id: savedIds[0] });
      await expect(banner).toContainText('직접 저장본에서 복구');

      // FR-AITUI-018 AC-3: shown once, it never shows again: not after reloads, even unclosed ...
      for (let i = 0; i < 2; i += 1) {
        await page.reload();
        await page.waitForSelector('.workspace-screen');
        await page.waitForTimeout(4000); // the status is fetched after load
        await expect(banner, `reload ${i + 1}: the shown report must not come back`).toBeHidden();
      }
      // ... and not in a client that keeps no browser state at all, as another browser would be:
      // storage cleared, a fresh page, a fresh login. Only the server's record can stop the notice.
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      const otherPage = await page.context().newPage();
      try {
        await login(otherPage);
        await otherPage.waitForTimeout(4000);
        await expect(otherPage.locator('.session-restore-banner'), 'a client with no browser state: the shown report must not come back').toBeHidden();
      } finally {
        await otherPage.close();
      }

      // FR-AITUI-016 / FR-AITUI-018 AC-1: once an auto save runs after that start, it is the newest
      // save, and the next restart restores it.
      await expect.poll(async () => {
        const lastAt = (await readStatus(request, page)).autoSave.lastAt;
        return lastAt !== null && Date.parse(lastAt) > restartedAt;
      }, { timeout: 480_000, intervals: [10_000] }).toBe(true);
      await restartServer(request, page);
      await openAfterRestart(page);
      await expect(banner, 'a new restart reports again').toBeVisible({ timeout: 30_000 });
      const second = await readStatus(request, page);
      console.log(`reportId ${second.reportId} source ${JSON.stringify(second.reportSource)}`);
      expect(second.reportId).not.toBe(first.reportId);
      expect(second.reportSource?.origin, 'the auto save was newer than every manual save').toBe('auto');
      await expect(banner).toContainText('자동 저장본에서 복구');
      await page.screenshot({ path: '../.playwright-mcp/restore-report-from-autosave.png' });
      await banner.getByRole('button').last().click();
    } finally {
      const token = await page.evaluate(() => localStorage.getItem('cws_auth_token')).catch(() => null);
      for (const id of savedIds) {
        if (token) await request.delete(`${ORIGIN}/api/session-snapshot/list/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      }
    }
  });
});
