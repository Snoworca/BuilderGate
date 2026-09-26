// FR-UIDS-005 — the terminal context menu draws a shared icon on every item,
// the file explorer included, and each workspace row carries an activity dot.
//
// Fixture: one workspace with one tab, created through createOwnedWorkspaceViaApi
// and removed by id.

import { randomUUID } from 'node:crypto';

import { test, expect, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

test.describe('터미널 메뉴 아이콘과 Workspace 활동 점', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('메뉴 항목마다 아이콘이 있고 Workspace 행마다 상태 점이 있다', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    const ownerId = `workspace-dot-menu-icons/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;

    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const workspaceName = `e2e-dot-${randomUUID().slice(0, 8)}`;
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name: workspaceName } });

    try {
      const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: 'e2e-dot-tab' } });
      expect(createdTab.status()).toBe(201);
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });

      // FR-UIDS-003 AC-1: the list heading is the English product term.
      await expect(page.locator('.workspace-sidebar-title')).toHaveText('Workspaces');

      // AC-2/AC-3: every row has a dot left of the name that says its state in words.
      const row = page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first();
      const dot = row.locator('.workspace-item-dot');
      await expect(dot).toHaveCount(1);
      await expect(dot).toHaveAttribute('aria-label', /^(대기|실행 중)$/);
      const dotBox = await dot.boundingBox();
      const nameBox = await row.locator('.workspace-item-name').boundingBox();
      expect(dotBox && nameBox && dotBox.x < nameBox.x).toBe(true);
      expect(Math.round(dotBox!.width)).toBe(8);
      const rows = page.locator('.sidebar [role="option"]');
      await expect(rows.locator('.workspace-item-dot')).toHaveCount(await rows.count());

      await row.click();
      await waitForTerminal(page);

      // AC-1: the terminal menu, the file explorer entry included, draws shared icons.
      await page.locator('.terminal-view:visible .xterm-screen').first().click({ button: 'right' });
      const menu = page.locator('.context-menu').last();
      await expect(menu).toBeVisible();
      for (const label of ['새 세션', '세션 닫기', 'Workspace 이동', '파일 탐색기 열기', '복사', '붙여넣기']) {
        const item = menu.locator('.context-menu-item', { hasText: label }).first();
        await expect(item, label).toBeVisible();
        await expect(item.locator('.context-menu-icon svg'), `${label} draws an icon`).toHaveCount(1);
      }
      await page.screenshot({ path: '../.playwright-mcp/workspace-dot-menu-icons.png' });
      await page.keyboard.press('Escape');
    } finally {
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});
