import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function mockWorkspaceShellResponses(page: Page) {
  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [],
        tabs: [],
        gridLayouts: [],
      }),
    });
  });

  await page.route('**/api/sessions/shells', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

test.describe('Initial password bootstrap', () => {
  test('TC-2301: allowed bootstrap flow renders setup form, blocks mismatch, and enters the app after success', async ({ page }) => {
    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          requesterAllowed: true,
          allowPolicy: 'localhost',
        }),
      });
    });

    await page.route('**/api/auth/bootstrap-password', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          token: 'bootstrap-token',
          expiresIn: 1800000,
        }),
      });
    });

    await page.route('**/api/workspaces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspaces: [],
          tabs: [],
          gridLayouts: [],
        }),
      });
    });

    await page.route('**/api/sessions/shells', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Initial Admin Password' })).toBeVisible();
    await expect(page.getByText('Set the administrator password for this BuilderGate instance.')).toBeVisible();

    await page.fill('#bootstrap-password', 'boot');
    await page.fill('#bootstrap-password-confirm', 'different');
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('Password confirmation does not match.');

    await page.fill('#bootstrap-password-confirm', 'boot');
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeEnabled();

    await page.click('button[type="submit"]');
    await expect(page.locator('.workspace-screen')).toBeVisible({ timeout: 10000 });

    const storedToken = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    expect(storedToken).toBe('bootstrap-token');
  });

  test('TC-2305: password setup enforces policy and submits exact max-length input without trimming or truncation', async ({ page }) => {
    let submittedBody: { password?: string; confirmPassword?: string } | null = null;

    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          requesterAllowed: true,
          allowPolicy: 'localhost',
        }),
      });
    });

    await page.route('**/api/auth/bootstrap-password', async (route) => {
      submittedBody = route.request().postDataJSON() as { password?: string; confirmPassword?: string };
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          token: 'bootstrap-token',
          expiresIn: 1800000,
        }),
      });
    });

    await mockWorkspaceShellResponses(page);

    await page.goto('/');

    await page.fill('#bootstrap-password', 'abc');
    await page.fill('#bootstrap-password-confirm', 'abc');
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('Password must be 4 to 128 characters');

    await page.fill('#bootstrap-password', 'abcd ');
    await page.fill('#bootstrap-password-confirm', 'abcd ');
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('may only contain English letters');

    await page.fill('#bootstrap-password', 'Password?1');
    await page.fill('#bootstrap-password-confirm', 'Password?1');
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('may only contain English letters');

    await page.fill('#bootstrap-password', 'A'.repeat(129));
    await page.fill('#bootstrap-password-confirm', 'A'.repeat(129));
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('Password must be 4 to 128 characters');
    expect(submittedBody).toBeNull();

    const longPassword = 'Aa1!'.repeat(32);
    await page.fill('#bootstrap-password', longPassword);
    await page.fill('#bootstrap-password-confirm', longPassword);
    await expect(page.getByRole('button', { name: 'Set Password' })).toBeEnabled();

    await page.click('button[type="submit"]');
    await expect(page.locator('.workspace-screen')).toBeVisible({ timeout: 10000 });

    expect(submittedBody?.password).toBe(longPassword);
    expect(submittedBody?.confirmPassword).toBe(longPassword);
  });

  test('TC-2306: bootstrap token storage evicts old terminal snapshots after quota failure', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'terminal_snapshot_old-quota-test',
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'old-quota-test',
          content: 'old snapshot',
          savedAt: '2020-01-01T00:00:00.000Z',
        }),
      );
      localStorage.setItem(
        'terminal_snapshot_new-quota-test',
        JSON.stringify({
          schemaVersion: 1,
          sessionId: 'new-quota-test',
          content: 'new snapshot',
          savedAt: '2026-04-29T00:00:00.000Z',
        }),
      );

      const originalSetItem = Storage.prototype.setItem;
      let tokenAttempts = 0;
      Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
        if (this === window.localStorage && key === 'cws_auth_token' && tokenAttempts === 0) {
          tokenAttempts += 1;
          throw new DOMException('synthetic quota exceeded', 'QuotaExceededError');
        }
        return originalSetItem.call(this, key, value);
      };
    });

    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          requesterAllowed: true,
          allowPolicy: 'localhost',
        }),
      });
    });

    await page.route('**/api/auth/bootstrap-password', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          token: 'bootstrap-token-after-quota',
          expiresIn: 1800000,
        }),
      });
    });

    await mockWorkspaceShellResponses(page);

    await page.goto('/');
    await page.fill('#bootstrap-password', 'boot');
    await page.fill('#bootstrap-password-confirm', 'boot');
    await page.click('button[type="submit"]');
    await expect(page.locator('.workspace-screen')).toBeVisible({ timeout: 10000 });

    const storageState = await page.evaluate(() => ({
      token: localStorage.getItem('cws_auth_token'),
      expires: localStorage.getItem('cws_auth_expires'),
      oldSnapshot: localStorage.getItem('terminal_snapshot_old-quota-test'),
      newSnapshot: localStorage.getItem('terminal_snapshot_new-quota-test'),
    }));
    expect(storageState.token).toBe('bootstrap-token-after-quota');
    expect(storageState.expires).not.toBeNull();
    expect(storageState.oldSnapshot).toBeNull();
    expect(storageState.newSnapshot).not.toBeNull();
  });

  test('TC-2307: bootstrap token storage clears partial auth state when quota retry cannot recover', async ({ page }) => {
    await page.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
        if (this === window.localStorage && key === 'cws_auth_expires') {
          throw new DOMException('synthetic quota exceeded', 'QuotaExceededError');
        }
        return originalSetItem.call(this, key, value);
      };
    });

    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          requesterAllowed: true,
          allowPolicy: 'localhost',
        }),
      });
    });

    await page.route('**/api/auth/bootstrap-password', async (route) => {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          token: 'partial-token',
          expiresIn: 1800000,
        }),
      });
    });

    await page.goto('/');
    await page.fill('#bootstrap-password', 'boot');
    await page.fill('#bootstrap-password-confirm', 'boot');
    await page.click('button[type="submit"]');

    await expect(page.getByRole('alert')).toContainText(/quota/i);
    const storageState = await page.evaluate(() => ({
      token: localStorage.getItem('cws_auth_token'),
      expires: localStorage.getItem('cws_auth_expires'),
    }));
    expect(storageState.token).toBeNull();
    expect(storageState.expires).toBeNull();
  });

  test('TC-2302: denied bootstrap requester sees a restricted setup notice instead of the password form', async ({ page }) => {
    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          requesterAllowed: false,
          allowPolicy: 'denied',
        }),
      });
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Initial Setup Restricted' })).toBeVisible();
    await expect(page.getByText('Initial password setup is only allowed from localhost or an explicitly allowed IP address.')).toBeVisible();
    await expect(page.locator('#bootstrap-password')).toHaveCount(0);
  });

  test('TC-2303: configured instance falls back to the standard login form', async ({ page }) => {
    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: false,
          requesterAllowed: false,
          allowPolicy: 'configured',
        }),
      });
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'BuilderGate' })).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Login' })).toBeVisible();
  });

  test('TC-2304: stale local token is cleared when the server returns setup-required again', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('cws_auth_token', 'stale-token');
      localStorage.setItem('cws_auth_expires', String(Date.now() + 60_000));
    });

    await page.route('**/api/auth/bootstrap-status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          setupRequired: true,
          requesterAllowed: true,
          allowPolicy: 'localhost',
        }),
      });
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Initial Admin Password' })).toBeVisible();

    const storedToken = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    expect(storedToken).toBeNull();
  });
});
