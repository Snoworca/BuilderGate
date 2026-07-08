import { Page, expect } from '@playwright/test';

interface RecoveryOptionPayload {
  command: string;
  arguments?: string[];
  enabled?: boolean;
  icon?: { type: 'builtin'; key: string } | { type: 'text'; value: string } | null;
}

interface RecoveryOptionRecord extends Required<Omit<RecoveryOptionPayload, 'icon'>> {
  id: string;
  icon?: RecoveryOptionPayload['icon'];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Login with password from env or default */
export async function login(page: Page) {
  const password = process.env.BUILDERGATE_PASSWORD || '1234';
  await page.goto('/');
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.workspace-screen', { timeout: 10000 });
}

/** Wait for xterm.js terminal to render */
export async function waitForTerminal(page: Page) {
  await page.waitForSelector('.xterm-screen:visible', { timeout: 15000 });
}

/** Open the command preset manager through the header tools menu */
export async function openCommandPresetDialog(page: Page): Promise<void> {
  await page.locator('button[title="Tools"]').click();
  await page.locator('.context-menu-item:has-text("명령줄 관리")').click();
  await expect(page.getByTestId('command-preset-dialog')).toBeVisible({ timeout: 10000 });
}

/** Open the terminal shortcut manager through the header tools menu */
export async function openTerminalShortcutDialog(page: Page): Promise<void> {
  await page.locator('button[title="Tools"]').click();
  await page.locator('.context-menu-item:has-text("터미널 키보드")').click();
  await expect(page.getByTestId('terminal-shortcut-dialog')).toBeVisible({ timeout: 10000 });
}

/** Open the recovery option manager through the header tools menu */
export async function openRecoveryOptionDialog(page: Page): Promise<void> {
  await page.locator('button[title="Tools"]').click();
  await page.locator('.context-menu-item:has-text("복구 옵션")').click();
  await expect(page.getByTestId('recovery-option-dialog')).toBeVisible({ timeout: 10000 });
}

/** Read recovery options directly through the API */
export async function readRecoveryOptionsViaApi(page: Page): Promise<RecoveryOptionRecord[]> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/recovery-options', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new Error(`Failed to read recovery options: ${res.status}`);
    }
    const data = await res.json();
    return Array.isArray(data.options) ? data.options : [];
  });
}

/** Create a recovery option directly through the API */
export async function createRecoveryOptionViaApi(page: Page, input: RecoveryOptionPayload): Promise<RecoveryOptionRecord> {
  return page.evaluate(async (payload) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/recovery-options', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Failed to create recovery option: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  }, input);
}

/** Remove only recovery options created by E2E tests */
export async function clearRecoveryOptionsForE2E(page: Page, prefixes = ['e2e-recovery-']): Promise<void> {
  await page.evaluate(async (commandPrefixes) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/recovery-options', { headers });
    if (!res.ok) return;
    const data = await res.json();
    const options = Array.isArray(data.options) ? data.options : [];
    await Promise.all(options
      .filter((option: { command?: string }) => commandPrefixes.some(prefix => option.command?.startsWith(prefix)))
      .map((option: { id: string }) => fetch(`/api/recovery-options/${option.id}`, {
        method: 'DELETE',
        headers,
      })));
  }, prefixes);
}

/** Ensure Claude and Codex defaults exist for repeatable recovery option E2E runs */
export async function ensureDefaultRecoveryOptionsForE2E(page: Page): Promise<void> {
  const options = await readRecoveryOptionsViaApi(page);
  const existingCommands = new Set(options.map(option => option.command));
  if (!existingCommands.has('claude')) {
    await createRecoveryOptionViaApi(page, {
      command: 'claude',
      arguments: ['--continue'],
      enabled: true,
      icon: { type: 'builtin', key: 'bot' },
    });
  }
  if (!existingCommands.has('codex')) {
    await createRecoveryOptionViaApi(page, {
      command: 'codex',
      arguments: ['resume', '--last'],
      enabled: true,
      icon: { type: 'builtin', key: 'terminal' },
    });
  }
}

/** Remove terminal shortcut E2E data from the server and local browser preferences */
export async function clearTerminalShortcuts(page: Page): Promise<void> {
  if (!page.url().startsWith('http')) {
    return;
  }

  await page.evaluate(async () => {
    if (!['http:', 'https:'].includes(location.protocol)) {
      return;
    }
    localStorage.removeItem('buildergate.terminalShortcutManager.activeTab');
    localStorage.removeItem('buildergate.dialog.terminal-shortcut-manager.geometry');
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/terminal-shortcuts', { headers });
    if (!res.ok) return;
    const data = await res.json();
    const bindings = Array.isArray(data.bindings) ? data.bindings : [];
    await Promise.all(bindings
      .filter((binding: { description?: string }) => binding.description?.startsWith('e2e-terminal-shortcut:') === true)
      .map((binding: { id: string }) => fetch(`/api/terminal-shortcuts/bindings/${binding.id}`, {
        method: 'DELETE',
        headers,
      })));
  });
}

/** Remove command preset E2E data from the server and local browser preferences */
export async function clearCommandPresets(page: Page): Promise<void> {
  if (!page.url().startsWith('http')) {
    return;
  }

  await page.evaluate(async () => {
    if (!['http:', 'https:'].includes(location.protocol)) {
      return;
    }
    localStorage.removeItem('buildergate.commandPresetManager.activeTab');
    localStorage.removeItem('buildergate.dialog.command-preset-manager.geometry');
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/command-presets', { headers });
    if (!res.ok) return;
    const data = await res.json();
    const presets = Array.isArray(data.presets) ? data.presets : [];
    await Promise.all(presets
      .filter((preset: { label?: string }) => preset.label?.startsWith('e2e-dialog-'))
      .map((preset: { id: string }) => fetch(`/api/command-presets/${preset.id}`, {
        method: 'DELETE',
        headers,
      })));
  });
}

/** Create a command preset through the dialog UI */
export async function createCommandPreset(
  page: Page,
  kind: 'command' | 'directory' | 'prompt',
  label: string,
  value: string,
): Promise<void> {
  const tabLabel = kind === 'command' ? '커맨드 라인' : kind === 'directory' ? '디렉토리' : '프롬프트';
  const dialog = page.getByTestId('command-preset-dialog');
  await dialog.getByRole('tab', { name: tabLabel }).click();
  await dialog.locator('.command-preset-form input').first().fill(label);
  if (kind === 'prompt') {
    await dialog.locator('.command-preset-form textarea').fill(value);
  } else {
    await dialog.locator('.command-preset-form input').nth(1).fill(value);
  }
  await dialog.getByRole('button', { name: '등록' }).click();
  await expect(dialog.getByText(label)).toBeVisible({ timeout: 10000 });
}

/** Create a command preset directly through the API */
export async function createCommandPresetViaApi(
  page: Page,
  kind: 'command' | 'directory' | 'prompt',
  label: string,
  value: string,
): Promise<void> {
  await page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch('/api/command-presets', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error(`Failed to create command preset: ${res.status}`);
    }
  }, { kind, label, value });
}

/** Open the visible terminal context menu on desktop or mobile */
export async function openTerminalContextMenu(
  page: Page,
  options: { mobile?: boolean; xRatio?: number; yRatio?: number; waitForMenu?: boolean; dispatchEvent?: boolean } = {},
): Promise<void> {
  const terminal = page.locator('.xterm-screen:visible').first();
  await expect(terminal).toBeVisible({ timeout: 15000 });
  const box = await terminal.boundingBox();
  if (!box) {
    throw new Error('Visible terminal screen has no bounding box');
  }

  const clientX = box.x + box.width * (options.xRatio ?? 0.5);
  const clientY = box.y + box.height * (options.yRatio ?? 0.5);
  if (options.mobile || options.dispatchEvent) {
    await terminal.dispatchEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
    });
  } else {
    await page.mouse.click(clientX, clientY, { button: 'right' });
  }

  if (options.waitForMenu !== false) {
    await page.waitForSelector('.context-menu, .context-menu-dialog', { timeout: 5000 });
  }
}

/** Assert terminal debug metadata for the registered-preset paste path */
export async function expectTerminalInputDebug(
  page: Page,
  matcher: {
    enterCount: number;
    controlCount?: number;
    byteLength?: number;
    codePointCount?: number;
    source?: string;
  },
): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate((expected) => {
      const events = window.__buildergateTerminalDebug?.getEvents() ?? [];
      return events.some((event) => {
        if (event.kind !== 'command_preset_paste_input_sent' && event.kind !== 'terminal_input_queued') {
          return false;
        }
        if (
          expected.source
          && event.kind !== 'command_preset_paste_input_sent'
          && event.details?.source !== expected.source
        ) {
          return false;
        }
        const hasEnter = event.details?.hasEnter === true;
        const controlCount = typeof event.details?.controlCount === 'number'
          ? event.details.controlCount
          : 0;
        const byteLength = typeof event.details?.byteLength === 'number'
          ? event.details.byteLength
          : undefined;
        const codePointCount = typeof event.details?.codePointCount === 'number'
          ? event.details.codePointCount
          : undefined;
        return hasEnter === (expected.enterCount > 0)
          && (expected.controlCount === undefined || controlCount === expected.controlCount)
          && (expected.byteLength === undefined || byteLength === expected.byteLength)
          && (expected.codePointCount === undefined || codePointCount === expected.codePointCount);
      });
    }, matcher);
  }, { timeout: 10000 }).toBe(true);
}

/** Assert one new registered-preset paste debug event after a captured count */
export async function expectTerminalInputDebugAfterCount(
  page: Page,
  previousCount: number,
  matcher: {
    enterCount: number;
    controlCount?: number;
    byteLength?: number;
    codePointCount?: number;
    source?: string;
  },
): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(({ expected, countBefore }) => {
      const events = window.__buildergateTerminalDebug?.getEvents() ?? [];
      const pasteEvents = events.filter((event) => {
        return event.kind === 'command_preset_paste_input_sent'
          || (
            event.kind === 'terminal_input_queued'
            && event.details?.source === 'command-preset-paste'
          );
      });
      const newEvents = pasteEvents.slice(countBefore);
      if (newEvents.length !== 1) {
        return { count: newEvents.length, matches: false };
      }

      const event = newEvents[0];
      const hasEnter = event.details?.hasEnter === true;
      const controlCount = typeof event.details?.controlCount === 'number'
        ? event.details.controlCount
        : 0;
      const byteLength = typeof event.details?.byteLength === 'number'
        ? event.details.byteLength
        : undefined;
      const codePointCount = typeof event.details?.codePointCount === 'number'
        ? event.details.codePointCount
        : undefined;
      const sourceMatches = !expected.source
        || event.kind === 'command_preset_paste_input_sent'
        || event.details?.source === expected.source;

      return {
        count: newEvents.length,
        matches: sourceMatches
          && hasEnter === (expected.enterCount > 0)
          && (expected.controlCount === undefined || controlCount === expected.controlCount)
          && (expected.byteLength === undefined || byteLength === expected.byteLength)
          && (expected.codePointCount === undefined || codePointCount === expected.codePointCount),
      };
    }, { expected: matcher, countBefore: previousCount });
  }, { timeout: 10000 }).toEqual({ count: 1, matches: true });
}

/** Assert the visible terminal surface shows a pasted value */
export async function expectTerminalScreenContains(page: Page, text: string): Promise<void> {
  await expect(page.locator('.xterm-screen:visible').first()).toContainText(text, { timeout: 10000 });
}

/** Assert the visible terminal's current prompt input exactly equals the value */
export async function expectVisibleTerminalCurrentInputEquals(page: Page, value: string): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate((expectedValue) => {
      const terminalView = Array.from(document.querySelectorAll<HTMLElement>('.terminal-view')).find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
      });
      const rowElements = terminalView
        ? Array.from(terminalView.querySelectorAll<HTMLElement>('.xterm-rows > div'))
        : [];
      const rows = rowElements.map(row => (row.textContent ?? '').replace(/\u00a0/g, ' '));

      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        const matches = Array.from(row.matchAll(/PS\s+[^>]*>\s*/g));
        const prompt = matches[matches.length - 1];
        if (!prompt || prompt.index === undefined) {
          continue;
        }
        const promptEnd = prompt.index + prompt[0].length;
        const head = row.slice(promptEnd).trimEnd();
        const continuation = rows.slice(index + 1)
          .map(nextRow => nextRow.trimEnd())
          .join('')
          .trimEnd();
        return `${head}${continuation}`.trim();
      }

      const lastNonEmptyRow = [...rows].reverse().find(row => row.trim().length > 0)?.trim() ?? '';
      if (lastNonEmptyRow === expectedValue) {
        return lastNonEmptyRow;
      }
      return `__parse_error__: no PowerShell prompt in visible terminal rows: ${JSON.stringify(rows.slice(-6))}`;
    }, value);
  }, { timeout: 10000 }).toBe(value);
}

/** Count terminal debug events emitted by the registered-preset paste path */
export async function countCommandPresetPasteDebugEvents(page: Page): Promise<number> {
  return page.evaluate(() => {
    const events = window.__buildergateTerminalDebug?.getEvents() ?? [];
    return events.filter((event) => {
      return event.kind === 'command_preset_paste_input_sent'
        || (
          event.kind === 'terminal_input_queued'
          && event.details?.source === 'command-preset-paste'
        );
    }).length;
  });
}

/** Resolve the active tab's session id from the persisted workspace state */
export async function getActiveSessionId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const activeWorkspaceId = localStorage.getItem('active_workspace_id');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new Error(`workspace fetch failed: ${res.status}`);
    }
    const state = await res.json();
    const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId)
      ?? state.workspaces[0];
    const tab = state.tabs.find((item: { id: string }) => item.id === workspace.activeTabId);
    return tab?.sessionId ?? null;
  });
}

/** Override terminal input readiness through the local debug hook */
export async function setTerminalInputTransportOverride(
  page: Page,
  sessionId: string,
  override: {
    serverReady?: boolean;
    barrierReason?: string;
    closedReason?: string;
    reconnectState?: string;
    sessionGeneration?: number;
  } | null,
): Promise<boolean> {
  return page.evaluate(({ targetSessionId, nextOverride }) => {
    return window.__buildergateTerminalDebug?.setInputTransportOverride(targetSessionId, nextOverride) ?? false;
  }, { targetSessionId: sessionId, nextOverride: override });
}

/** Assert focus has returned to the visible xterm helper textarea */
export async function expectTerminalFocusRestored(page: Page): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement
        && active.classList.contains('xterm-helper-textarea')
        && active.closest('.terminal-view') instanceof HTMLElement;
    });
  }, { timeout: 10000 }).toBe(true);
}

/** Right-click on the nth pane (0-based) */
export async function rightClickPane(page: Page, index: number) {
  const pane = page.locator('.pane-leaf').nth(index);
  await pane.click({ button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 3000 });
}

/** Click a context menu item by label text */
export async function selectMenuItem(page: Page, label: string) {
  const item = page.locator(`.context-menu-item:has-text("${label}")`).first();
  await item.click();
}

/** Count visible pane leaves */
export async function getPaneCount(page: Page): Promise<number> {
  return page.locator('.pane-leaf').count();
}

/** Wait for a specific pane count */
export async function verifyPaneCount(page: Page, expected: number) {
  await expect(page.locator('.pane-leaf')).toHaveCount(expected, { timeout: 10000 });
}

/** Clear IndexedDB for clean test state */
export async function clearIndexedDB(page: Page) {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('buildergate');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });
}

/** Simulate Ctrl+B prefix key */
export async function pressCtrlB(page: Page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
}

/** Simulate left swipe on mobile carousel */
export async function swipeLeft(page: Page, selector: string) {
  const el = page.locator(selector);
  const box = await el.boundingBox();
  if (!box) throw new Error('Element not found for swipe');
  const startX = box.x + box.width * 0.8;
  const endX = box.x + box.width * 0.2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(startX - ((startX - endX) * (i + 1)) / 10, y);
  }
  await page.mouse.up();
}

/** Drag a resizer element by a pixel offset */
export async function dragResizer(page: Page, offsetX: number, offsetY: number) {
  const resizer = page.locator('.pane-resizer').first();
  const box = await resizer.boundingBox();
  if (!box) throw new Error('Resizer not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + offsetX, cy + offsetY, { steps: 5 });
  await page.mouse.up();
}

/** Get server session count via API */
export async function getServerSessionCount(page: Page): Promise<number> {
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  });
  return result;
}
