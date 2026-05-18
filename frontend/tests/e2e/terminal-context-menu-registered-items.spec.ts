import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  clearCommandPresets,
  countCommandPresetPasteDebugEvents,
  createCommandPresetViaApi,
  expectTerminalFocusRestored,
  expectTerminalInputDebugAfterCount,
  expectVisibleTerminalCurrentInputEquals,
  getActiveSessionId,
  login,
  openTerminalContextMenu,
  setTerminalInputTransportOverride,
  waitForTerminal,
} from './helpers';

test.describe('Terminal context menu registered item paste', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await waitForTerminal(page);
    await clearCommandPresets(page);
    await page.locator('.terminal-view:visible .xterm-helper-textarea').first().focus();
    await page.keyboard.press('Control+C');
    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.clear();
      window.__buildergateTerminalDebug?.enable();
    });
  });

  test.afterEach(async ({ page }) => {
    await clearCommandPresets(page);
  });

  test('hides registered paste menu when no presets exist', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    await page.route('**/api/command-presets', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ presets: [] }),
        });
        return;
      }
      await route.continue();
    });

    await openTerminalContextMenu(page);
    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.getByText('등록 항목 붙여넣기')).toHaveCount(0);
    await page.unroute('**/api/command-presets');
  });

  test('pastes a registered command without sending Enter on desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const label = `e2e-dialog-context-command-${stamp}`;
    const command = `echo e2e-context-menu-${stamp}`;
    await createCommandPresetViaApi(page, 'command', label, command);

    await openTerminalContextMenu(page);
    await expect(page.getByText('등록 항목 붙여넣기')).toBeVisible();
    await page.getByText('등록 항목 붙여넣기').hover();
    await expect(page.getByText('커맨드 라인')).toBeVisible();
    await page.getByText('커맨드 라인').hover();
    await expect(page.getByText(label)).toBeVisible();
    const pasteEventCountBefore = await countCommandPresetPasteDebugEvents(page);
    await page.getByText(label).click();

    await expect(page.locator('.context-menu')).toHaveCount(0);
    await expectRegisteredPaste(page, command, pasteEventCountBefore);
    await page.keyboard.press('Control+C');
  });

  test('pastes a registered directory without generating cd command on desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const label = `e2e-dialog-context-dir-${stamp}`;
    const directory = `C:\\Work\\e2e-context-dir-${stamp}`;
    await createCommandPresetViaApi(page, 'directory', label, directory);

    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').click();
    await expect(page.getByText('디렉토리')).toBeVisible();
    await page.getByText('디렉토리').click();
    await expect(page.getByText(label)).toBeVisible();
    const pasteEventCountBefore = await countCommandPresetPasteDebugEvents(page);
    await page.getByText(label).click();

    await expectRegisteredPaste(page, directory, pasteEventCountBefore);
    await expect(page.locator('.xterm-screen:visible').first()).not.toContainText('cd ');
    await page.keyboard.press('Control+C');
  });

  test('pastes a registered prompt as a single-line value on desktop', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const label = `e2e-dialog-context-prompt-${stamp}`;
    const prompt = `review-plan-${stamp}`;
    await createCommandPresetViaApi(page, 'prompt', label, prompt);

    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('프롬프트').hover();
    await expect(page.getByText(label)).toBeVisible();
    const pasteEventCountBefore = await countCommandPresetPasteDebugEvents(page);
    await page.getByText(label).click();

    await expectRegisteredPaste(page, prompt, pasteEventCountBefore);
    await page.keyboard.press('Control+C');
  });

  test('opens desktop submenu by keyboard activation', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const commandLabel = `e2e-dialog-context-keyboard-cmd-${stamp}`;
    await createCommandPresetViaApi(page, 'command', commandLabel, 'keyboard-cmd');
    await createCommandPresetViaApi(page, 'directory', `e2e-dialog-context-keyboard-dir-${stamp}`, 'C:\\Work');

    await openTerminalContextMenu(page);
    await expect.poll(async () => activeContextMenuItemText(page)).toContain('새 세션');
    await expect(page.locator('.context-menu-item.disabled').filter({ hasText: '복사' })).toHaveAttribute('tabindex', '-1');
    await page.keyboard.press('End');
    await expect.poll(async () => activeContextMenuItemText(page)).toContain('등록 항목 붙여넣기');
    await page.keyboard.press('Enter');
    await expect(page.getByText('디렉토리')).toBeVisible();
    await expect.poll(async () => activeContextMenuItemText(page)).toContain('커맨드 라인');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(commandLabel)).toBeVisible();
  });

  test('keeps an open preset snapshot stable and reloads fresh presets on reopen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const firstLabel = `e2e-dialog-context-fresh-a-${stamp}`;
    const secondLabel = `e2e-dialog-context-fresh-b-${stamp}`;
    await createCommandPresetViaApi(page, 'command', firstLabel, `fresh-a-${stamp}`);

    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('커맨드 라인').hover();
    await expect(page.getByText(firstLabel)).toBeVisible();

    await createCommandPresetViaApi(page, 'command', secondLabel, `fresh-b-${stamp}`);
    await expect(page.getByText(secondLabel)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toHaveCount(0);

    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('커맨드 라인').hover();
    await expect(page.getByText(secondLabel)).toBeVisible();
  });

  test('opens registered paste menu after a slow successful preset load', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const label = `e2e-dialog-context-slow-success-${stamp}`;
    await createCommandPresetViaApi(page, 'command', label, `slow-success-${stamp}`);

    let releasePresets!: () => void;
    const presetsBlocked = new Promise<void>(resolve => {
      releasePresets = resolve;
    });
    let heldRequest = false;
    await page.route('**/api/command-presets', async route => {
      if (!heldRequest && route.request().method() === 'GET') {
        heldRequest = true;
        await presetsBlocked;
      }
      await route.continue();
    });

    await openTerminalContextMenu(page, { waitForMenu: false });
    await expect(page.locator('.context-menu')).toHaveCount(0);
    releasePresets();
    await expect(page.locator('.context-menu')).toBeVisible();
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('커맨드 라인').hover();
    await expect(page.getByText(label)).toBeVisible();

    await page.unroute('**/api/command-presets');
  });

  test('does not resurrect a visible desktop menu after close during a slow reload', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const label = `e2e-dialog-context-no-resurrect-${Date.now()}`;
    await createCommandPresetViaApi(page, 'command', label, 'no-resurrect');

    await openTerminalContextMenu(page, { xRatio: 0.2, yRatio: 0.2 });
    await expect(page.locator('.context-menu')).toBeVisible();

    let releasePresets!: () => void;
    const presetsBlocked = new Promise<void>(resolve => {
      releasePresets = resolve;
    });
    let heldRequest = false;
    await page.route('**/api/command-presets', async route => {
      if (!heldRequest && route.request().method() === 'GET') {
        heldRequest = true;
        await presetsBlocked;
      }
      await route.continue();
    });

    await openTerminalContextMenu(page, { xRatio: 0.85, yRatio: 0.85, waitForMenu: false, dispatchEvent: true });
    await expect.poll(() => heldRequest).toBe(true);
    await page.mouse.click(5, 5);
    await expect(page.locator('.context-menu')).toHaveCount(0);
    releasePresets();
    await page.waitForTimeout(300);
    await expect(page.locator('.context-menu')).toHaveCount(0);

    await page.unroute('**/api/command-presets');
  });

  test('pastes a registered command from the Grid Mode terminal context menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    const label = `e2e-dialog-context-grid-${stamp}`;
    const command = `grid-paste-${stamp}`;
    await createCommandPresetViaApi(page, 'command', label, command);
    await switchToGridMode(page);

    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('커맨드 라인').hover();
    const pasteEventCountBefore = await countCommandPresetPasteDebugEvents(page);
    await page.getByText(label).click();

    await expectRegisteredPaste(page, command, pasteEventCountBefore);
    await page.keyboard.press('Control+C');
  });

  test('warns and hides registered paste menu when preset loading fails', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const staleLabel = `e2e-dialog-context-stale-${Date.now()}`;
    await createCommandPresetViaApi(page, 'command', staleLabel, `stale-${Date.now()}`);
    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('커맨드 라인').hover();
    await expect(page.getByText(staleLabel)).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(page.locator('.context-menu')).toHaveCount(0);

    const warnings: string[] = [];
    page.on('console', message => {
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });

    let failedOnce = false;
    await page.route('**/api/command-presets', async route => {
      if (!failedOnce && route.request().method() === 'GET') {
        failedOnce = true;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'forced e2e failure' }),
        });
        return;
      }
      await route.continue();
    });

    await openTerminalContextMenu(page);
    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.getByText('등록 항목 붙여넣기')).toHaveCount(0);
    await expect(page.getByText(staleLabel)).toHaveCount(0);
    await expect.poll(() => warnings.some(text => text.includes('Failed to load command presets'))).toBe(true);

    await page.unroute('**/api/command-presets');
  });

  test('refuses unsafe registered prompt values without terminal input side effects', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const warnings: string[] = [];
    page.on('console', message => {
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });

    const label = `e2e-dialog-context-unsafe-${Date.now()}`;
    await createCommandPresetViaApi(page, 'prompt', label, 'unsafe-line-one\nunsafe-line-two');
    await page.evaluate(() => window.__buildergateTerminalDebug?.clear());

    await openTerminalContextMenu(page);
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('프롬프트').hover();
    await page.getByText(label).click();

    await expect(page.locator('.context-menu')).toHaveCount(0);
    await expect.poll(() => warnings.some(text => text.includes('Refused command preset paste'))).toBe(true);
    await expect.poll(() => countCommandPresetPasteDebugEvents(page)).toBe(0);
    await expect(page.locator('.xterm-screen:visible').first()).not.toContainText('unsafe-line-one');
  });

  test('warns without input side effects when target terminal is not ready', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    const warnings: string[] = [];
    page.on('console', message => {
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });

    const stamp = Date.now();
    const label = `e2e-dialog-context-not-ready-${stamp}`;
    const command = `blocked-paste-${stamp}`;
    await createCommandPresetViaApi(page, 'command', label, command);
    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.clear();
      window.__buildergateTerminalDebug?.setInputReliabilityMode('observe');
    });
    expect(await setTerminalInputTransportOverride(page, sessionId, {
      serverReady: false,
      barrierReason: 'repair-server-not-ready',
      closedReason: 'none',
      reconnectState: 'connected',
    })).toBe(true);

    try {
      await openTerminalContextMenu(page);
      await page.getByText('등록 항목 붙여넣기').hover();
      await page.getByText('커맨드 라인').hover();
      await page.getByText(label).click();

      await expect(page.locator('.context-menu')).toHaveCount(0);
      await expect.poll(() => warnings.some(text => text.includes('Failed to paste command preset'))).toBe(true);
      await expect.poll(async () => {
        return page.evaluate(() => {
          const events = window.__buildergateTerminalDebug?.getEvents() ?? [];
          return events.some((event) => {
            return event.kind === 'terminal_input_would_queue'
              && event.details?.source === 'command-preset-paste'
              && event.details?.reason === 'mode-observe-only';
          });
        });
      }).toBe(true);
      await expect(page.locator('.xterm-screen:visible').first()).not.toContainText(command);
    } finally {
      await setTerminalInputTransportOverride(page, sessionId, null);
      await page.evaluate(() => window.__buildergateTerminalDebug?.setInputReliabilityMode(null));
    }
  });

  test('keeps root and nested desktop menus inside the viewport near screen edges', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop coverage');

    const stamp = Date.now();
    for (let index = 0; index < 24; index += 1) {
      await createCommandPresetViaApi(
        page,
        'command',
        `e2e-dialog-context-edge-${stamp}-${index.toString().padStart(2, '0')}`,
        `edge-${stamp}-${index}`,
      );
    }

    const edgePositions = [
      { xRatio: 0.02, yRatio: 0.08 },
      { xRatio: 0.5, yRatio: 0.08 },
      { xRatio: 0.98, yRatio: 0.5 },
      { xRatio: 0.5, yRatio: 0.96 },
      { xRatio: 0.98, yRatio: 0.96 },
    ];

    for (const position of edgePositions) {
      await openTerminalContextMenu(page, position);
      await expectAllVisibleContextMenusInsideViewport(page);
      await page.getByText('등록 항목 붙여넣기').hover();
      await expect(page.getByText('커맨드 라인')).toBeVisible();
      await expectAllVisibleContextMenusInsideViewport(page);
      await page.getByText('커맨드 라인').hover();
      await expectAllVisibleContextMenusInsideViewport(page);
      await page.mouse.click(5, 5);
      await expect(page.locator('.context-menu')).toHaveCount(0);
    }

    await openTerminalContextMenu(page, { xRatio: 0.98, yRatio: 0.96 });
    await page.getByText('등록 항목 붙여넣기').hover();
    await page.getByText('커맨드 라인').hover();
    await expect.poll(async () => {
      return page.locator('.context-submenu').last().evaluate((element) => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight && style.overflowY !== 'visible';
      });
    }).toBe(true);
  });

  test('renders mobile dialog with focus entry and button-list ARIA contract', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile dialog coverage');

    await createCommandPresetViaApi(page, 'command', `e2e-dialog-context-mobile-a11y-${Date.now()}`, 'mobile-a11y');

    await openTerminalContextMenu(page, { mobile: true });
    await expect(page.locator('.context-menu-dialog')).toBeVisible();
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴');
    await expect(page.locator('.context-menu-dialog-list')).not.toHaveAttribute('role', 'menu');
    await expect.poll(async () => isActiveElementInsideDialog(page)).toBe(true);
    await page.keyboard.press('Tab');
    await expect.poll(async () => isActiveElementInsideDialog(page)).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(async () => isActiveElementInsideDialog(page)).toBe(true);
  });

  test('uses mobile dialog path navigation with header and browser back', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile dialog coverage');

    await createCommandPresetViaApi(page, 'command', `e2e-dialog-context-mobile-path-${Date.now()}`, 'mobile-path');

    await openTerminalContextMenu(page, { mobile: true });
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴');

    await tapDialogItem(page, '등록 항목 붙여넣기');
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴 > 등록 항목 붙여넣기');
    await tapDialogItem(page, '커맨드 라인');
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴 > 등록 항목 붙여넣기 > 커맨드 라인');

    await page.goBack();
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴 > 등록 항목 붙여넣기');
    await page.locator('.context-menu-dialog-back').click();
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴');
    await page.goBack();
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);
  });

  test('closes child mobile dialog with backdrop and restores previous focus', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile dialog coverage');

    await createCommandPresetViaApi(page, 'command', `e2e-dialog-context-mobile-backdrop-${Date.now()}`, 'mobile-backdrop');
    await page.evaluate(() => {
      const target = document.createElement('div');
      target.id = 'mobile-context-menu-focus-target';
      target.tabIndex = -1;
      target.style.position = 'fixed';
      target.style.left = '0';
      target.style.top = '0';
      target.style.width = '1px';
      target.style.height = '1px';
      document.body.appendChild(target);
      target.focus();
    });
    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe('mobile-context-menu-focus-target');
    await openTerminalContextMenu(page, { mobile: true });
    await tapDialogItem(page, '등록 항목 붙여넣기');
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴 > 등록 항목 붙여넣기');
    await page.locator('.context-menu-dialog-backdrop').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe('mobile-context-menu-focus-target');
  });

  test('pastes a registered mobile leaf exactly once', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile dialog coverage');

    const label = `e2e-dialog-context-mobile-leaf-${Date.now()}`;
    const command = `mobile-paste-${Date.now()}`;
    await createCommandPresetViaApi(page, 'command', label, command);
    await openTerminalContextMenu(page, { mobile: true });
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴');
    await tapDialogItem(page, '등록 항목 붙여넣기');
    await tapDialogItem(page, '커맨드 라인');
    const pasteEventCountBeforeLeaf = await countCommandPresetPasteDebugEvents(page);
    await tapDialogItem(page, label);
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);
    await expectRegisteredPaste(page, command, pasteEventCountBeforeLeaf);
    await page.keyboard.press('Control+C');
  });

  test('reopens mobile context menu at the root after nested close', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile dialog coverage');

    await createCommandPresetViaApi(page, 'command', `e2e-dialog-context-mobile-reopen-${Date.now()}`, 'mobile-reopen');
    await openTerminalContextMenu(page, { mobile: true });
    await tapDialogItem(page, '등록 항목 붙여넣기');
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴 > 등록 항목 붙여넣기');
    await page.locator('.context-menu-dialog-close').click();
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);

    await openTerminalContextMenu(page, { mobile: true });
    await expect(page.locator('.context-menu-dialog-title')).toHaveText('메뉴');
    await page.goBack();
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);
  });
});

async function tapDialogItem(page: Page, label: string): Promise<void> {
  await page.locator('.context-menu-dialog-item').filter({ hasText: label }).click();
}

async function expectRegisteredPaste(page: Page, value: string, pasteEventCountBefore: number): Promise<void> {
  await expectVisibleTerminalCurrentInputEquals(page, value);
  await expectTerminalInputDebugAfterCount(page, pasteEventCountBefore, {
    enterCount: 0,
    controlCount: 0,
    byteLength: new TextEncoder().encode(value).length,
    codePointCount: Array.from(value).length,
    source: 'command-preset-paste',
  });
  await expectTerminalFocusRestored(page);
}

async function activeContextMenuItemText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.classList.contains('context-menu-item')) {
      return '';
    }
    const label = Array.from(active.children).find(child => child.classList.contains('context-menu-label'));
    return label?.textContent?.trim() ?? active.textContent?.trim() ?? '';
  });
}

async function isActiveElementInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest('.context-menu-dialog') instanceof HTMLElement;
  });
}

async function switchToGridMode(page: Page): Promise<void> {
  const switchToGrid = page.getByTitle('Switch to Grid');
  if (await switchToGrid.isVisible()) {
    await switchToGrid.click();
  }
  await expect(page.getByTitle('Switch to Tabs')).toBeVisible();
  await expect(page.locator('.grid-cell .xterm-screen:visible').first()).toBeVisible({ timeout: 15000 });
}

async function expectAllVisibleContextMenusInsideViewport(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error('Viewport is not available');
  }
  const boxes = await page.locator('.context-menu:visible').evaluateAll(elements => {
    return elements.map(element => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    });
  });

  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(viewport.width);
    expect(box.bottom).toBeLessThanOrEqual(viewport.height);
  }
}
