// FR-UIDS-006 — deleting a workspace shows a loading state in the confirmation
// until the server answers; the dialog closes and the row leaves the list in the
// same moment. A failure keeps the dialog open with the reason. Supersedes the
// optimistic-removal checks of PERF-BGSTAB-015 AC-2/AC-3 that lived here.
//
// Fixture: per test one workspace created through createOwnedWorkspaceViaApi,
// with the tabs the test names. A test that lets the real DELETE through leaves
// nothing for the cleanup (it finds the workspace absent, which it accepts); a
// test whose DELETE is answered in the browser leaves the workspace on the
// server and the cleanup removes it by id.

import { randomUUID } from 'node:crypto';

import { test, expect, createOwnedWorkspaceViaApi, type APIRequestContext } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';
import type { Page } from '@playwright/test';

const ORIGIN = 'https://localhost:2222';

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  workspaceName: string;
}

async function openWithWorkspace(page: Page, request: APIRequestContext, testId: string, tabNames: string[]): Promise<Fixture> {
  const ownerId = `workspace-delete-loading/${testId}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('login left no auth token');
  const headers = { Authorization: `Bearer ${token}` };
  const workspaceName = `e2e-del-${randomUUID().slice(0, 8)}`;
  const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name: workspaceName } });
  for (const name of tabNames) {
    const created = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name } });
    expect(created.status()).toBe(201);
  }
  await page.reload();
  await page.waitForSelector('.workspace-screen', { timeout: 15000 });
  return { ownerId, workspaceId: workspace.id, workspaceName };
}

async function cleanup(ownerId: string): Promise<void> {
  const result = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
  if (result.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(result.failed)}`);
}

function rowOf(page: Page, workspaceName: string) {
  return page.locator('.sidebar [role="option"]', { hasText: workspaceName });
}

async function askToDelete(page: Page, workspaceName: string): Promise<void> {
  await rowOf(page, workspaceName).click({ button: 'right' });
  await page.locator('.context-menu').last().locator('.context-menu-item', { hasText: '삭제' }).click();
}

/** Records, in the page's own clock, when the busy label appears, the dialog goes and the row goes. */
async function watchDeleteMoments(page: Page, workspaceName: string): Promise<void> {
  await page.evaluate((name) => {
    const moments: Record<string, number> = {};
    (window as unknown as { __deleteMoments: Record<string, number> }).__deleteMoments = moments;
    const check = () => {
      const now = performance.now();
      if (moments.busyShown === undefined && document.querySelector('.ui-busy-label[data-busy="true"]')) moments.busyShown = now;
      if (moments.busyShown !== undefined && moments.dialogGone === undefined && !document.querySelector('[role="alertdialog"]')) moments.dialogGone = now;
      const rowPresent = Array.from(document.querySelectorAll('.sidebar [role="option"]')).some(el => el.textContent?.includes(name));
      if (moments.rowGone === undefined && !rowPresent) moments.rowGone = now;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, attributes: true });
  }, workspaceName);
}

async function readDeleteMoments(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (window as unknown as { __deleteMoments: Record<string, number> }).__deleteMoments);
}

test.describe('Workspace 삭제 진행 표시', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
  });

  test('E1: 삭제를 누르면 로딩이 보이고, 로딩이 사라지는 순간 목록에서 빠진다', async ({ page, request }, testInfo) => {
    const fixture = await openWithWorkspace(page, request, testInfo.testId, ['e2e-del-tab-1', 'e2e-del-tab-2', 'e2e-del-tab-3']);
    try {
      const row = rowOf(page, fixture.workspaceName);
      await expect(row).toHaveCount(1);
      // Let the shells start, so the delete has live process trees to close.
      await page.waitForTimeout(3000);

      await askToDelete(page, fixture.workspaceName);
      const dialog = page.getByRole('alertdialog', { name: 'Workspace 삭제' });
      await expect(dialog).toContainText('터미널 3개가 모두 종료됩니다');
      await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused();
      await watchDeleteMoments(page, fixture.workspaceName);

      const deleted = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/workspaces/${fixture.workspaceId}`));
      await dialog.getByRole('button', { name: '모두 삭제' }).click();

      // AC-1: the loading state, with the workspace still listed.
      const busyButton = dialog.getByRole('button', { name: '삭제하는 중…' });
      await expect(busyButton).toBeVisible({ timeout: 500 });
      await expect(busyButton).toHaveAttribute('aria-disabled', 'true');
      await expect(dialog.getByRole('button', { name: '취소' })).toBeDisabled();
      await expect(dialog).toContainText('터미널 3개를 종료하고 있습니다. 보통 몇 초 안에 끝납니다.');
      await expect(row).toHaveCount(1);
      await page.screenshot({ path: '../.playwright-mcp/workspace-delete-loading-busy.png' });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();

      const response = await deleted;
      await expect(dialog).toHaveCount(0, { timeout: 5000 });
      await expect(row).toHaveCount(0);
      const moments = await readDeleteMoments(page);
      console.log(`[workspace-delete-loading] E1 status=${response.status()} moments=${JSON.stringify(moments)}`);

      expect(response.status()).toBe(200);
      // AC-2: the dialog and the row go together.
      expect(Math.abs(moments.dialogGone - moments.rowGone)).toBeLessThanOrEqual(50);
      expect(moments.dialogGone - moments.busyShown).toBeGreaterThanOrEqual(450);
    } finally {
      await cleanup(fixture.ownerId);
    }
  });

  test('E2: 서버가 실패하면 창에 이유와 다시 시도가 나오고 Workspace는 그대로다', async ({ page, request }, testInfo) => {
    const fixture = await openWithWorkspace(page, request, testInfo.testId, ['e2e-keep-tab-1', 'e2e-keep-tab-2']);
    try {
      const row = rowOf(page, fixture.workspaceName);
      await row.click();
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await page.route(`**/api/workspaces/${fixture.workspaceId}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await new Promise(resolve => setTimeout(resolve, 1500));
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SAVE_FAILED', message: 'refused by the test' } }) });
      });

      await askToDelete(page, fixture.workspaceName);
      const dialog = page.getByRole('alertdialog', { name: 'Workspace 삭제' });
      await dialog.getByRole('button', { name: '모두 삭제' }).click();
      await expect(dialog.getByRole('button', { name: '삭제하는 중…' })).toBeVisible();
      await expect(row).toHaveCount(1);

      // AC-3
      await expect(dialog.getByRole('alert')).toContainText('Workspace를 삭제하지 못했습니다. 일부 터미널은 이미 종료되었을 수 있습니다.', { timeout: 5000 });
      await expect(dialog.getByRole('alert')).toContainText('원인: refused by the test');
      await expect(dialog.getByRole('button', { name: '다시 시도' })).toBeVisible();
      await page.screenshot({ path: '../.playwright-mcp/workspace-delete-loading-error.png' });
      await expect(row).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('.workspace-screen')).toContainText('e2e-keep-tab-1');
      await expect(page.locator('.workspace-screen')).toContainText('e2e-keep-tab-2');

      await dialog.getByRole('button', { name: '닫기' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row).toHaveCount(1);
      await page.unroute(`**/api/workspaces/${fixture.workspaceId}`);
    } finally {
      await cleanup(fixture.ownerId);
    }
  });

  test('E3: 진행 중에 다시 눌러도 삭제 요청은 한 번만 간다', async ({ page, request }, testInfo) => {
    const fixture = await openWithWorkspace(page, request, testInfo.testId, ['e2e-del-tab-1']);
    try {
      let deleteRequests = 0;
      page.on('request', r => {
        if (r.method() === 'DELETE' && r.url().endsWith(`/api/workspaces/${fixture.workspaceId}`)) deleteRequests += 1;
      });
      await page.route(`**/api/workspaces/${fixture.workspaceId}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await new Promise(resolve => setTimeout(resolve, 1000));
        return route.continue();
      });

      await askToDelete(page, fixture.workspaceName);
      const dialog = page.getByRole('alertdialog', { name: 'Workspace 삭제' });
      await dialog.getByRole('button', { name: '모두 삭제' }).dblclick();
      for (let i = 0; i < 3; i += 1) await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0, { timeout: 10000 });
      console.log(`[workspace-delete-loading] E3 deleteRequests=${deleteRequests}`);
      expect(deleteRequests).toBe(1);
      await expect(rowOf(page, fixture.workspaceName)).toHaveCount(0);
    } finally {
      await cleanup(fixture.ownerId);
    }
  });

  test('E4: 서버가 바로 답해도 로딩은 최소 0.5초 보인다', async ({ page, request }, testInfo) => {
    const fixture = await openWithWorkspace(page, request, testInfo.testId, ['e2e-del-tab-1']);
    try {
      await page.route(`**/api/workspaces/${fixture.workspaceId}`, route => (
        route.request().method() === 'DELETE'
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
          : route.continue()
      ));
      await askToDelete(page, fixture.workspaceName);
      const dialog = page.getByRole('alertdialog', { name: 'Workspace 삭제' });
      await watchDeleteMoments(page, fixture.workspaceName);
      await dialog.getByRole('button', { name: '모두 삭제' }).click();
      await expect(dialog).toHaveCount(0, { timeout: 5000 });
      const moments = await readDeleteMoments(page);
      console.log(`[workspace-delete-loading] E4 moments=${JSON.stringify(moments)}`);
      expect(moments.dialogGone - moments.busyShown).toBeGreaterThanOrEqual(450);
      await page.unroute(`**/api/workspaces/${fixture.workspaceId}`);
    } finally {
      await cleanup(fixture.ownerId);
    }
  });

  test('E5: 마지막 Workspace라서 거절되면 닫기만 남는다', async ({ page, request }, testInfo) => {
    const fixture = await openWithWorkspace(page, request, testInfo.testId, ['e2e-del-tab-1']);
    try {
      await page.route(`**/api/workspaces/${fixture.workspaceId}`, route => (
        route.request().method() === 'DELETE'
          ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'LAST_WORKSPACE', message: 'Cannot delete the last workspace' } }) })
          : route.continue()
      ));
      await askToDelete(page, fixture.workspaceName);
      const dialog = page.getByRole('alertdialog', { name: 'Workspace 삭제' });
      await dialog.getByRole('button', { name: '모두 삭제' }).click();
      await expect(dialog.getByRole('alert')).toContainText('마지막 Workspace는 삭제할 수 없습니다.', { timeout: 5000 });
      await expect(dialog.getByRole('button', { name: '다시 시도' })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '닫기' })).toBeFocused();
      await dialog.getByRole('button', { name: '닫기' }).click();
      await expect(rowOf(page, fixture.workspaceName)).toHaveCount(1);
      await page.unroute(`**/api/workspaces/${fixture.workspaceId}`);
    } finally {
      await cleanup(fixture.ownerId);
    }
  });

  test('E6: 터미널이 없는 Workspace는 창 없이, 서버가 답하면 목록에서 빠진다', async ({ page, request }, testInfo) => {
    const fixture = await openWithWorkspace(page, request, testInfo.testId, []);
    try {
      await page.route(`**/api/workspaces/${fixture.workspaceId}`, async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await new Promise(resolve => setTimeout(resolve, 800));
        return route.continue();
      });
      const row = rowOf(page, fixture.workspaceName);
      await askToDelete(page, fixture.workspaceName);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveCount(0, { timeout: 5000 });
    } finally {
      await cleanup(fixture.ownerId);
    }
  });
});
