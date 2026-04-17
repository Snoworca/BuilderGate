import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('Settings 2FA QR refresh', () => {
  test('TC-7301: saving account name should refresh the TOTP QR URI immediately', async ({ page }) => {
    await login(page);

    await page.getByTitle('Settings').click();
    await expect(page.getByRole('heading', { name: 'Runtime Settings' })).toBeVisible();

    const saveButton = page.getByTestId('settings-save-button');
    const enabledCheckbox = page.getByTestId('twofactor-enabled');
    const accountNameInput = page.getByTestId('twofactor-account-name');
    const qrUri = page.getByTestId('totp-qr-uri');
    const qrDisabled = page.getByTestId('totp-qr-disabled');

    const originalEnabled = await enabledCheckbox.isChecked();
    const originalAccountName = await accountNameInput.inputValue();
    const nextAccountName = `admin-${Date.now()}`;

    try {
      if (!originalEnabled) {
        await enabledCheckbox.check();
      }

      await accountNameInput.fill(nextAccountName);
      await saveButton.click();

      await expect(qrUri).toBeVisible({ timeout: 15000 });
      await expect(qrUri).toContainText(nextAccountName, { timeout: 15000 });
    } finally {
      if (!page.isClosed()) {
        const visible = await accountNameInput.isVisible().catch(() => false);
        if (visible) {
          await accountNameInput.fill(originalAccountName);

          if (originalEnabled) {
            await enabledCheckbox.check();
          } else {
            await enabledCheckbox.uncheck();
          }

          const restorable = await saveButton.isEnabled().catch(() => false);
          if (restorable) {
            await saveButton.click();
            await expect(saveButton).toBeDisabled({ timeout: 5000 });
            await expect(saveButton).toHaveText('Save Settings', { timeout: 15000 });
            if (originalEnabled) {
              await expect(qrUri).toContainText(originalAccountName, { timeout: 15000 });
            } else {
              await expect(qrDisabled).toBeVisible({ timeout: 15000 });
            }
          }
        }
      }
    }
  });
});
