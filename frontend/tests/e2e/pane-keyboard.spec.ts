import { test, expect } from '@playwright/test';
import { login, waitForTerminal, pressCtrlB, verifyPaneCount } from './helpers';

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await waitForTerminal(page);
  });

  test('TC-6601: Ctrl+B enters prefix mode', async ({ page }) => {
    await pressCtrlB(page);
    const prefix = page.locator('.status-prefix');
    await expect(prefix).toBeVisible({ timeout: 2000 });
  });

  test('TC-6606: prefix mode auto-exits after 1500ms', async ({ page }) => {
    await pressCtrlB(page);
    await expect(page.locator('.status-prefix')).toBeVisible();
    await page.waitForTimeout(1600);
    await expect(page.locator('.status-prefix')).not.toBeVisible();
  });

  test('TC-6602: Ctrl+B, % splits vertically', async ({ page }) => {
    await pressCtrlB(page);
    await page.keyboard.press('Shift+5'); // %
    await page.waitForTimeout(2000);
    await verifyPaneCount(page, 2);
  });
});
