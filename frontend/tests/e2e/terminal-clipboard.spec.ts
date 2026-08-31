import { expect, test, type Page } from '@playwright/test';
import {
  expectTerminalFocusRestored,
  login,
  openTerminalContextMenu,
  waitForTerminal,
} from './helpers';

interface CapturedInputFrame {
  sessionId?: string;
  data: string;
}

interface ClipboardWorkspaceContext {
  workspaceId: string;
  tabId: string;
  sessionId: string;
}

const RED_SIGNATURES = {
  selectedCopy: 'FR-BGSTAB-021 RED: selected Ctrl+C must retain the exact selection after clipboard write rejection',
  tabPaste: 'FR-BGSTAB-021 RED: tab context paste must cross the clipboard coordinator exactly once',
  gridPaste: 'FR-BGSTAB-021 RED: Grid context paste must cross the clipboard coordinator exactly once',
  contextRace: 'FR-BGSTAB-021 RED: a late clipboard read must not enter a replaced terminal target',
  gridActivePaneRace: 'FR-BGSTAB-021 RED: a late Grid clipboard read must not enter the previously active pane',
} as const;

test.describe('FR-BGSTAB-021 terminal clipboard adapters', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop clipboard contract');
  });

  test('unselected Ctrl+C sends exactly one SIGINT through the native xterm path', async ({ page }) => {
    const inputFrames = captureInputFrames(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateClipboardWorkspace(page);

    try {
      await focusTerminalHost(page, workspace.tabId);
      inputFrames.length = 0;
      await page.keyboard.press('Control+C');

      await expect.poll(() => inputFrames.filter(frame => (
        frame.sessionId === workspace.sessionId && frame.data === '\u0003'
      )).length, { timeout: 5_000 }).toBe(1);
    } finally {
      await cleanupClipboardWorkspace(page, workspace);
    }
  });

  test('selected Ctrl+C preserves selection when clipboard write fails', async ({ page }) => {
    await installRejectingClipboardWriter(page);
    const inputFrames = captureInputFrames(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateClipboardWorkspace(page);
    await enableClipboardDebug(page);

    try {
      const marker = `CLIPBOARD_COPY_SECRET_${Date.now()}`;
      await createVisibleTerminalSelection(page, marker, false, workspace.tabId);
      const actionCountBefore = await countClipboardActionEvents(page, 'keyboard');
      inputFrames.length = 0;

      await page.keyboard.press('Control+C');
      await expect.poll(() => readClipboardWriteCallCount(page), {
        message: `${RED_SIGNATURES.selectedCopy}: initial selection precondition failed`,
        timeout: 3_000,
      }).toBe(1);
      const selectionSnapshot = (await readClipboardWriteCalls(page))[0] ?? '';
      expect(selectionSnapshot).toContain(marker);

      await page.keyboard.press('Control+C');
      await expect.poll(() => readClipboardWriteCallCount(page), {
        message: RED_SIGNATURES.selectedCopy,
        timeout: 3_000,
      }).toBe(2);
      const writes = await readClipboardWriteCalls(page);
      expect(writes).toEqual([selectionSnapshot, selectionSnapshot]);
      await expectClipboardActionAfterCount(page, actionCountBefore, {
        action: 'copy',
        source: 'keyboard',
        outcome: 'rejected',
        reason: 'clipboard-write-failed',
        payloadBytes: new TextEncoder().encode(selectionSnapshot).byteLength,
        secret: selectionSnapshot,
        count: 2,
      }, RED_SIGNATURES.selectedCopy);
      expect(inputFrames.filter(frame => frame.data === '\u0003'), RED_SIGNATURES.selectedCopy).toHaveLength(0);
    } finally {
      await cleanupClipboardWorkspace(page, workspace);
    }
  });

  test('tab context copy and paste use one clipboard admission each and restore focus', async ({ page }) => {
    await installMemoryClipboard(page);
    const inputFrames = captureInputFrames(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateClipboardWorkspace(page);
    await enableClipboardDebug(page);

    try {
      const copyMarker = `TAB_COPY_SECRET_${Date.now()}`;
      await createVisibleTerminalSelection(page, copyMarker, false, workspace.tabId);
      const copyCountBefore = await countClipboardActionEvents(page, 'tab-context-menu');
      await openTerminalContextMenuForTab(page, workspace.tabId);
      await clickCopyMenuItem(page);
      await expect.poll(() => readClipboardWriteCallCount(page), { timeout: 5_000 }).toBe(1);
      const copiedSelection = (await readClipboardWriteCalls(page))[0] ?? '';
      expect(copiedSelection).toContain(copyMarker);
      await expectClipboardActionAfterCount(page, copyCountBefore, {
        action: 'copy',
        source: 'tab-context-menu',
        outcome: 'accepted',
        payloadBytes: new TextEncoder().encode(copiedSelection).byteLength,
        secret: copiedSelection,
      }, RED_SIGNATURES.tabPaste);

      const payload = `TAB_CLIPBOARD_${Date.now()}`;
      await setMemoryClipboardText(page, payload);
      const pasteCountBefore = await countClipboardActionEvents(page, 'tab-context-menu');
      inputFrames.length = 0;
      await openTerminalContextMenuForTab(page, workspace.tabId);
      await clickPasteMenuItem(page);

      await expectExactPayloadInput(
        inputFrames,
        workspace.sessionId,
        payload,
        RED_SIGNATURES.tabPaste,
      );
      await expectClipboardActionAfterCount(page, pasteCountBefore, {
        action: 'paste',
        source: 'tab-context-menu',
        outcome: 'accepted',
        payloadBytes: new TextEncoder().encode(payload).byteLength,
        secret: payload,
      }, RED_SIGNATURES.tabPaste);
      await expectTerminalFocusRestored(page);
    } finally {
      await cleanupClipboardWorkspace(page, workspace);
    }
  });

  test('Grid context copy rejection and paste use one clipboard admission each', async ({ page }) => {
    await installMemoryClipboard(page);
    const inputFrames = captureInputFrames(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateClipboardWorkspace(page);
    await enableClipboardDebug(page);

    try {
      await switchToGridMode(page);
      const copyMarker = `GRID_COPY_SECRET_${Date.now()}`;
      await createVisibleTerminalSelection(page, copyMarker, false, workspace.tabId);
      await setMemoryClipboardWriteRejection(page, true);
      const copyCountBefore = await countClipboardActionEvents(page, 'grid-context-menu');
      await openTerminalContextMenuForTab(page, workspace.tabId);
      await clickCopyMenuItem(page);
      await expect.poll(() => readClipboardWriteCallCount(page), { timeout: 5_000 }).toBe(1);
      const attemptedSelection = (await readClipboardWriteCalls(page))[0] ?? '';
      expect(attemptedSelection).toContain(copyMarker);
      await expectClipboardActionAfterCount(page, copyCountBefore, {
        action: 'copy',
        source: 'grid-context-menu',
        outcome: 'rejected',
        reason: 'clipboard-write-failed',
        payloadBytes: new TextEncoder().encode(attemptedSelection).byteLength,
        secret: attemptedSelection,
      }, RED_SIGNATURES.gridPaste);
      await openTerminalContextMenuForTab(page, workspace.tabId);
      await expect(
        page.locator('.context-menu-item').filter({ hasText: '복사' }).first(),
        'copy rejection must retain the Grid selection',
      ).not.toHaveClass(/disabled/);
      await page.keyboard.press('Escape');

      await setMemoryClipboardWriteRejection(page, false);
      const payload = `GRID_CLIPBOARD_${Date.now()}`;
      await setMemoryClipboardText(page, payload);
      const pasteCountBefore = await countClipboardActionEvents(page, 'grid-context-menu');
      inputFrames.length = 0;
      await openTerminalContextMenuForTab(page, workspace.tabId);
      await clickPasteMenuItem(page);

      await expectExactPayloadInput(
        inputFrames,
        workspace.sessionId,
        payload,
        RED_SIGNATURES.gridPaste,
      );
      await expectClipboardActionAfterCount(page, pasteCountBefore, {
        action: 'paste',
        source: 'grid-context-menu',
        outcome: 'accepted',
        payloadBytes: new TextEncoder().encode(payload).byteLength,
        secret: payload,
      }, RED_SIGNATURES.gridPaste);
      await expectTerminalFocusRestored(page);
    } finally {
      try {
        await switchToTabMode(page);
      } finally {
        await cleanupClipboardWorkspace(page, workspace);
      }
    }
  });

  test('late clipboard read during IME target switch rejects the old target without input', async ({ page }) => {
    await installDeferredClipboardReader(page);
    const inputFrames = captureInputFrames(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateClipboardWorkspace(page);
    await enableClipboardDebug(page);

    const payload = `LATE_CLIPBOARD_${Date.now()}`;
    await setMemoryClipboardText(page, payload);
    const actionCountBefore = await countClipboardActionEvents(page, 'tab-context-menu');
    inputFrames.length = 0;

    try {
      await focusTerminalHost(page, workspace.tabId);
      const helper = page.locator('.xterm-helper-textarea:focus');
      await helper.focus();
      await helper.dispatchEvent('compositionstart', { data: '한' });
      await openTerminalContextMenu(page);
      await clickPasteMenuItem(page);
      await expect.poll(() => isDeferredClipboardReadStarted(page), {
        message: 'E2E precondition failed: clipboard read did not start',
        timeout: 5_000,
      }).toBe(true);

      const replacementSessionId = await restartClipboardWorkspaceTab(page, workspace);
      await expect.poll(() => getSelectedUiSessionId(page), { timeout: 10_000 }).toBe(replacementSessionId);

      await resolveDeferredClipboardRead(page);

      await page.waitForTimeout(250);
      expect(inputFrames, RED_SIGNATURES.contextRace).toHaveLength(0);
      await expectClipboardActionAfterCount(page, actionCountBefore, {
        action: 'paste',
        source: 'tab-context-menu',
        outcome: 'rejected',
        reason: 'context-changed',
        payloadBytes: new TextEncoder().encode(payload).byteLength,
        secret: payload,
      }, RED_SIGNATURES.contextRace);
    } finally {
      await cleanupClipboardWorkspace(page, workspace);
    }
  });

  test('late Grid clipboard read rejects when another tile becomes active', async ({ page }) => {
    await installDeferredClipboardReader(page);
    const inputFrames = captureInputFrames(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateClipboardWorkspace(page);
    const payload = `GRID_LATE_CLIPBOARD_${Date.now()}\nWrite-Output WRONG_SESSION`;

    try {
      const second = await addClipboardWorkspaceTab(page, workspace.workspaceId);
      await enableClipboardDebug(page);
      await setMemoryClipboardText(page, payload);
      const actionCountBefore = await countClipboardActionEvents(page, 'grid-context-menu');
      await switchToGridMode(page);
      await focusTerminalHost(page, workspace.tabId);
      inputFrames.length = 0;

      await openTerminalContextMenuForTab(page, workspace.tabId);
      await clickPasteMenuItem(page);
      await expect.poll(() => isDeferredClipboardReadStarted(page), {
        message: 'E2E precondition failed: Grid clipboard read did not start',
        timeout: 5_000,
      }).toBe(true);

      await focusTerminalHost(page, second.tabId);
      await resolveDeferredClipboardRead(page);

      await page.waitForTimeout(250);
      expect(
        inputFrames.filter(frame => (
          frame.sessionId === workspace.sessionId || frame.sessionId === second.sessionId
        )),
        RED_SIGNATURES.gridActivePaneRace,
      ).toHaveLength(0);
      await expectClipboardActionAfterCount(page, actionCountBefore, {
        action: 'paste',
        source: 'grid-context-menu',
        outcome: 'rejected',
        reason: 'context-changed',
        payloadBytes: new TextEncoder().encode(payload).byteLength,
        secret: payload,
      }, RED_SIGNATURES.gridActivePaneRace);
    } finally {
      try {
        await switchToTabMode(page);
      } finally {
        await cleanupClipboardWorkspace(page, workspace);
      }
    }
  });
});

function captureInputFrames(page: Page): CapturedInputFrame[] {
  const frames: CapturedInputFrame[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      try {
        const payload = typeof frame.payload === 'string'
          ? frame.payload
          : Buffer.from(frame.payload as Buffer).toString('utf8');
        const parsed = JSON.parse(payload) as { type?: string; sessionId?: string; data?: string };
        if (parsed.type === 'input' && typeof parsed.data === 'string') {
          frames.push({ sessionId: parsed.sessionId, data: parsed.data });
        }
      } catch {
        // Binary and non-JSON frames are outside the input adapter contract.
      }
    });
  });
  return frames;
}

function visibleHelper(page: Page) {
  return page.locator('.terminal-view:visible .xterm-helper-textarea').first();
}

async function createVisibleTerminalSelection(
  page: Page,
  marker: string,
  forceSelection = true,
  tabId?: string,
): Promise<void> {
  if (tabId) {
    await focusTerminalHost(page, tabId);
  }
  const helper = tabId
    ? page.locator('.xterm-helper-textarea:focus')
    : visibleHelper(page);
  await expect(helper).toHaveCount(1);
  await helper.focus();
  await expect.poll(async () => (
    (await page.locator('.terminal-view:visible .xterm-rows').innerText()).includes('PS ')
  ), {
    timeout: 15_000,
    message: 'E2E precondition failed: fresh PowerShell prompt did not become visible',
  }).toBe(true);
  await page.keyboard.type(`Write-Output ${marker}`);
  await page.keyboard.press('Enter');
  const row = page.locator('.terminal-view:visible .xterm-rows > div').filter({ hasText: marker }).last();
  await expect(row).toBeVisible({ timeout: 10_000 });
  const box = await row.boundingBox();
  if (!box) {
    throw new Error('E2E precondition failed: selected terminal row has no bounding box');
  }
  const y = box.y + box.height / 2;
  if (forceSelection) {
    await page.keyboard.down('Shift');
  }
  try {
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, y, { steps: 12 });
    await page.mouse.up();
  } finally {
    if (forceSelection) {
      await page.keyboard.up('Shift');
    }
  }
  await helper.focus();
}

async function installRejectingClipboardWriter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __e2eClipboardWriteCalls?: string[] };
    state.__e2eClipboardWriteCalls = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => '',
        writeText: async (text: string) => {
          state.__e2eClipboardWriteCalls!.push(text);
          throw new DOMException('denied by E2E', 'NotAllowedError');
        },
      },
    });
  });
}

async function readClipboardWriteCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window as typeof window & { __e2eClipboardWriteCalls?: string[] };
    return state.__e2eClipboardWriteCalls?.length ?? 0;
  });
}

async function installMemoryClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __e2eClipboardText?: string;
      __e2eClipboardWriteCalls?: string[];
      __e2eClipboardRejectWrites?: boolean;
    };
    state.__e2eClipboardText = '';
    state.__e2eClipboardWriteCalls = [];
    state.__e2eClipboardRejectWrites = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => state.__e2eClipboardText ?? '',
        writeText: async (text: string) => {
          state.__e2eClipboardWriteCalls!.push(text);
          if (state.__e2eClipboardRejectWrites) {
            throw new DOMException('denied by E2E', 'NotAllowedError');
          }
          state.__e2eClipboardText = text;
        },
      },
    });
  });
}

async function installDeferredClipboardReader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __e2eClipboardText?: string;
      __e2eClipboardReadStarted?: boolean;
      __e2eResolveClipboardRead?: (() => void) | null;
    };
    state.__e2eClipboardText = '';
    state.__e2eClipboardReadStarted = false;
    state.__e2eResolveClipboardRead = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => new Promise<string>((resolve) => {
          state.__e2eClipboardReadStarted = true;
          state.__e2eResolveClipboardRead = () => resolve(state.__e2eClipboardText ?? '');
        }),
        writeText: async (text: string) => { state.__e2eClipboardText = text; },
      },
    });
  });
}

async function setMemoryClipboardText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const state = window as typeof window & { __e2eClipboardText?: string };
    state.__e2eClipboardText = value;
  }, text);
}

async function setMemoryClipboardWriteRejection(page: Page, reject: boolean): Promise<void> {
  await page.evaluate((next) => {
    const state = window as typeof window & { __e2eClipboardRejectWrites?: boolean };
    state.__e2eClipboardRejectWrites = next;
  }, reject);
}

async function readClipboardWriteCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = window as typeof window & { __e2eClipboardWriteCalls?: string[] };
    return [...(state.__e2eClipboardWriteCalls ?? [])];
  });
}

async function isDeferredClipboardReadStarted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = window as typeof window & { __e2eClipboardReadStarted?: boolean };
    return state.__e2eClipboardReadStarted === true;
  });
}

async function resolveDeferredClipboardRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & { __e2eResolveClipboardRead?: (() => void) | null };
    const resolve = state.__e2eResolveClipboardRead;
    if (!resolve) {
      throw new Error('E2E precondition failed: deferred clipboard resolver is unavailable');
    }
    state.__e2eResolveClipboardRead = null;
    resolve();
  });
}

async function enableClipboardDebug(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__buildergateTerminalDebug?.clear();
    window.__buildergateTerminalDebug?.enable();
  });
}

async function countClipboardActionEvents(page: Page, source: string): Promise<number> {
  return page.evaluate((expectedSource) => {
    return (window.__buildergateTerminalDebug?.getEvents() ?? []).filter((event) => (
      event.kind === 'terminal_clipboard_action'
      && event.details?.source === expectedSource
    )).length;
  }, source);
}

async function expectClipboardActionAfterCount(
  page: Page,
  previousCount: number,
  expected: {
    action: 'copy' | 'paste';
    source: string;
    outcome: 'accepted' | 'rejected';
    payloadBytes: number;
    reason?: string;
    secret: string;
    count?: number;
  },
  signature: string,
): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(({ countBefore, matcher }) => {
      const events = (window.__buildergateTerminalDebug?.getEvents() ?? []).filter((event) => (
        event.kind === 'terminal_clipboard_action'
        && event.details?.source === matcher.source
      ));
      const next = events.slice(countBefore);
      const expectedCount = matcher.count ?? 1;
      if (next.length !== expectedCount) {
        return { count: next.length, matches: false, rawPayloadExposed: false };
      }
      return {
        count: next.length,
        matches: next.every((event) => (
          event.details?.action === matcher.action
          && event.details?.source === matcher.source
          && event.details?.outcome === matcher.outcome
          && event.details?.payloadBytes === matcher.payloadBytes
          && (matcher.reason === undefined || event.details?.reason === matcher.reason)
        )),
        rawPayloadExposed: next.some(event => JSON.stringify(event).includes(matcher.secret)),
      };
    }, { countBefore: previousCount, matcher: expected });
  }, { message: signature, timeout: 5_000 }).toEqual({
    count: expected.count ?? 1,
    matches: true,
    rawPayloadExposed: false,
  });
}

async function expectExactPayloadInput(
  frames: CapturedInputFrame[],
  sessionId: string,
  payload: string,
  signature: string,
): Promise<void> {
  await expect.poll(() => normalizeBracketedPasteFrames(
    frames.filter(frame => frame.sessionId === sessionId).map(frame => frame.data).join(''),
  ), {
    message: signature,
    timeout: 10_000,
  }).toBe(payload);
}

function normalizeBracketedPasteFrames(value: string): string {
  return value.replaceAll('\u001b[200~', '').replaceAll('\u001b[201~', '');
}

async function clickCopyMenuItem(page: Page): Promise<void> {
  await page.locator('.context-menu-item').filter({ hasText: '복사' }).first().click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
}

async function clickPasteMenuItem(page: Page): Promise<void> {
  await page.locator('.context-menu-item').filter({ hasText: '붙여넣기' }).first().click();
  await expect(page.locator('.context-menu')).toHaveCount(0);
}

async function switchToGridMode(page: Page): Promise<void> {
  const switchButton = page.getByTitle('Switch to Grid');
  if (await switchButton.isVisible()) {
    await switchButton.click();
  }
  await expect(page.getByTitle('Switch to Tabs')).toBeVisible();
  await expect(page.locator('.grid-cell .xterm-screen:visible').first()).toBeVisible({ timeout: 15_000 });
}

async function switchToTabMode(page: Page): Promise<void> {
  const switchButton = page.getByTitle('Switch to Tabs');
  if (await switchButton.isVisible()) {
    await switchButton.click();
  }
  await expect(page.getByTitle('Switch to Grid')).toBeVisible();
  await expect(page.locator('.workspace-tabbar [role="tab"][aria-selected="true"]')).toBeVisible();
}

async function getSelectedUiSessionId(page: Page): Promise<string | null> {
  const controls = await page.locator('.workspace-tabbar [role="tab"][aria-selected="true"]')
    .getAttribute('aria-controls');
  return controls?.startsWith('terminal-') ? controls.slice('terminal-'.length) : null;
}

async function focusTerminalHost(page: Page, tabId: string): Promise<void> {
  const host = page.locator(`[data-terminal-host-slot="${tabId}"]`);
  await expect(host).toBeVisible({ timeout: 10_000 });
  const box = await host.boundingBox();
  if (!box) throw new Error('E2E precondition failed: terminal host has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
}

async function openTerminalContextMenuForTab(page: Page, tabId: string): Promise<void> {
  const host = page.locator(`[data-terminal-host-slot="${tabId}"]`);
  await expect(host).toBeVisible({ timeout: 10_000 });
  const box = await host.boundingBox();
  if (!box) throw new Error('E2E precondition failed: terminal host has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('.context-menu')).toBeVisible({ timeout: 5_000 });
}

async function activateClipboardWorkspace(page: Page): Promise<ClipboardWorkspaceContext> {
  const context = await page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E precondition failed: missing auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const name = `E2E Clipboard ${Date.now().toString().slice(-10)}`;
    const createWorkspace = () => fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name }),
    });
    let workspaceResponse = await createWorkspace();
    if (workspaceResponse.status === 409) {
      const stateResponse = await fetch('/api/workspaces', { headers });
      if (!stateResponse.ok) throw new Error(`workspace fetch failed: ${stateResponse.status}`);
      const state = await stateResponse.json();
      const staleWorkspaces = (state.workspaces as Array<{ id: string; name: string }>).filter(
        item => item.name.startsWith('E2E Clipboard '),
      );
      for (const stale of staleWorkspaces) {
        const cleanup = await fetch(`/api/workspaces/${stale.id}`, { method: 'DELETE', headers });
        if (!cleanup.ok && cleanup.status !== 404) {
          throw new Error(`stale clipboard workspace cleanup failed: ${cleanup.status}`);
        }
      }
      workspaceResponse = await createWorkspace();
    }
    if (!workspaceResponse.ok) {
      throw new Error(`clipboard workspace create failed: ${workspaceResponse.status}`);
    }
    const workspace = await workspaceResponse.json();
    try {
      const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ shell: 'powershell', name: 'E2E Clipboard PowerShell' }),
      });
      if (!tabResponse.ok) throw new Error(`clipboard tab create failed: ${tabResponse.status}`);
      const tab = await tabResponse.json();
      localStorage.setItem('active_workspace_id', workspace.id);
      return {
        workspaceId: workspace.id,
        tabId: tab.id,
        sessionId: tab.sessionId,
      };
    } catch (error) {
      await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE', headers }).catch(() => undefined);
      throw error;
    }
  });
  try {
    await page.reload();
    await waitForTerminal(page);
    await expect.poll(() => getSelectedUiSessionId(page), { timeout: 15_000 }).toBe(context.sessionId);
    await focusTerminalHost(page, context.tabId);
    return context;
  } catch (error) {
    await cleanupClipboardWorkspace(page, context).catch(() => undefined);
    throw error;
  }
}

async function restartClipboardWorkspaceTab(
  page: Page,
  context: ClipboardWorkspaceContext,
): Promise<string> {
  return page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`/api/workspaces/${input.workspaceId}/tabs/${input.tabId}/restart`, {
      method: 'POST',
      headers,
    });
    if (!response.ok) throw new Error(`clipboard tab restart failed: ${response.status}`);
    const tab = await response.json();
    return tab.sessionId as string;
  }, context);
}

async function addClipboardWorkspaceTab(
  page: Page,
  workspaceId: string,
): Promise<{ tabId: string; sessionId: string }> {
  const tab = await page.evaluate(async (id) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`/api/workspaces/${id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ shell: 'powershell', name: 'E2E Clipboard Second' }),
    });
    if (!response.ok) throw new Error(`second clipboard tab create failed: ${response.status}`);
    return response.json() as Promise<{ id: string; sessionId: string }>;
  }, workspaceId);
  await page.reload();
  await waitForTerminal(page);
  await expect(page.locator(`[data-terminal-host-slot="${tab.id}"]`)).toBeAttached({ timeout: 15_000 });
  return { tabId: tab.id, sessionId: tab.sessionId };
}

async function cleanupClipboardWorkspace(
  page: Page,
  context: ClipboardWorkspaceContext,
): Promise<void> {
  await page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`/api/workspaces/${input.workspaceId}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`E2E cleanup failed: clipboard workspace delete returned ${response.status}`);
    }
    const verification = await fetch('/api/workspaces', { headers });
    if (!verification.ok) throw new Error(`E2E cleanup verification failed: ${verification.status}`);
    const state = await verification.json();
    if (state.workspaces.some((workspace: { id?: string }) => workspace.id === input.workspaceId)) {
      throw new Error('E2E cleanup failed: clipboard workspace still exists');
    }
  }, context);
}
