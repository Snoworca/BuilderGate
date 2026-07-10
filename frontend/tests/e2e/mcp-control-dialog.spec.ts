import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

const MCP_CONTROL_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';

test.describe('MCP Control Dialog', () => {
  test.use({
    baseURL: MCP_CONTROL_BASE_URL,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    isMobile: false,
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== '' && testInfo.project.name !== 'Desktop Chrome',
      'Desktop-only MCP control dialog coverage',
    );
    await login(page);
    await waitForTerminal(page);
  });

  async function openMcpControlDialog(page: Page) {
    await page.locator('button[title="Tools"]').click();
    await expect(page.locator('.context-menu-item:has-text("MCP 설정")')).toBeVisible();
    await page.locator('.context-menu-item:has-text("MCP 설정")').click();

    const dialog = page.getByTestId('mcp-control-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('opens from desktop Tools menu and exposes Security whitelist settings', async ({ page }) => {
    const dialog = await openMcpControlDialog(page);

    await expect(dialog.getByRole('tab', { name: 'Security' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel(/외부 IP\/CIDR whitelist/i)).toBeVisible();
    await expect(dialog.getByLabel(/Trusted proxies/i)).toBeVisible();
    await expect(dialog.getByLabel(/Allowed origins/i)).toBeVisible();
    await expect(dialog.getByLabel(/Webhook header/i)).toBeVisible();
    await expect(dialog.getByLabel(/Webhook rate window seconds/i)).toBeVisible();
    await expect(dialog.getByLabel(/Webhook burst limit/i)).toBeVisible();

    await dialog.getByRole('tab', { name: 'Sessions' }).click();
    await expect(dialog.getByLabel(/Reply test prompt/i)).toHaveValue('Hello, World!');
  });

  test('blocks unsafe whitelist config before saving', async ({ page }) => {
    const dialog = await openMcpControlDialog(page);

    await dialog.getByLabel(/Bind mode/i).selectOption('whitelist');
    await dialog.getByLabel(/외부 IP\/CIDR whitelist/i).fill('0.0.0.0/0');
    await dialog.getByRole('button', { name: '저장' }).click();

    await expect(dialog.getByRole('alert')).toContainText('0.0.0.0/0');
  });

  test('blocks invalid whitelist security contract states before saving', async ({ page }) => {
    const dialog = await openMcpControlDialog(page);

    await dialog.getByLabel(/Bind mode/i).selectOption('loopback');
    await dialog.getByLabel(/^Host$/i).fill('0.0.0.0');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/Loopback|127/i);

    await dialog.getByLabel(/^Host$/i).fill('127.0.0.1');
    await dialog.getByLabel(/Bind mode/i).selectOption('whitelist');
    await dialog.getByLabel(/외부 IP\/CIDR whitelist/i).fill('not-a-cidr');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/CIDR|IPv4/i);

    await dialog.getByLabel(/외부 IP\/CIDR whitelist/i).fill('203.0.113.7/32');
    await dialog.getByLabel(/Transport security/i).selectOption('none');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/transport|TLS/i);

    await dialog.getByLabel(/Transport security/i).selectOption('trusted_tls_proxy');
    await dialog.getByLabel(/Trusted proxies/i).fill('');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/Trusted proxies/i);
  });
});
