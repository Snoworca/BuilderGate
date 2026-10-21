// FR-MKB-005..011 — mobile terminal keyboard: the accessory key bar above the
// system keyboard, lockable Ctrl/Alt/Shift, and the special keyboard panel with
// its numpad. Phone projects only; desktop must not render any of it.
//
// Fixture: one workspace with one tab, created through createOwnedWorkspaceViaApi
// and removed by id.

import { randomUUID } from 'node:crypto';

import { test, expect, createOwnedWorkspaceViaApi, type Page } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';
const MARKER = `mkb${randomUUID().slice(0, 6)}`;

const isPhoneProject = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

async function terminalText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(
    (id) => (window as unknown as { __buildergateTerminalDebug?: { captureTerminalText?: (sid: string) => string } })
      .__buildergateTerminalDebug?.captureTerminalText?.(id) ?? '',
    sessionId,
  );
}

async function helperFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false);
}

// FR-MKB-013: the bar shows only while the system keyboard is up. An emulated
// phone has no on-screen keyboard, so this stands in for the OS: focusing the
// terminal input raises a 300 px keyboard (the visual viewport shrinks and fires
// resize), blurring it lowers it, and __e2eKeyboard(false) is the back button
// that lowers it while the focus stays.
async function emulateSystemKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let up = false;
    const KEYBOARD = 300;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - (up ? KEYBOARD : 0) });
    const set = (next: boolean): void => {
      if (up === next) return;
      up = next;
      vv.dispatchEvent(new Event('resize'));
    };
    (window as unknown as { __e2eKeyboard: (next: boolean) => void }).__e2eKeyboard = set;
    const isHelper = (target: EventTarget | null): boolean => target instanceof Element && target.classList.contains('xterm-helper-textarea');
    document.addEventListener('focusin', (event) => { if (isHelper(event.target)) set(true); });
    document.addEventListener('focusout', (event) => { if (isHelper(event.target) && !isHelper(event.relatedTarget)) set(false); });
  });
}

test.describe('모바일 터미널 키보드', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true });

  test('FR-MKB-006 FR-MKB-005 FR-MKB-008 FR-MKB-009 FR-MKB-010: 키 줄, 잠금, 특수 키보드, 숫자패드', async ({ page, request }, testInfo) => {
    test.skip(!isPhoneProject(testInfo.project), 'Phone projects only');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(150000);
    const ownerId = `mobile-terminal-keyboard/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    let primaryFailure: unknown = null;

    await emulateSystemKeyboard(page);
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
      headers,
      data: { name: `e2e-mkb-${randomUUID().slice(0, 8)}` },
    });

    try {
      const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: 'e2e-mkb-tab' } });
      expect(createdTab.status()).toBe(201);
      const sessionId = ((await createdTab.json()) as { sessionId: string }).sessionId;
      expect(sessionId, 'the created tab carries a session id').toBeTruthy();
      await page.evaluate((id) => localStorage.setItem('active_workspace_id', id), workspace.id);
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 20000 });
      // Guard: every keystroke below must land in this test's own tab, never in a user session.
      const ownTab = page.locator('.workspace-tabbar [role="tab"]', { hasText: 'e2e-mkb-tab' }).first();
      await expect(ownTab, 'the owned workspace is active').toBeVisible({ timeout: 15000 });
      await ownTab.click();
      await expect(ownTab).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
      await expect(page.locator('.workspace-tabbar [role="tab"]')).toHaveCount(1);
      await waitForTerminal(page);

      // FR-MKB-006 AC-2: no bar until the terminal input has focus.
      const bar = page.locator('.mobile-key-bar');
      await expect(bar).toHaveCount(0);
      await page.locator('.terminal-view:visible .xterm-screen').first().tap();
      await expect(bar).toBeVisible();
      await expect.poll(() => helperFocused(page), { timeout: 5000 }).toBe(true);

      // FR-MKB-013 AC-2/AC-3: the back button lowers the keyboard and keeps the focus;
      // the bar waits out the grace period, then hides. A tap brings both back.
      await page.evaluate(() => (window as unknown as { __e2eKeyboard: (up: boolean) => void }).__e2eKeyboard(false));
      await expect(bar).toHaveCount(0, { timeout: 3000 });
      expect(await helperFocused(page), 'the terminal keeps the focus').toBe(true);
      await page.evaluate(() => (window as unknown as { __e2eKeyboard: (up: boolean) => void }).__e2eKeyboard(true));
      await expect(bar).toBeVisible();

      // FR-MKB-006 AC-1: bar order, no Win/AltGr.
      const keys = await bar.locator('[data-mobile-key]').evaluateAll((els) => els.map((el) => el.getAttribute('data-mobile-key')));
      expect(keys.filter((k) => k !== null)).toEqual(['Esc', 'Tab', 'Left', 'Up', 'Down', 'Right', 'Home', 'End', 'PageUp', 'PageDown']);
      await expect(bar.locator('[data-mod="ctrl"]')).toHaveCount(1);
      await expect(bar.locator('[data-mod="alt"]')).toHaveCount(1);

      // FR-MKB-006 AC-3/AC-4: arrow Up recalls history through the bar; focus stays on the terminal.
      await page.keyboard.type(`echo ${MARKER}`);
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await terminalText(page, sessionId)).split(MARKER).length - 1, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
      await bar.locator('[data-mobile-key="Up"]').tap();
      await expect.poll(() => helperFocused(page), { timeout: 5000 }).toBe(true);
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await terminalText(page, sessionId)).split(MARKER).length - 1, { timeout: 15000 }).toBeGreaterThanOrEqual(4);
      await page.screenshot({ path: '../.playwright-mcp/mobile-terminal-keyboard-bar.png' });

      // FR-MKB-005 AC-1/AC-3: tap = once, 1.5 s hold = locked, tap releases.
      const ctrl = bar.locator('[data-mod="ctrl"]');
      await expect(ctrl).toHaveAttribute('data-latch-state', 'off');
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'once');
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'off');
      const box = await ctrl.boundingBox();
      if (!box) throw new Error('ctrl key has no box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1700);
      await page.mouse.up();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'locked');
      await page.screenshot({ path: '../.playwright-mcp/mobile-terminal-keyboard-locked.png' });
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'off');

      // FR-MKB-008 AC-1/AC-5: the switch blurs the terminal and opens the panel under the bar.
      const toggle = bar.locator('[data-mobile-action="toggle-keyboard"]');
      await toggle.tap();
      const panel = page.locator('.mobile-special-keyboard');
      await expect(panel).toBeVisible();
      await expect(bar).toBeVisible();
      await expect.poll(() => helperFocused(page), { timeout: 5000 }).toBe(false);
      const barBox = await bar.boundingBox();
      const panelBox = await panel.boundingBox();
      expect(barBox && panelBox && panelBox.y >= barBox.y + barBox.height - 1).toBe(true);

      // FR-MKB-008 AC-4: tapping the terminal while the panel is open does not refocus it.
      await page.locator('.terminal-view:visible .xterm-screen').first().tap();
      await expect.poll(() => helperFocused(page), { timeout: 5000 }).toBe(false);
      await expect(panel).toBeVisible();

      // FR-MKB-009 AC-2: F1..F12 block present.
      await expect(panel.locator('[data-mobile-key="F12"]')).toBeVisible();
      await page.screenshot({ path: '../.playwright-mcp/mobile-terminal-keyboard-special.png' });

      // FR-MKB-010 AC-1/AC-2: numpad swaps the right block only, and back.
      await panel.locator('[data-special-switch="numpad"]').tap();
      await expect(panel.locator('[data-mobile-key="7"]')).toBeVisible();
      await expect(panel.locator('[data-mobile-key="F12"]')).toBeVisible();
      await page.screenshot({ path: '../.playwright-mcp/mobile-terminal-keyboard-numpad.png' });
      await panel.locator('[data-special-switch="arrows"]').tap();
      await expect(panel.locator('[data-mobile-key="Up"]')).toBeVisible();

      // FR-MKB-008 AC-3: switching back closes the panel and refocuses the terminal.
      await toggle.tap();
      await expect(panel).toHaveCount(0);
      await expect.poll(() => helperFocused(page), { timeout: 5000 }).toBe(true);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length && !primaryFailure) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });

  test('I-002: desktop renders no mobile keyboard', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    const ownerId = `mobile-terminal-keyboard-desktop/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    let primaryFailure: unknown = null;
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
      headers,
      data: { name: `e2e-mkb-desk-${randomUUID().slice(0, 8)}` },
    });
    try {
      const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: 'e2e-mkb-desk-tab' } });
      expect(createdTab.status()).toBe(201);
      await page.evaluate((id) => localStorage.setItem('active_workspace_id', id), workspace.id);
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 20000 });
      const ownTab = page.locator('[role="tab"]', { hasText: 'e2e-mkb-desk-tab' }).first();
      await expect(ownTab, 'the owned workspace is active').toBeVisible({ timeout: 15000 });
      await ownTab.click();
      await waitForTerminal(page);
      await page.locator('.terminal-view:visible .xterm-screen').first().click();
      await expect.poll(() => helperFocused(page), { timeout: 5000 }).toBe(true);
      await expect(page.locator('.mobile-key-bar')).toHaveCount(0);
      await expect(page.locator('.mobile-special-keyboard')).toHaveCount(0);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length && !primaryFailure) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });

  // FR-MKB-003 AC-6 and FR-MKB-002 AC-2 (2026-10-21): Ctrl latched + v pastes the clipboard, and a
  // hold of 750 ms locks Ctrl.
  test('FR-MKB-003 AC-6 FR-MKB-002 AC-2: Ctrl latched + v pastes the clipboard; a 0.75 s hold locks Ctrl', async ({ page, request, context }, testInfo) => {
    test.skip(!isPhoneProject(testInfo.project), 'Phone projects only');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(150000);
    const ownerId = `mobile-terminal-keyboard-paste/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    let primaryFailure: unknown = null;
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    await emulateSystemKeyboard(page);
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
      headers,
      data: { name: `e2e-mkbp-${randomUUID().slice(0, 8)}` },
    });
    try {
      const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: 'e2e-mkbp-tab' } });
      expect(createdTab.status()).toBe(201);
      const sessionId = ((await createdTab.json()) as { sessionId: string }).sessionId;
      await page.evaluate((id) => localStorage.setItem('active_workspace_id', id), workspace.id);
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 20000 });
      const ownTab = page.locator('.workspace-tabbar [role="tab"]', { hasText: 'e2e-mkbp-tab' }).first();
      await expect(ownTab).toBeVisible({ timeout: 15000 });
      await ownTab.click();
      await expect(ownTab).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
      await expect(page.locator('.workspace-tabbar [role="tab"]')).toHaveCount(1);
      await waitForTerminal(page);

      const bar = page.locator('.mobile-key-bar');
      await page.locator('.terminal-view:visible .xterm-screen').first().tap();
      await expect(bar).toBeVisible();
      const ctrl = bar.locator('[data-mod="ctrl"]').first();

      // Ctrl once + v: the clipboard text reaches the terminal, and Ctrl is spent.
      const pasted = `${MARKER}clip`;
      await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'once');
      await page.keyboard.type('v');
      await expect.poll(() => terminalText(page, sessionId), { timeout: 10000 }).toContain(pasted);
      await expect(ctrl).toHaveAttribute('data-latch-state', 'off');

      // A hold of 1 s locks Ctrl (750 ms); a 0.4 s hold is still a tap.
      const box = await ctrl.boundingBox();
      const x = box!.x + box!.width / 2;
      const y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(400);
      await page.mouse.up();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'once');
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'off');
      await page.mouse.down();
      await page.waitForTimeout(1000);
      await expect(ctrl).toHaveAttribute('data-latch-state', 'locked');
      await page.mouse.up();
      await expect(ctrl).toHaveAttribute('data-latch-state', 'locked');
      await page.screenshot({ path: '../.playwright-mcp/e2e-mkb-ctrl-paste.png' });
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length && !primaryFailure) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});

