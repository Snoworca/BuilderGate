import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { deleteOwnedWorkspace, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

// FR-AITUI-015 AC-7. Reported 2026-10-03: the "restored after restart" banner came back on
// every reload after it was closed, because the dismissal lived only in component state while
// the server keeps returning the same report until the next restart.
// Needs RESTORE_RESTART_CMD: a Windows command that restarts the 2222 server of this checkout.

const ORIGIN = 'https://localhost:2222';
const RESTART = process.env.RESTORE_RESTART_CMD ?? '';

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

async function restartServer(request: APIRequestContext): Promise<void> {
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
async function saveFailingSnapshot(request: APIRequestContext, page: Page, ownerId: string): Promise<void> {
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
}

test.describe('Restore report banner', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, isMobile: false });

  test('a closed report stays closed after a reload, and the next restart reports again', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
    test.skip(!RESTART, 'RESTORE_RESTART_CMD is required');
    test.setTimeout(600_000);
    const ownerId = `restore-report-dismiss/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    const banner = page.locator('.session-restore-banner');

    await login(page);
    await saveFailingSnapshot(request, page, ownerId);
    await restartServer(request);
    await openAfterRestart(page);
    await expect(banner, 'the restart produced a report').toBeVisible({ timeout: 30_000 });
    const first = await (await request.get(`${ORIGIN}/api/session-snapshot`, {
      headers: { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('cws_auth_token'))}` },
    })).json() as { reportId: string | null };
    console.log(`reportId ${first.reportId}`);
    expect(first.reportId).toBeTruthy();

    await banner.getByRole('button').last().click();
    await expect(banner).toBeHidden();
    for (let i = 0; i < 2; i += 1) {
      await page.reload();
      await page.waitForSelector('.workspace-screen');
      await page.waitForTimeout(4000); // the status is fetched after load
      await expect(banner, `reload ${i + 1}: the closed report must not come back`).toBeHidden();
    }

    // The next restart restores a newer snapshot: a new report shows again.
    await saveFailingSnapshot(request, page, ownerId);
    await restartServer(request);
    await openAfterRestart(page);
    await expect(banner, 'a new restart reports again').toBeVisible({ timeout: 30_000 });
    await banner.getByRole('button').last().click();
  });
});
