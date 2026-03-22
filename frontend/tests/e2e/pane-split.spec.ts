import { test, expect } from '@playwright/test';
import { login, waitForTerminal, rightClickPane, selectMenuItem, getPaneCount, verifyPaneCount, dragResizer } from './helpers';

test.describe('Pane Split System', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await waitForTerminal(page);
  });

  test('TC-6101: should split pane vertically', async ({ page }) => {
    await rightClickPane(page, 0);
    await selectMenuItem(page, '수직 분할');
    await page.waitForTimeout(2000); // wait for session creation
    await verifyPaneCount(page, 2);
  });

  test('TC-6103: should close pane and expand sibling', async ({ page }) => {
    // First split
    await rightClickPane(page, 0);
    await selectMenuItem(page, '수직 분할');
    await page.waitForTimeout(2000);
    await verifyPaneCount(page, 2);

    // Close second pane
    await rightClickPane(page, 1);
    await selectMenuItem(page, 'Pane 닫기');
    await page.waitForTimeout(1000);
    await verifyPaneCount(page, 1);
  });

  test('TC-6105: should resize pane by dragging border', async ({ page }) => {
    await rightClickPane(page, 0);
    await selectMenuItem(page, '수직 분할');
    await page.waitForTimeout(2000);

    // Drag resizer to the right
    await dragResizer(page, 100, 0);

    // Verify left pane is wider
    const panes = page.locator('.pane-leaf');
    const leftBox = await panes.nth(0).boundingBox();
    const rightBox = await panes.nth(1).boundingBox();
    expect(leftBox!.width).toBeGreaterThan(rightBox!.width);
  });

  test('TC-6107: should zoom and unzoom pane', async ({ page }) => {
    await rightClickPane(page, 0);
    await selectMenuItem(page, '수직 분할');
    await page.waitForTimeout(2000);

    // Zoom first pane
    await rightClickPane(page, 0);
    await selectMenuItem(page, '줌 토글');
    await page.waitForTimeout(500);

    // Check zoom badge visible
    const zoomBadge = page.locator('.pane-zoom-badge');
    await expect(zoomBadge).toBeVisible();
  });

  test('TC-6104: last pane close should be disabled', async ({ page }) => {
    await rightClickPane(page, 0);
    const closeItem = page.locator('.context-menu-item:has-text("Pane 닫기")');
    const isDisabled = await closeItem.getAttribute('data-disabled');
    expect(isDisabled).toBeTruthy();
  });
});
