import { expect, test, type Page } from '@playwright/test';

test.describe('Settings resource limits', () => {
  test('renders selected Wave6 fields and saves minimal nested resourceLimits patch', async ({ page }) => {
    let submittedPatch: unknown = null;

    await mockAuthenticatedSettingsApp(page, {
      onSettingsPatch: (body) => {
        submittedPatch = body;
        return {
          status: 200,
          body: {
            ...createSettingsSnapshot({
              headlessPendingOutputMaxBytes: 2_000_000,
              clientInputBackpressureBytes: 3_000_000,
            }),
            changedKeys: [
              'resourceLimits.headless.pendingOutputMaxBytes',
              'resourceLimits.clientWs.inputBackpressureBytes',
            ],
            applySummary: {
              immediate: ['resourceLimits.clientWs.inputBackpressureBytes'],
              new_logins: [],
              new_sessions: ['resourceLimits.headless.pendingOutputMaxBytes'],
              warnings: [],
            },
          },
        };
      },
    });

    await loginAndOpenSettings(page);

    await expect(page.getByRole('heading', { name: 'Server Backpressure' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browser Queues' })).toBeVisible();
    await expect(page.getByTestId('settings-resourceLimits-headless-pendingOutputMaxBytes')).toBeVisible();
    await expect(page.getByTestId('settings-resourceLimits-clientWs-inputBackpressureBytes')).toBeVisible();
    await expect(page.getByTestId('settings-resourceLimits-terminal-visibleOutputQueueMaxBytes')).toHaveCount(0);
    await expect(page.getByTestId('settings-resourceLimits-telemetry-sampleIntervalMs')).toHaveCount(0);

    await page.getByTestId('settings-resourceLimits-headless-pendingOutputMaxBytes').fill('2000000');
    await page.getByTestId('settings-resourceLimits-clientWs-inputBackpressureBytes').fill('3000000');
    await page.getByTestId('settings-save-button').click();

    expect(submittedPatch).toEqual({
      resourceLimits: {
        headless: {
          pendingOutputMaxBytes: 2_000_000,
        },
        clientWs: {
          inputBackpressureBytes: 3_000_000,
        },
      },
    });
    await expect(page.locator('.settings-banner-success')).toContainText('Immediate 1, next login 0, new terminal sessions 1');
  });

  test('renders server validation errors through the existing error banner', async ({ page }) => {
    await mockAuthenticatedSettingsApp(page, {
      onSettingsPatch: () => ({
        status: 400,
        body: {
          error: {
            message: 'hardReconnectBytes must be greater than inputBackpressureBytes',
          },
        },
      }),
    });

    await loginAndOpenSettings(page);

    await page.getByTestId('settings-resourceLimits-clientWs-inputBackpressureBytes').fill('5000000');
    await page.getByTestId('settings-save-button').click();

    await expect(page.locator('.settings-banner-error')).toContainText('hardReconnectBytes must be greater than inputBackpressureBytes');
  });

  test('clears a previous success summary when a later resource save fails', async ({ page }) => {
    let patchCount = 0;

    await mockAuthenticatedSettingsApp(page, {
      onSettingsPatch: () => {
        patchCount += 1;
        if (patchCount === 1) {
          return {
            status: 200,
            body: {
              ...createSettingsSnapshot({
                headlessPendingOutputMaxBytes: 2_000_000,
              }),
              changedKeys: ['resourceLimits.headless.pendingOutputMaxBytes'],
              applySummary: {
                immediate: [],
                new_logins: [],
                new_sessions: ['resourceLimits.headless.pendingOutputMaxBytes'],
                warnings: [],
              },
            },
          };
        }

        return {
          status: 400,
          body: {
            error: {
              message: 'hardReconnectBytes must be greater than inputBackpressureBytes',
            },
          },
        };
      },
    });

    await loginAndOpenSettings(page);

    await page.getByTestId('settings-resourceLimits-headless-pendingOutputMaxBytes').fill('2000000');
    await page.getByTestId('settings-save-button').click();
    await expect(page.locator('.settings-banner-success')).toContainText('new terminal sessions 1');

    await page.getByTestId('settings-resourceLimits-clientWs-inputBackpressureBytes').fill('5000000');
    await page.getByTestId('settings-save-button').click();

    await expect(page.locator('.settings-banner-error')).toContainText('hardReconnectBytes must be greater than inputBackpressureBytes');
    await expect(page.locator('.settings-banner-success')).toHaveCount(0);
  });

  test('clears a previous success summary when a later resource edit is locally invalid', async ({ page }) => {
    await mockAuthenticatedSettingsApp(page, {
      onSettingsPatch: () => ({
        status: 200,
        body: {
          ...createSettingsSnapshot({
            headlessPendingOutputMaxBytes: 2_000_000,
          }),
          changedKeys: ['resourceLimits.headless.pendingOutputMaxBytes'],
          applySummary: {
            immediate: [],
            new_logins: [],
            new_sessions: ['resourceLimits.headless.pendingOutputMaxBytes'],
            warnings: [],
          },
        },
      }),
    });

    await loginAndOpenSettings(page);

    await page.getByTestId('settings-resourceLimits-headless-pendingOutputMaxBytes').fill('2000000');
    await page.getByTestId('settings-save-button').click();
    await expect(page.locator('.settings-banner-success')).toContainText('new terminal sessions 1');

    await page.getByTestId('settings-resourceLimits-headless-pendingOutputMaxBytes').fill('1');

    await expect(page.locator('.settings-banner-error')).toContainText('Headless pending output bytes must be at least 1024.');
    await expect(page.getByTestId('settings-save-button')).toBeDisabled();
    await expect(page.locator('.settings-banner-success')).toHaveCount(0);
  });
});

async function loginAndOpenSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.fill('input[type="password"]', '1234');
  await page.click('button[type="submit"]');
  await expect(page.locator('.workspace-screen')).toBeVisible({ timeout: 10000 });
  await page.getByTitle('Settings').click();
  await expect(page.getByRole('heading', { name: 'Runtime Settings' })).toBeVisible();
}

async function mockAuthenticatedSettingsApp(
  page: Page,
  options: {
    onSettingsPatch: (body: unknown) => { status: number; body: unknown };
  },
): Promise<void> {
  let currentSnapshot = createSettingsSnapshot();

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const fulfillJson = async (status: number, body: unknown) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    };

    if (url.pathname === '/api/auth/bootstrap-status') {
      await fulfillJson(200, {
        setupRequired: false,
        requesterAllowed: false,
        allowPolicy: 'configured',
      });
      return;
    }

    if (url.pathname === '/api/auth/login') {
      await fulfillJson(200, {
        success: true,
        token: 'settings-resource-limits-token',
        expiresIn: 1_800_000,
      });
      return;
    }

    if (url.pathname === '/api/auth/status') {
      await fulfillJson(200, { authenticated: true });
      return;
    }

    if (url.pathname === '/api/auth/refresh') {
      await fulfillJson(200, {
        success: true,
        token: 'settings-resource-limits-token',
        expiresIn: 1_800_000,
      });
      return;
    }

    if (url.pathname === '/api/auth/totp-qr') {
      await fulfillJson(200, {
        dataUrl: '',
        uri: '',
        registered: false,
      });
      return;
    }

    if (url.pathname === '/api/runtime-config') {
      await fulfillJson(200, {
        inputReliabilityMode: 'queue',
        wsTransportMode: 'unified',
        stabilityModes: {
          frontendRuntimeResidency: 'legacy',
        },
        resourceLimits: {
          clientWs: currentSnapshot.values.resourceLimits.clientWs,
          terminal: currentSnapshot.values.resourceLimits.terminal,
          snapshots: currentSnapshot.values.resourceLimits.snapshots,
          workspaceRuntime: currentSnapshot.values.resourceLimits.workspaceRuntime,
        },
      });
      return;
    }

    if (url.pathname === '/api/sessions/shells') {
      await fulfillJson(200, []);
      return;
    }

    if (url.pathname === '/api/sessions') {
      await fulfillJson(200, []);
      return;
    }

    if (url.pathname === '/api/workspaces') {
      await fulfillJson(200, {
        workspaces: [],
        tabs: [],
        gridLayouts: [],
      });
      return;
    }

    if (url.pathname === '/api/command-presets') {
      await fulfillJson(200, { presets: [] });
      return;
    }

    if (url.pathname === '/api/recovery-options') {
      await fulfillJson(200, { options: [] });
      return;
    }

    if (url.pathname === '/api/settings') {
      if (method === 'PATCH') {
        const response = options.onSettingsPatch(route.request().postDataJSON());
        if (response.status < 400) {
          currentSnapshot = response.body as ReturnType<typeof createSettingsSnapshot>;
        }
        await fulfillJson(response.status, response.body);
        return;
      }

      await fulfillJson(200, currentSnapshot);
      return;
    }

    await fulfillJson(200, {});
  });

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

  await page.route('**/api/auth/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true }),
    });
  });

  await page.route('**/api/auth/refresh', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        token: 'settings-resource-limits-token',
        expiresIn: 1_800_000,
      }),
    });
  });

  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        token: 'settings-resource-limits-token',
        expiresIn: 1_800_000,
      }),
    });
  });

  await page.route('**/api/sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
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

  await page.route('**/api/command-presets', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ presets: [] }),
    });
  });

  await page.route('**/api/recovery-options', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ options: [] }),
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
      const response = options.onSettingsPatch(route.request().postDataJSON());
      if (response.status < 400) {
        currentSnapshot = response.body as ReturnType<typeof createSettingsSnapshot>;
      }
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(currentSnapshot),
    });
  });
}

function createSettingsSnapshot(overrides: {
  headlessPendingOutputMaxBytes?: number;
  clientInputBackpressureBytes?: number;
} = {}) {
  const immediateCapability = { applyScope: 'immediate', available: true, writeOnly: false };
  const newSessionCapability = { applyScope: 'new_sessions', available: true, writeOnly: false };
  const newLoginCapability = { applyScope: 'new_logins', available: true, writeOnly: false };
  const authPasswordCapability = { applyScope: 'new_logins', available: true, writeOnly: true };
  const unavailableCapability = { applyScope: 'immediate', available: false, writeOnly: false, reason: 'reserved' };

  return {
    values: {
      auth: {
        durationMs: 1_800_000,
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
          maxAge: 86_400,
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
        maxFileSize: 1_048_576,
        maxDirectoryEntries: 10_000,
        blockedExtensions: ['.exe'],
        blockedPaths: ['.ssh'],
        cwdCacheTtlMs: 1_000,
      },
      resourceLimits: {
        headless: {
          pendingOutputMaxBytes: overrides.headlessPendingOutputMaxBytes ?? 1_048_576,
          pendingOutputMaxChunks: 1024,
          writeLagWarnMs: 250,
          writeBatchMaxBytes: 65_536,
          overflowPolicy: 'degrade-headless',
        },
        ws: {
          serverBufferedHighWaterBytes: 1_048_576,
          serverBufferedHardLimitBytes: 8_388_608,
          perClientOutputQueueMaxBytes: 4_194_304,
          perClientControlQueueMaxBytes: 262_144,
          outputCoalesceWindowMs: 16,
        },
        clientWs: {
          inputBackpressureBytes: overrides.clientInputBackpressureBytes ?? 524_288,
          hardReconnectBytes: 4_194_304,
        },
        terminal: {
          visibleOutputQueueMaxBytes: 1_048_576,
          visibleOutputMaxChunks: 1024,
          visibleFlushBudgetBytes: 65_536,
          hiddenOutputPolicy: 'write-hidden',
          hiddenOutputTailBytes: 262_144,
          inputQueueMaxBytes: 65_536,
          inputQueueTtlMs: 5_000,
          transportOutboxMaxBytes: 65_536,
          transportOutboxTtlMs: 5_000,
          scrollbackLines: 10_000,
        },
        snapshots: {
          perSnapshotMaxChars: 1_000_000,
          totalStorageBudgetChars: 20_000_000,
          maxEntries: 50,
          tombstoneTtlMs: 300_000,
        },
        workspaceRuntime: {
          maxLiveWorkspaces: 2,
          maxLiveTerminals: 8,
          hiddenRuntimeTtlMs: 300_000,
        },
        telemetry: {
          sampleIntervalMs: 30_000,
          recentEventLimit: 200,
        },
      },
      stabilityModes: {
        headlessQueueMode: 'observe',
        wsSendMode: 'direct',
        frontendRuntimeResidency: 'legacy',
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
      'pty.useConpty': unavailableCapability,
      'pty.windowsPowerShellBackend': {
        ...unavailableCapability,
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
      'resourceLimits.headless.pendingOutputMaxBytes': {
        ...newSessionCapability,
        constraints: { min: 1024, max: 268_435_456, step: 1, unit: 'bytes' },
      },
      'resourceLimits.headless.pendingOutputMaxChunks': {
        ...newSessionCapability,
        constraints: { min: 1, max: 65_536, step: 1, unit: 'count' },
      },
      'resourceLimits.headless.writeLagWarnMs': unavailableCapability,
      'resourceLimits.headless.writeBatchMaxBytes': unavailableCapability,
      'resourceLimits.headless.overflowPolicy': unavailableCapability,
      'resourceLimits.ws.serverBufferedHighWaterBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 268_435_456, step: 1, unit: 'bytes' },
      },
      'resourceLimits.ws.serverBufferedHardLimitBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 536_870_912, step: 1, unit: 'bytes' },
      },
      'resourceLimits.ws.perClientOutputQueueMaxBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 268_435_456, step: 1, unit: 'bytes' },
      },
      'resourceLimits.ws.perClientControlQueueMaxBytes': unavailableCapability,
      'resourceLimits.ws.outputCoalesceWindowMs': unavailableCapability,
      'resourceLimits.clientWs.inputBackpressureBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 268_435_456, step: 1, unit: 'bytes' },
      },
      'resourceLimits.clientWs.hardReconnectBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 536_870_912, step: 1, unit: 'bytes' },
      },
      'resourceLimits.terminal.visibleOutputQueueMaxBytes': unavailableCapability,
      'resourceLimits.terminal.visibleOutputMaxChunks': unavailableCapability,
      'resourceLimits.terminal.visibleFlushBudgetBytes': unavailableCapability,
      'resourceLimits.terminal.hiddenOutputPolicy': {
        ...immediateCapability,
        options: ['write-hidden', 'snapshot-restore', 'debug-tail'],
      },
      'resourceLimits.terminal.hiddenOutputTailBytes': {
        ...immediateCapability,
        constraints: { min: 0, max: 16_777_216, step: 1, unit: 'bytes' },
      },
      'resourceLimits.terminal.inputQueueMaxBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 16_777_216, step: 1, unit: 'bytes' },
      },
      'resourceLimits.terminal.inputQueueTtlMs': {
        ...immediateCapability,
        constraints: { min: 1, max: 60_000, step: 1, unit: 'ms' },
      },
      'resourceLimits.terminal.transportOutboxMaxBytes': {
        ...immediateCapability,
        constraints: { min: 1024, max: 16_777_216, step: 1, unit: 'bytes' },
      },
      'resourceLimits.terminal.transportOutboxTtlMs': {
        ...immediateCapability,
        constraints: { min: 1, max: 60_000, step: 1, unit: 'ms' },
      },
      'resourceLimits.terminal.scrollbackLines': unavailableCapability,
      'resourceLimits.snapshots.perSnapshotMaxChars': {
        ...immediateCapability,
        constraints: { min: 1024, max: 50_000_000, step: 1, unit: 'chars' },
      },
      'resourceLimits.snapshots.totalStorageBudgetChars': {
        ...immediateCapability,
        constraints: { min: 1024, max: 200_000_000, step: 1, unit: 'chars' },
      },
      'resourceLimits.snapshots.maxEntries': {
        ...immediateCapability,
        constraints: { min: 1, max: 1024, step: 1, unit: 'count' },
      },
      'resourceLimits.snapshots.tombstoneTtlMs': {
        ...immediateCapability,
        constraints: { min: 1000, max: 604_800_000, step: 1, unit: 'ms' },
      },
      'resourceLimits.workspaceRuntime.maxLiveWorkspaces': {
        ...immediateCapability,
        constraints: { min: 1, max: 10, step: 1, unit: 'count' },
      },
      'resourceLimits.workspaceRuntime.maxLiveTerminals': {
        ...immediateCapability,
        constraints: { min: 1, max: 128, step: 1, unit: 'count' },
      },
      'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs': {
        ...immediateCapability,
        constraints: { min: 1000, max: 3_600_000, step: 1, unit: 'ms' },
      },
      'resourceLimits.telemetry.sampleIntervalMs': unavailableCapability,
      'resourceLimits.telemetry.recentEventLimit': unavailableCapability,
      'stabilityModes.headlessQueueMode': unavailableCapability,
      'stabilityModes.wsSendMode': unavailableCapability,
      'stabilityModes.frontendRuntimeResidency': unavailableCapability,
    },
    secretState: {
      authPasswordConfigured: true,
      smtpPasswordConfigured: false,
    },
    excludedSections: [],
  };
}
