// REL-BGSTAB-049 (#155) and PERF-BGSTAB-024 (#156), on 2222: a terminal tab revealed on a
// phone is repainted after it becomes visible, and a tab switch shows before the server saves it.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const tab = (page: Page, name: string) => page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first();

async function press(page: Page, name: string, phone: boolean): Promise<void> {
  if (phone) await tab(page, name).tap(); else await tab(page, name).click();
}

test.describe('terminal tab switching', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`mobile-tab-switch/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-tabsw', { 'x.txt': 'x\n' });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // REL-BGSTAB-049 AC-1/AC-2
  test('a revealed tab is repainted after it becomes visible', async ({ page }, testInfo) => {
    const phone = testInfo.project.use.isMobile === true;
    await page.evaluate(() => (window as unknown as { __buildergateTerminalDebug?: { enable(): void } }).__buildergateTerminalDebug?.enable());
    for (let round = 0; round < 3; round += 1) {
      await press(page, 'e2e-tabsw-base', phone);
      await expect(tab(page, 'e2e-tabsw-base')).toHaveAttribute('aria-selected', 'true');
      await press(page, 'e2e-tabsw-work', phone);
      await expect(tab(page, 'e2e-tabsw-work')).toHaveAttribute('aria-selected', 'true');
    }
    const sessionId = record.workSessionId!;
    await expect.poll(() => page.evaluate((id) => {
      const debug = (window as unknown as { __buildergateTerminalDebug?: { getEvents(id: string): { kind?: string; event?: string; type?: string; name?: string }[] } }).__buildergateTerminalDebug;
      return (debug?.getEvents(id) ?? []).filter((event) => JSON.stringify(event).includes('reveal_settle_repaint')).length;
    }, sessionId), { timeout: 5000 }).toBeGreaterThanOrEqual(3);
    await page.screenshot({ path: `../.playwright-mcp/e2e-tab-reveal-${phone ? 'phone' : 'desktop'}.png` });
  });

  // PERF-BGSTAB-024 AC-1/AC-2
  test('a tab switch shows before the server saves it, and quick taps end on the last tab', async ({ page }, testInfo) => {
    const phone = testInfo.project.use.isMobile === true;
    const saved: string[] = [];
    // Every save of the workspace waits 3 s, as on a slow mobile link.
    await page.route(`**/api/workspaces/${record.workspaceId}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const body = route.request().postDataJSON() as { activeTabId?: string };
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (body.activeTabId) saved.push(body.activeTabId);
      await route.continue();
    });
    const started = Date.now();
    await press(page, 'e2e-tabsw-base', phone);
    await expect(tab(page, 'e2e-tabsw-base')).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
    const shownAfter = Date.now() - started;
    console.log(`tab shown after ${shownAfter} ms while the save takes 3000 ms`);
    expect(shownAfter).toBeLessThan(1500);
    // Quick taps: the screen ends on the last one, and so does the server.
    await press(page, 'e2e-tabsw-work', phone);
    await press(page, 'e2e-tabsw-base', phone);
    await press(page, 'e2e-tabsw-work', phone);
    await expect(tab(page, 'e2e-tabsw-work')).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
    await expect.poll(() => saved.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(3500);
    expect(saved[saved.length - 1], `saves in order: ${saved.join(', ')}`).toBe(record.workTabId);
    expect(saved.length, 'superseded selections are not sent').toBeLessThanOrEqual(3);
    await page.unroute(`**/api/workspaces/${record.workspaceId}`);
  });
});
