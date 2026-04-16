import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

async function createFreshPowerShellWorkspace(page: Page, name: string) {
  return page.evaluate(async ({ workspaceName }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const createWorkspace = async () => {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ name: workspaceName }),
      });
      return response;
    };

    let createWorkspaceRes = await createWorkspace();
    if (createWorkspaceRes.status === 409) {
      const stateRes = await fetch('/api/workspaces', { headers });
      if (!stateRes.ok) {
        throw new Error(`workspace fetch failed: ${stateRes.status}`);
      }
      const state = await stateRes.json();
      const evictCandidate = state.workspaces.find(
        (item: { name: string }) => item.name.startsWith('PW-KEYS-'),
      ) ?? null;

      if (evictCandidate) {
        const deleteRes = await fetch(`/api/workspaces/${evictCandidate.id}`, {
          method: 'DELETE',
          headers,
        });
        if (!deleteRes.ok) {
          throw new Error(`workspace delete failed: ${deleteRes.status}`);
        }
        createWorkspaceRes = await createWorkspace();
      }
    }

    if (!createWorkspaceRes.ok) {
      throw new Error(`workspace create failed: ${createWorkspaceRes.status}`);
    }

    const workspace = await createWorkspaceRes.json();

    const createTabRes = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!createTabRes.ok) {
      throw new Error(`tab create failed: ${createTabRes.status}`);
    }
    const tab = await createTabRes.json();
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspace, tab };
  }, { workspaceName: name });
}

async function activateFreshPowerShellWorkspace(page: Page) {
  await createFreshPowerShellWorkspace(page, `PW-KEYS-${Date.now()}`);
  await page.reload();
  await waitForTerminal(page);

  await expect.poll(async () => {
    return await readVisibleTerminalText(page);
  }, { timeout: 15000 }).toContain('PS ');
}

async function startTerminalDebug(page: Page, sessionId: string) {
  await page.evaluate(async (targetSessionId) => {
    await window.__buildergateTerminalDebug?.start(targetSessionId);
  }, sessionId);
}

async function getActiveSessionId(page: Page) {
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
    const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
    const tab = state.tabs.find((item: { id: string }) => item.id === workspace.activeTabId);
    return tab?.sessionId ?? null;
  });
}

async function getManualInputEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => {
    return (window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? []).filter(
      (event) => event.kind === 'manual_input_forwarded',
    );
  }, sessionId);
}

async function getTerminalDebugEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => {
    return window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? [];
  }, sessionId);
}

async function getServerDebugEvents(page: Page, sessionId: string) {
  return page.evaluate(async (targetSessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${targetSessionId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`server debug fetch failed: ${response.status}`);
    }
    return response.json();
  }, sessionId);
}

async function dispatchAutoRepeatSpace(page: Page, repeatCount = 2) {
  const client = await page.context().newCDPSession(page);
  const baseEvent = {
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
    text: ' ',
    unmodifiedText: ' ',
  };

  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    autoRepeat: false,
    ...baseEvent,
  });

  for (let index = 0; index < repeatCount; index += 1) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      autoRepeat: true,
      ...baseEvent,
    });
  }

  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...baseEvent,
  });
}

async function focusTerminalInput(page: Page) {
  const input = page.getByRole('textbox', { name: 'Terminal input' }).first();
  await input.click();
}

async function clickVisibleTerminalSurface(page: Page) {
  const surface = page.locator('.terminal-view[data-terminal-view="true"]:visible').first();
  await surface.click({ position: { x: 24, y: 24 } });
}

async function getActiveElementInfo(page: Page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    return {
      tagName: activeElement.tagName,
      ariaLabel: activeElement.getAttribute('aria-label'),
      className: activeElement.className,
    };
  });
}

async function readVisibleTerminalText(page: Page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    const activeInput = activeElement instanceof HTMLTextAreaElement ? activeElement : null;
    const visibleViews = Array.from(document.querySelectorAll('.terminal-view')).filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const terminalView =
      activeInput?.closest('.terminal-view')
      ?? visibleViews[0]
      ?? null;
    const rows = terminalView?.querySelector('.xterm-rows');
    return rows?.textContent ?? '';
  });
}

test.describe('Terminal Keyboard Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
    await activateFreshPowerShellWorkspace(page);
  });

  test('TC-7201: repeated space auto-repeat events should visibly advance the prompt line', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await dispatchAutoRepeatSpace(page, 2);
    await page.keyboard.press('X');

    await expect.poll(async () => {
      const events = await getManualInputEvents(page, sessionId!);
      return events.map((event) => ({
        preview: event.preview,
        repeat: event.details?.repeat,
      }));
    }, { timeout: 5000 }).toEqual([
      { preview: '␠', repeat: false },
      { preview: '␠', repeat: true },
      { preview: '␠', repeat: true },
    ]);

    await expect.poll(async () => {
      const text = await readVisibleTerminalText(page);
      return />\s{2,}X/.test(text);
    }, { timeout: 5000 }).toBe(true);
  });

  test('TC-7202: plain backspace should echo without newline-like output corruption', async ({ page }) => {
    await focusTerminalInput(page);
    await page.keyboard.type('abc');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).toContain('> abc');

    await page.keyboard.press('Backspace');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).toContain('> ab');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).not.toContain('> abc');
  });

  test('TC-7204: clicking the terminal surface should focus the xterm helper textarea', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await clickVisibleTerminalSurface(page);

    await expect.poll(async () => {
      return await getActiveElementInfo(page);
    }, { timeout: 5000 }).toMatchObject({
      tagName: 'TEXTAREA',
      ariaLabel: 'Terminal input',
      className: expect.stringContaining('xterm-helper-textarea'),
    });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events
        .filter((event) => event.kind === 'focus_applied' || event.kind === 'focus_fallback_applied')
        .map((event) => event.details?.reason);
    }, { timeout: 5000 }).toEqual(expect.arrayContaining(['runtime-layer']));

    await page.keyboard.press('Z');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).toContain('> Z');
  });

  test('TC-7203: debug capture start should expose browser-side input transport events', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.map((event) => event.kind);
    }, { timeout: 5000 }).toEqual(
      expect.arrayContaining([
        'capture_started',
        'key_event_observed',
        'xterm_data_emitted',
        'ws_input_sent',
      ]),
    );

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.find((event) => event.kind === 'ws_input_sent') ?? null;
    }, { timeout: 5000 }).not.toBeNull();

    const wsInputEvent = (await getTerminalDebugEvents(page, sessionId)).find(
      (event) => event.kind === 'ws_input_sent',
    );
    expect(wsInputEvent?.details?.hasEnter).toBe(true);
    expect(wsInputEvent?.details?.enterCount).toBeGreaterThan(0);

    await expect.poll(async () => {
      const payload = await getServerDebugEvents(page, sessionId);
      const events = payload.server ?? [];
      const kinds = events.map((event: { kind: string }) => event.kind);
      return kinds.includes('input') && kinds.includes('raw_output');
    }, { timeout: 5000 }).toBe(true);

    const serverEvents = (await getServerDebugEvents(page, sessionId)).server ?? [];

    const inputIndex = serverEvents.findIndex((event: { kind: string }) => event.kind === 'input');
    const rawOutputIndex = serverEvents.findIndex((event: { kind: string }) => event.kind === 'raw_output');
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(rawOutputIndex).toBeGreaterThan(inputIndex);

    const inputEvent = serverEvents[inputIndex];
    const rawOutputEvent = serverEvents[rawOutputIndex];
    expect(inputEvent?.details?.hasEnter).toBe(true);
    expect(rawOutputEvent?.details?.recentInputSampleCount).toBeGreaterThanOrEqual(1);
    expect(rawOutputEvent?.details?.msSinceNewestInputSample).not.toBeNull();
  });
});
