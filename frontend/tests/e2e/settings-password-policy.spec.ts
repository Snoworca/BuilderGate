import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

function createSettingsSnapshot() {
  const immediateCapability = { applyScope: 'immediate', available: true, writeOnly: false };
  const newLoginCapability = { applyScope: 'new_logins', available: true, writeOnly: false };
  const authPasswordCapability = { applyScope: 'new_logins', available: true, writeOnly: true };
  const disabledImmediateCapability = { applyScope: 'immediate', available: false, writeOnly: false };

  return {
    values: {
      auth: {
        durationMs: 1800000,
      },
      twoFactor: {
        enabled: false,
        externalOnly: false,
        issuer: 'BuilderGate',
        accountName: 'admin',
      },
      security: {
        cors: {
          allowedOrigins: [],
          credentials: false,
          maxAge: 86400,
        },
      },
      pty: {
        termName: 'xterm-256color',
        defaultCols: 120,
        defaultRows: 30,
        useConpty: false,
        windowsPowerShellBackend: 'inherit',
        shell: 'auto',
      },
      session: {
        idleDelayMs: 500,
      },
      fileManager: {
        maxFileSize: 1048576,
        maxDirectoryEntries: 10000,
        blockedExtensions: ['.exe'],
        blockedPaths: ['.ssh'],
        cwdCacheTtlMs: 1000,
      },
    },
    capabilities: {
      'auth.password': authPasswordCapability,
      'auth.durationMs': newLoginCapability,
      'twoFactor.externalOnly': newLoginCapability,
      'twoFactor.enabled': newLoginCapability,
      'twoFactor.issuer': newLoginCapability,
      'twoFactor.accountName': newLoginCapability,
      'security.cors.allowedOrigins': immediateCapability,
      'security.cors.credentials': immediateCapability,
      'security.cors.maxAge': immediateCapability,
      'pty.termName': newLoginCapability,
      'pty.defaultCols': newLoginCapability,
      'pty.defaultRows': newLoginCapability,
      'pty.useConpty': disabledImmediateCapability,
      'pty.windowsPowerShellBackend': {
        ...disabledImmediateCapability,
        options: ['inherit', 'conpty', 'winpty'],
      },
      'pty.shell': {
        ...newLoginCapability,
        options: ['auto', 'powershell', 'cmd'],
      },
      'session.idleDelayMs': newLoginCapability,
      'fileManager.maxFileSize': immediateCapability,
      'fileManager.maxDirectoryEntries': immediateCapability,
      'fileManager.blockedExtensions': immediateCapability,
      'fileManager.blockedPaths': immediateCapability,
      'fileManager.cwdCacheTtlMs': immediateCapability,
    },
    secretState: {
      authPasswordConfigured: true,
      smtpPasswordConfigured: false,
    },
    excludedSections: [],
  };
}

async function mockAuthenticatedSettingsApp(page: Page, onSettingsPatch: (body: unknown) => void) {
  const settingsSnapshot = createSettingsSnapshot();

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

  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        token: 'settings-password-policy-token',
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

  await page.route('**/api/auth/totp-qr', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dataUrl: '',
        uri: '',
        registered: false,
      }),
    });
  });

  await page.route('**/api/settings', async (route) => {
    if (route.request().method() === 'PATCH') {
      onSettingsPatch(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...settingsSnapshot,
          changedKeys: ['auth.password'],
          applySummary: {
            immediate: [],
            new_logins: ['auth.password'],
            new_sessions: [],
            warnings: [],
          },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(settingsSnapshot),
    });
  });
}

test.describe('Settings password policy', () => {
  test('TC-2401: password rotation enforces FR-AUTH-015 in the browser and submits exact max-length input', async ({ page }) => {
    let submittedPatch: {
      auth?: {
        currentPassword?: string;
        newPassword?: string;
        confirmPassword?: string;
      };
    } | null = null;

    await mockAuthenticatedSettingsApp(page, (body) => {
      submittedPatch = body as typeof submittedPatch;
    });

    await page.goto('/');
    await page.fill('input[type="password"]', '1234');
    await page.click('button[type="submit"]');
    await expect(page.locator('.workspace-screen')).toBeVisible({ timeout: 10000 });

    await page.getByTitle('Settings').click();
    await expect(page.getByRole('heading', { name: 'Runtime Settings' })).toBeVisible();

    const authenticationCard = page.locator('.settings-card').filter({
      has: page.getByRole('heading', { name: 'Authentication' }),
    });
    const passwordInputs = authenticationCard.locator('input[type="password"]');
    const currentPassword = passwordInputs.nth(0);
    const newPassword = passwordInputs.nth(1);
    const confirmPassword = passwordInputs.nth(2);
    const saveButton = page.getByTestId('settings-save-button');
    const policyMessage = 'Password must be 4 to 128 characters';

    await currentPassword.fill('1234');

    for (const invalidPassword of ['abc', 'abcd ', 'Password?1', 'A'.repeat(129)]) {
      await newPassword.fill(invalidPassword);
      await confirmPassword.fill(invalidPassword);

      await expect(saveButton).toBeDisabled();
      await expect(page.locator('.settings-banner-error')).toContainText(policyMessage);
      expect(submittedPatch).toBeNull();
    }

    const maxLengthPassword = 'Aa1!'.repeat(32);
    await newPassword.fill(maxLengthPassword);
    await confirmPassword.fill(maxLengthPassword);
    await expect(saveButton).toBeEnabled();

    await saveButton.click();
    await expect(page.locator('.settings-banner-success')).toContainText('next login 1');

    expect(submittedPatch?.auth?.currentPassword).toBe('1234');
    expect(submittedPatch?.auth?.newPassword).toBe(maxLengthPassword);
    expect(submittedPatch?.auth?.confirmPassword).toBe(maxLengthPassword);
  });
});
