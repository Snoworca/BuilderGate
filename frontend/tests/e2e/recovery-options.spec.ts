import { test, expect } from '@playwright/test';
import {
  clearRecoveryOptionsForE2E,
  createRecoveryOptionViaApi,
  ensureDefaultRecoveryOptionsForE2E,
  login,
  openRecoveryOptionDialog,
  readRecoveryOptionsViaApi,
} from './helpers';

const RECOVERY_OPTIONS_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';

test.describe('Recovery Options Dialog', () => {
  test.use({
    baseURL: RECOVERY_OPTIONS_BASE_URL,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    isMobile: false,
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== '' && testInfo.project.name !== 'Desktop Chrome',
      'Desktop-only recovery option coverage',
    );
    await login(page);
    await clearRecoveryOptionsForE2E(page);
    await ensureDefaultRecoveryOptionsForE2E(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== '' && testInfo.project.name !== 'Desktop Chrome') return;
    await clearRecoveryOptionsForE2E(page);
    await ensureDefaultRecoveryOptionsForE2E(page);
  });

  test('opens from desktop Tools menu and validates a blank add form', async ({ page }) => {
    expect(new URL(page.url()).origin).toBe(new URL(RECOVERY_OPTIONS_BASE_URL).origin);

    await page.locator('button[title="Tools"]').click();
    await expect(page.locator('.context-menu-item:has-text("복구 옵션")')).toBeVisible();
    await page.locator('.context-menu-item:has-text("복구 옵션")').click();

    const dialog = page.getByTestId('recovery-option-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '추가' }).click();

    const createForm = dialog.locator('form.command-preset-form');
    const commandInput = createForm.getByLabel(/명령|커맨드|command/i);
    await expect(commandInput).toHaveValue('');
    await createForm.getByRole('button', { name: /저장|등록/ }).click();
    await expect(dialog.getByRole('alert').first()).toContainText(/명령|command/i);
  });

  test('saves empty arguments as an empty array and repeatedly deletes Claude/Codex like normal rows', async ({ page }) => {
    await openRecoveryOptionDialog(page);

    const stamp = Date.now();
    const command = `e2e-recovery-empty-args-${stamp}`;
    const dialog = page.getByTestId('recovery-option-dialog');

    await dialog.getByRole('button', { name: '추가' }).click();
    const createForm = dialog.locator('form.command-preset-form');
    await createForm.getByLabel(/명령|커맨드|command/i).fill(command);
    await expect(createForm.getByLabel(/인수|arguments?/i)).toHaveValue('');
    await createForm.getByRole('button', { name: /저장|등록/ }).click();
    await expect(dialog.getByText(command)).toBeVisible();

    const created = (await readRecoveryOptionsViaApi(page)).find(option => option.command === command);
    expect(created?.arguments).toEqual([]);

    for (const defaultCommand of ['claude', 'codex'] as const) {
      const options = await readRecoveryOptionsViaApi(page);
      expect(options.some(option => option.command === defaultCommand), `expected ${defaultCommand} default recovery option`).toBe(true);

      await dialog.getByLabel(`${defaultCommand} 삭제`, { exact: true }).click();
      await page.getByRole('button', { name: 'OK' }).click();
      await expect(dialog.getByRole('heading', { name: defaultCommand, exact: true })).toHaveCount(0);
      expect((await readRecoveryOptionsViaApi(page)).some(option => option.command === defaultCommand)).toBe(false);
    }

    await page.locator('.window-dialog-close').click();
    await ensureDefaultRecoveryOptionsForE2E(page);
    await openRecoveryOptionDialog(page);
    const restoredDialog = page.getByTestId('recovery-option-dialog');
    await expect(restoredDialog.getByRole('heading', { name: 'claude', exact: true })).toBeVisible();
    await expect(restoredDialog.getByRole('heading', { name: 'codex', exact: true })).toBeVisible();
    await page.locator('.window-dialog-close').click();
  });

  test('renders safe icon data and displays markup script and URL rejection paths', async ({ page }) => {
    const stamp = Date.now();
    const safeCommand = `e2e-recovery-icon-safe-${stamp}`;
    const rejectedCommand = `e2e-recovery-icon-reject-${stamp}`;

    await openRecoveryOptionDialog(page);

    await createRecoveryOptionViaApi(page, {
      command: safeCommand,
      arguments: [],
      icon: { type: 'text', value: 'AI' },
    });
    await page.locator('.window-dialog-close').click();
    await openRecoveryOptionDialog(page);
    const dialog = page.getByTestId('recovery-option-dialog');
    const safeRow = dialog.locator('.recovery-option-row, [data-testid="recovery-option-row"]').filter({ hasText: safeCommand });
    await expect(safeRow).toBeVisible();
    await expect(safeRow.getByText('AI')).toBeVisible();
    await expect(safeRow.locator('img, svg, script')).toHaveCount(0);

    await dialog.getByRole('button', { name: '추가' }).click();
    const createForm = dialog.locator('form.command-preset-form');
    await createForm.getByLabel(/명령|커맨드|command/i).fill(rejectedCommand);
    await createForm.getByLabel(/아이콘|icon/i).fill('<svg onload="alert(1)">');
    await createForm.getByRole('button', { name: /저장|등록/ }).click();
    await expect(dialog.getByRole('alert').first()).toContainText(/아이콘|icon|validation|invalid|거부/i);
    await expect(dialog.getByText(rejectedCommand)).toHaveCount(0);

    for (const value of ['<script>alert(1)</script>', 'https://example.invalid/icon.svg', 'x" style="color:red']) {
      const response = await page.evaluate(async (input) => {
        const token = localStorage.getItem('cws_auth_token');
        const res = await fetch('/api/recovery-options', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            command: `${input.commandPrefix}-${Date.now()}`,
            arguments: [],
            icon: { type: 'text', value: input.iconValue },
          }),
        });
        return { ok: res.ok, status: res.status, body: await res.text() };
      }, { commandPrefix: rejectedCommand, iconValue: value });

      expect(response.ok, response.body).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});
