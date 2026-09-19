// REL-BGSTAB-016 (issue #109): input discarded while the capture gate is transient-blocked and
// `inputReliabilityMode` is `observe` must say so on screen. It used to record a debug event and
// return, so the user typed and the characters were simply not there -- measured on a live
// server holding that state for tens of seconds.
//
// The two cases here are a pair on purpose. A surface that appeared whenever input was handled
// would pass the first case while reporting nothing, so the healthy path must be shown to stay
// silent.

import { expect, test } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

const TOAST = 'input-discarded-toast';

async function readGate(page: import('@playwright/test').Page): Promise<{
  mode: string | null;
  captureState: string | null;
}> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const state = await res.json();
    const workspace = state.workspaces.find((w: { id: string }) => w.id === localStorage.getItem('active_workspace_id'))
      ?? state.workspaces[0];
    const tab = state.tabs.find((t: { id: string }) => t.id === workspace?.activeTabId);
    const sessionId = tab?.sessionId;
    const snapshot = sessionId
      ? window.__buildergateTerminalDebug?.readInputGateSnapshot?.(sessionId) ?? null
      : null;
    const config = await (await fetch('/api/runtime-config')).json();
    return {
      mode: typeof config?.inputReliabilityMode === 'string' ? config.inputReliabilityMode : null,
      captureState: snapshot?.captureState ?? null,
    };
  });
}

test.describe('REL-BGSTAB-016 observe-mode input discard feedback', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only coverage');
    await login(page);
    await waitForTerminal(page);
  });

  test('AC-1/AC-3/AC-7 a discarded keystroke renders one surface carrying the count', async ({ page }) => {
    const screen = page.locator('.terminal-view:visible .xterm-screen').first();
    await screen.waitFor({ state: 'visible', timeout: 30000 });
    await screen.click();
    await page.waitForFunction(
      () => document.activeElement instanceof HTMLTextAreaElement,
      undefined,
      { timeout: 10000 },
    );

    const gate = await readGate(page);
    test.skip(gate.mode !== 'observe', `this server is not in observe mode: ${gate.mode}`);

    // The blocked gate is FORCED rather than waited for. Waiting for the environment to happen
    // to be blocked made this case skip on a healthy server, which is exactly when a regression
    // would slip through. The override is the debug surface the repo already uses for this.
    const forced = await page.evaluate(async () => {
      const token = localStorage.getItem('cws_auth_token');
      const res = await fetch('/api/workspaces', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const state = await res.json();
      const workspace = state.workspaces.find((w: { id: string }) => w.id === localStorage.getItem('active_workspace_id'))
        ?? state.workspaces[0];
      const tab = state.tabs.find((t: { id: string }) => t.id === workspace?.activeTabId);
      const sessionId = tab?.sessionId;
      if (!sessionId) return false;
      return window.__buildergateTerminalDebug?.setInputTransportOverride?.(sessionId, {
        serverReady: false,
        barrierReason: 'repair-server-not-ready',
        closedReason: 'none',
      }) ?? false;
    });
    expect(forced, 'the transport override must be available on a test host').toBe(true);
    await expect
      .poll(async () => (await readGate(page)).captureState, { timeout: 10000 })
      .toBe('transient-blocked');

    await page.keyboard.type('abcde');

    const toast = page.getByTestId(TOAST);
    await expect(toast).toBeVisible({ timeout: 2000 });
    // AC-7: one surface for the run of discards, carrying how many.
    await expect(toast).toHaveCount(1);
    await expect(page.getByTestId('input-discarded-count')).toHaveText(/5건/u);
    // AC-5: the discarded characters must not be on screen.
    await expect(toast).not.toContainText('abcde');
    // AC-6: it follows the existing toast's duration rather than lingering.
    await expect(toast).toBeHidden({ timeout: 4000 });

    await page.evaluate(async () => {
      const token = localStorage.getItem('cws_auth_token');
      const res = await fetch('/api/workspaces', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const state = await res.json();
      const workspace = state.workspaces.find((w: { id: string }) => w.id === localStorage.getItem('active_workspace_id'))
        ?? state.workspaces[0];
      const tab = state.tabs.find((t: { id: string }) => t.id === workspace?.activeTabId);
      if (tab?.sessionId) window.__buildergateTerminalDebug?.setInputTransportOverride?.(tab.sessionId, null);
    });
  });

  test('AC-4 the healthy path renders no surface at all', async ({ page }) => {
    const screen = page.locator('.terminal-view:visible .xterm-screen').first();
    await screen.waitFor({ state: 'visible', timeout: 30000 });
    await screen.click();
    await page.waitForFunction(
      () => document.activeElement instanceof HTMLTextAreaElement,
      undefined,
      { timeout: 10000 },
    );

    const gate = await readGate(page);
    test.skip(
      gate.captureState === 'transient-blocked',
      'the gate is blocked here, which is the other case',
    );

    await page.keyboard.type('echo REL_BGSTAB_016_CONTROL');
    await expect(page.getByTestId(TOAST)).toHaveCount(0);
  });
});
