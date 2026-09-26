// PERF-BGSTAB-015 AC-1..AC-3 — deleting a workspace with several terminals does
// not make the user wait: the dialog closes and the row leaves the list before
// the server has closed the terminals, the server closes them side by side, and
// a refused delete puts everything back.
//
// Fixture: per test one workspace (three or two tabs) created through
// createOwnedWorkspaceViaApi. The first test deletes it through the UI and the
// cleanup then finds it absent (404), which the owned-workspace helper accepts;
// in the second the browser refuses the delete and the cleanup removes it by id.

import { randomUUID } from 'node:crypto';

import { test, expect, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

const ORIGIN = 'https://localhost:2222';
const TAB_COUNT = 3;

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

test.describe('Workspace 즉시 삭제', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('터미널이 여러 개인 Workspace도 확인하면 곧바로 목록에서 사라진다', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    const ownerId = `workspace-delete-immediate/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;

    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const workspaceName = `e2e-del-${randomUUID().slice(0, 8)}`;
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name: workspaceName } });

    try {
      for (let index = 0; index < TAB_COUNT; index += 1) {
        const created = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: `e2e-del-tab-${index + 1}` } });
        expect(created.status()).toBe(201);
      }
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      const row = page.locator('.sidebar [role="option"]', { hasText: workspaceName });
      await expect(row).toHaveCount(1);
      // Let the shells start, so the delete has live process trees to close.
      await page.waitForTimeout(3000);

      await row.click({ button: 'right' });
      await page.locator('.context-menu').last().locator('.context-menu-item', { hasText: '삭제' }).click();
      const dialog = page.locator('.modal-overlay, [role="dialog"], [role="alertdialog"]').filter({ hasText: 'Workspace 삭제' });
      await expect(dialog).toContainText(`터미널 ${TAB_COUNT}개가 모두 종료됩니다`);

      const deleted = page.waitForResponse(response => (
        response.request().method() === 'DELETE' && response.url().endsWith(`/api/workspaces/${workspace.id}`)
      ));
      const confirmedAt = Date.now();
      await dialog.getByRole('button', { name: '모두 삭제' }).click();
      await expect(row).toHaveCount(0, { timeout: 5000 });
      const goneAt = Date.now();
      const response = await deleted;
      const answeredAt = Date.now();
      const rowGoneMs = goneAt - confirmedAt;
      const serverMs = answeredAt - confirmedAt;
      // Logged before the assertions, so a cleanup failure cannot hide them.
      console.log(`[workspace-delete-immediate] tabs=${TAB_COUNT} rowGoneMs=${rowGoneMs} serverAnsweredMs=${serverMs} status=${response.status()}`);

      expect(response.status()).toBe(200);
      await expect(dialog).toHaveCount(0);
      // AC-2: the row left the list before the server answered.
      expect(goneAt).toBeLessThanOrEqual(answeredAt);
      expect(rowGoneMs).toBeLessThan(1000);
      await page.screenshot({ path: '../.playwright-mcp/workspace-delete-immediate.png' });
    } finally {
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });

  test('서버가 삭제를 거절하면 Workspace와 터미널이 제자리로 돌아온다', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    const ownerId = `workspace-delete-immediate/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;

    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const workspaceName = `e2e-del-${randomUUID().slice(0, 8)}`;
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name: workspaceName } });

    try {
      for (let index = 0; index < 2; index += 1) {
        const created = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: `e2e-keep-tab-${index + 1}` } });
        expect(created.status()).toBe(201);
      }
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      const row = page.locator('.sidebar [role="option"]', { hasText: workspaceName });
      await row.click();
      await expect(row).toHaveAttribute('aria-selected', 'true');

      // The refusal is made in the browser, so the server keeps the workspace
      // and the cleanup below removes it by id. It is held back for a moment so
      // the row is seen to leave first; a row that never left would otherwise
      // pass the "comes back" checks below.
      await page.route(`**/api/workspaces/${workspace.id}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await new Promise(resolve => setTimeout(resolve, 1500));
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'E2E_REFUSED', message: 'refused by the test' } }) });
      });
      await row.click({ button: 'right' });
      await page.locator('.context-menu').last().locator('.context-menu-item', { hasText: '삭제' }).click();
      const dialog = page.locator('.modal-overlay').filter({ hasText: 'Workspace 삭제' });
      await dialog.getByRole('button', { name: '모두 삭제' }).click();
      await expect(row).toHaveCount(0, { timeout: 1000 });

      // AC-3: it comes back in the list, selected again, with its tabs.
      await expect(row).toHaveCount(1, { timeout: 5000 });
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.workspace-screen')).toContainText('e2e-keep-tab-1');
      await expect(page.locator('.workspace-screen')).toContainText('e2e-keep-tab-2');
      await page.unroute(`**/api/workspaces/${workspace.id}`);
    } finally {
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});
