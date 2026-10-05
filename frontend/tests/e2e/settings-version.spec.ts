// FR-ARCH-007: the settings page shows the running BuilderGate version.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { login } from './helpers';

const ROOT_PACKAGE = fileURLToPath(new URL('../../../package.json', import.meta.url));

test('FR-ARCH-007: the settings page shows the release version', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
  const version = (JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')) as { version: string }).version;
  await login(page);
  await page.locator('button[title="설정"]').click();
  const settings = page.locator('.settings-page');
  await expect(settings).toBeVisible({ timeout: 15_000 });
  await expect(settings.locator('.settings-version')).toHaveText(`BuilderGate v${version}`);
  await page.screenshot({ path: '../.playwright-mcp/settings-version.png' });
});
