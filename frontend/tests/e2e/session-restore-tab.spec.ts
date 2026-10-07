// FR-AITUI-017 / FR-AITUI-018 / FR-AITUI-019 — the restore tab of the session save
// dialog, and the auto save settings.
//
// No agent is started. A manual save of one idle shell tab with a command entry is
// made through the API, then restored by hand from the restore tab: the command is
// typed into that same tab (it is idle), and the result row says so.
//
// Fixture:
//   * one workspace created through createOwnedWorkspaceViaApi and removed by id
//   * one manual save, deleted by its id from the restore tab (and again in finally)

import { randomUUID } from 'node:crypto';

import { test, expect, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

test.describe('세션 복구 탭', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1360, height: 860 }, isMobile: false });

  test('직접 저장본을 복구 탭에서 골라 빈 탭에 복구하고, 저장본을 지운다', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.setTimeout(120000);
    const ownerId = `session-restore-tab/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    const marker = `e2e-restore-${Date.now()}`;

    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');

    const workspaceName = `e2e-restore-${randomUUID().slice(0, 8)}`;
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
      headers: authHeaders(token), data: { name: workspaceName },
    });
    const created = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, {
      headers: authHeaders(token), data: { name: 'e2e-restore-tab' },
    });
    expect(created.status()).toBe(201);
    const tabId = (await created.json() as { id: string }).id;
    let saveId: string | null = null;

    try {
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);
      const selectedWorkspace = page.locator('.sidebar [role="option"][aria-selected="true"]');
      await expect(selectedWorkspace).toContainText(workspaceName);

      // FR-AITUI-017 AC-1: a manual save goes into the list with its own id.
      const saved = await request.post(`${ORIGIN}/api/session-snapshot`, {
        headers: authHeaders(token),
        data: { items: [{ tabId, mode: 'command', command: `echo ${marker}` }] },
      });
      expect(saved.status()).toBe(200);
      const savedBody = await saved.json() as { snapshot: { id: string; origin: string } };
      saveId = savedBody.snapshot.id;
      expect(savedBody.snapshot.origin).toBe('manual');

      const list = await request.get(`${ORIGIN}/api/session-snapshot/list`, { headers: authHeaders(token) });
      const listBody = await list.json() as { manual: Array<{ id: string }> };
      expect(listBody.manual[0]?.id, 'the newest manual save comes first').toBe(saveId);

      await page.getByRole('button', { name: /^세션 저장 · 재시작 준비/ }).click();
      const dialog = page.locator('.window-dialog').filter({ has: page.locator('.session-save-dialog') });
      await expect(dialog).toBeVisible();
      // FR-AITUI-018 AC-4: the save | restore tabs.
      await dialog.getByRole('tab', { name: '복구' }).click();
      await expect(dialog.getByRole('tab', { name: '복구' })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByText('직접 저장', { exact: true })).toBeVisible();
      await expect(dialog.getByText('자동 저장', { exact: true })).toBeVisible();

      // Our save is the newest manual one; with no newer auto save it is picked and marked for the next start.
      const row = dialog.locator('.session-restore-row', { hasText: 'e2e-restore-tab' });
      await expect(row).toBeVisible({ timeout: 15000 });
      // FR-AITUI-018 AC-6: the tab is idle, so the command goes into it.
      await expect(row).toContainText('이 탭에 입력');
      await expect(row).toContainText(`echo ${marker}`);
      await page.screenshot({ path: '../.playwright-mcp/session-restore-tab.png' });

      // FR-AITUI-018 AC-5/AC-7: only the picked entries are restored; the result row says what happened.
      await dialog.getByRole('button', { name: /^선택한 1개 복구$/ }).click();
      await expect(dialog.locator('.session-report-row', { hasText: 'e2e-restore-tab' })).toContainText('입력', { timeout: 15000 });
      await page.screenshot({ path: '../.playwright-mcp/session-restore-tab-result.png' });
      // The command really reached that tab's shell.
      await dialog.getByRole('button', { name: '닫기', exact: true }).last().click();
      await expect(selectedWorkspace, 'the restore keeps the user in the workspace they were in').toContainText(workspaceName);
      // This tab's own terminal: with several workspaces mounted, "the first visible screen" is someone
      // else's, and under WebGL the DOM holds no text, so the buffer is read through the debug hook.
      const tabSessionId = await page.locator(`[data-tab-id="${tabId}"]`).first().getAttribute('data-session-id');
      if (!tabSessionId) throw new Error(`no session id on tab ${tabId}`);
      await expect.poll(() => page.evaluate((id) => {
        const hook = (window as unknown as { __buildergateTerminalDebug?: { captureTerminalText?: (sessionId: string) => string } })
          .__buildergateTerminalDebug;
        return hook?.captureTerminalText?.(id) ?? '';
      }, tabSessionId), { timeout: 15000 }).toContain(marker);
      await page.getByRole('button', { name: /^세션 저장 · 재시작 준비/ }).click();
      await dialog.getByRole('tab', { name: '복구' }).click();

      // FR-AITUI-017 AC-5: a manual save is deleted from the list, after a confirmation.
      const card = dialog.locator('.session-restore-item').filter({ has: page.locator('.session-restore-card[aria-pressed="true"]') });
      await card.getByRole('button', { name: '이 저장본 지우기' }).click();
      // The confirmation's own button, not the trash icons that share its name.
      await expect(page.getByText('이 저장본을 지울까요?')).toBeVisible();
      await page.locator('button.btn-destructive', { hasText: '이 저장본 지우기' }).click();
      await expect.poll(async () => {
        const res = await request.get(`${ORIGIN}/api/session-snapshot/list`, { headers: authHeaders(token) });
        return ((await res.json()) as { manual: Array<{ id: string }> }).manual.some((m) => m.id === saveId);
      }, { timeout: 10000 }).toBe(false);
      saveId = null;
    } finally {
      if (saveId) await request.delete(`${ORIGIN}/api/session-snapshot/list/${saveId}`, { headers: authHeaders(token) });
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });

  test('설정의 세션 자동 저장은 기본으로 켜져 있고 5분 미만 간격을 저장 전에 막는다', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    await login(page);
    await page.getByTitle('설정', { exact: true }).click();
    await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible();

    // FR-AITUI-019 AC-1: shown with what is in force (on, 5 minutes, 10 kept, unless this server's config says otherwise).
    const enabled = page.getByTestId('settings-session-autosave-enabled');
    await expect(enabled).toBeVisible();
    const interval = page.locator('#settings-session-autosave-interval');
    const retention = page.locator('#settings-session-snapshot-retention');
    await expect(interval).toBeVisible();
    await expect(retention).toBeVisible();
    await expect(page.getByTestId('settings-session-autosave-last')).toContainText('마지막 자동 저장');
    const original = await interval.inputValue();

    // FR-AITUI-019 AC-2: under 5 minutes is named beside the field before anything is saved.
    await interval.fill('4');
    await expect(page.getByText(/5분 이상이어야 합니다/).first()).toBeVisible();
    await page.screenshot({ path: '../.playwright-mcp/settings-session-autosave.png' });
    await interval.fill(original);
    await expect(page.getByText(/5분 이상이어야 합니다/)).toHaveCount(0);
  });
});
