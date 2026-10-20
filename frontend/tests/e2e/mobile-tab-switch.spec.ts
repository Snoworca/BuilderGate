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
});
