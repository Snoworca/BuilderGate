import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers';

const WORKSPACE_PREFIX = 'PW-MOBILE-SCROLL-';
const SCROLL_MARKER_PREFIX = 'BG-MOBILE';
const SCROLL_LINE_COUNT = 160;

async function getPreferredShell(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch('/api/sessions/shells', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`shell fetch failed: ${response.status}`);
    }

    const shells = await response.json() as Array<{ id: string }>;
    const preferredOrder = ['powershell', 'bash', 'zsh', 'sh', 'wsl', 'cmd'];
    return preferredOrder.find((shellId) => shells.some((entry) => entry.id === shellId)) ?? null;
  });
}

async function createFreshWorkspace(page: Page, shell: string, workspaceName: string) {
  return page.evaluate(async ({ shellId, nextWorkspaceName, prefix }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const extractWorkspaceTimestamp = (name: string) => {
      const match = name.match(/(?:PW-(?:MOBILE-SCROLL|KEYS|IME)|SwitchTarget|E2E Equal(?: Grid| Reorder)?|REAL DND|DBG Verify|ROOTCAUSE)[ -]?(\d+)/);
      return match ? Number.parseInt(match[1], 10) : 0;
    };
    const isEvictableTestWorkspace = (name: string) =>
      name.startsWith(prefix)
      || name.startsWith('PW-KEYS-')
      || name.startsWith('PW-IME-')
      || name.startsWith('E2E Equal ')
      || name.startsWith('SwitchTarget-')
      || name.startsWith('REAL DND ')
      || name.startsWith('DBG Verify ')
      || name.startsWith('ROOTCAUSE ');

    const createWorkspace = async () => {
      return fetch('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ name: nextWorkspaceName }),
      });
    };

    let workspaceResponse = await createWorkspace();
    for (let attempt = 0; workspaceResponse.status === 409 && attempt < 20; attempt += 1) {
      const stateResponse = await fetch('/api/workspaces', { headers });
      if (!stateResponse.ok) {
        throw new Error(`workspace fetch failed: ${stateResponse.status}`);
      }

      const state = await stateResponse.json();
      const evictCandidate = state.workspaces
        .filter((entry: { name: string }) => isEvictableTestWorkspace(entry.name))
        .sort((left: { name: string }, right: { name: string }) => extractWorkspaceTimestamp(left.name) - extractWorkspaceTimestamp(right.name))[0] ?? null;

      if (evictCandidate) {
        const deleteResponse = await fetch(`/api/workspaces/${evictCandidate.id}`, {
          method: 'DELETE',
          headers,
        });
        if (!deleteResponse.ok) {
          throw new Error(`workspace delete failed: ${deleteResponse.status}`);
        }
        workspaceResponse = await createWorkspace();
      } else {
        break;
      }
    }

    if (!workspaceResponse.ok) {
      throw new Error(`workspace create failed: ${workspaceResponse.status}`);
    }

    const workspace = await workspaceResponse.json();
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ shell: shellId }),
    });

    if (!tabResponse.ok) {
      throw new Error(`tab create failed: ${tabResponse.status}`);
    }

    const tab = await tabResponse.json();
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspace, tab };
  }, { shellId: shell, nextWorkspaceName: workspaceName, prefix: WORKSPACE_PREFIX });
}

async function waitForTerminalReady(page: Page) {
  await page.waitForSelector('.terminal-view:visible', { timeout: 30000 });
  await expect.poll(async () => {
    return page.evaluate(() => {
      const visibleView = Array.from(document.querySelectorAll('.terminal-view')).find((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const input = visibleView?.querySelector('textarea.xterm-helper-textarea');
      return input instanceof HTMLTextAreaElement && !input.disabled;
    });
  }, { timeout: 30000 }).toBe(true);
}

async function activateFreshWorkspace(page: Page, shell: string) {
  await createFreshWorkspace(page, shell, `${WORKSPACE_PREFIX}${Date.now()}`);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.reload();
    try {
      await waitForTerminalReady(page);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function getActiveSessionId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const activeWorkspaceId = localStorage.getItem('active_workspace_id');
    const response = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`workspace fetch failed: ${response.status}`);
    }

    const state = await response.json();
    const workspace = state.workspaces.find((entry: { id: string }) => entry.id === activeWorkspaceId) ?? state.workspaces[0];
    const tab = state.tabs.find((entry: { id: string; sessionId?: string }) => entry.id === workspace.activeTabId);
    return tab?.sessionId ?? null;
  });
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const visibleViews = Array.from(document.querySelectorAll('.terminal-view')).filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const terminalView = visibleViews[0] ?? null;
    const rows = terminalView?.querySelector('.xterm-rows');
    return rows?.textContent ?? '';
  });
}

function buildScrollCommand(shell: string): string {
  switch (shell) {
    case 'powershell':
      return `1..${SCROLL_LINE_COUNT} | ForEach-Object { Write-Output "${SCROLL_MARKER_PREFIX}-$_" }`;
    case 'cmd':
      return `for /L %i in (1,1,${SCROLL_LINE_COUNT}) do @echo ${SCROLL_MARKER_PREFIX}-%i`;
    default:
      return `i=1; while [ $i -le ${SCROLL_LINE_COUNT} ]; do echo ${SCROLL_MARKER_PREFIX}-$i; i=$((i+1)); done`;
  }
}

async function focusVisibleTerminal(page: Page) {
  await page.locator('.terminal-view:visible').first().click({ position: { x: 36, y: 36 } });
}

async function runScrollbackCommand(page: Page, shell: string) {
  await focusVisibleTerminal(page);
  await page.keyboard.type(buildScrollCommand(shell), { delay: 0 });
  await page.keyboard.press('Enter');
}

async function startTerminalDebug(page: Page, sessionId: string) {
  await page.evaluate(async (targetSessionId) => {
    await window.__buildergateTerminalDebug?.start(targetSessionId);
  }, sessionId);
}

async function getTerminalDebugEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => {
    return window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? [];
  }, sessionId);
}

async function dispatchSingleTouchDrag(page: Page, selector: string) {
  await page.evaluate(async (targetSelector) => {
    const element = Array.from(document.querySelectorAll(targetSelector)).find((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!(element instanceof HTMLElement)) {
      throw new Error(`target not found: ${targetSelector}`);
    }

    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height * 0.35;
    const endY = rect.top + rect.height * 0.85;
    const steps = 16;

    const makeTouch = (identifier: number, x: number, y: number) => {
      return {
        identifier,
        target: element,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
        radiusX: 1,
        radiusY: 1,
        rotationAngle: 0,
        force: 0.5,
      } as Touch;
    };

    const dispatch = (type: string, touches: Touch[], changedTouches: Touch[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches, configurable: true });
      Object.defineProperty(event, 'targetTouches', { value: touches, configurable: true });
      Object.defineProperty(event, 'changedTouches', { value: changedTouches, configurable: true });
      element.dispatchEvent(event);
    };

    let currentTouch = makeTouch(1, clientX, startY);
    dispatch('touchstart', [currentTouch], [currentTouch]);

    for (let step = 1; step <= steps; step += 1) {
      const nextY = startY + ((endY - startY) * step) / steps;
      currentTouch = makeTouch(1, clientX, nextY);
      dispatch('touchmove', [currentTouch], [currentTouch]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    dispatch('touchend', [], [currentTouch]);
  }, selector);
}

async function dispatchPinchOut(page: Page, selector: string) {
  await page.evaluate(async (targetSelector) => {
    const element = Array.from(document.querySelectorAll(targetSelector)).find((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!(element instanceof HTMLElement)) {
      throw new Error(`target not found: ${targetSelector}`);
    }

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const startOffset = 32;
    const endOffset = 84;
    const steps = 10;

    const makeTouch = (identifier: number, x: number, y: number) => {
      return {
        identifier,
        target: element,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
        radiusX: 1,
        radiusY: 1,
        rotationAngle: 0,
        force: 0.5,
      } as Touch;
    };

    const dispatch = (type: string, touches: Touch[], changedTouches: Touch[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches, configurable: true });
      Object.defineProperty(event, 'targetTouches', { value: touches, configurable: true });
      Object.defineProperty(event, 'changedTouches', { value: changedTouches, configurable: true });
      element.dispatchEvent(event);
    };

    let touchA = makeTouch(1, centerX - startOffset, centerY);
    let touchB = makeTouch(2, centerX + startOffset, centerY);
    dispatch('touchstart', [touchA, touchB], [touchA, touchB]);

    for (let step = 1; step <= steps; step += 1) {
      const offset = startOffset + ((endOffset - startOffset) * step) / steps;
      touchA = makeTouch(1, centerX - offset, centerY);
      touchB = makeTouch(2, centerX + offset, centerY);
      dispatch('touchmove', [touchA, touchB], [touchA, touchB]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    dispatch('touchend', [], [touchA, touchB]);
  }, selector);
}

async function readStoredFontSize(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('terminal_font_size');
    if (!raw) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  });
}

test.describe('Terminal Mobile Scroll', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Mobile Safari', 'Mobile-only regression coverage');
    await login(page);
  });

  test('TC-MOBILE-01: single-touch vertical drag should move terminal scrollback', async ({ page }) => {
    const shell = await getPreferredShell(page);
    test.skip(!shell, 'Need an available interactive shell');

    await activateFreshWorkspace(page, shell);
    await expect.poll(async () => {
      return page.locator('.terminal-view[data-terminal-view="true"]').first().evaluate((element) => {
        return getComputedStyle(element as HTMLElement).touchAction;
      });
    }, { timeout: 5000 }).toBe('none');

    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await runScrollbackCommand(page, shell);
    await expect.poll(async () => readVisibleTerminalText(page), { timeout: 20000 }).toContain(`${SCROLL_MARKER_PREFIX}-${SCROLL_LINE_COUNT}`);

    const beforeText = await readVisibleTerminalText(page);
    await startTerminalDebug(page, sessionId);
    await dispatchSingleTouchDrag(page, '.terminal-view[data-terminal-view="true"]');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events
        .filter((event: any) => event.kind === 'mobile_touch_scroll_applied')
        .some((event: any) => typeof event.details?.viewportBefore === 'number'
          && typeof event.details?.viewportAfter === 'number'
          && event.details.viewportAfter < event.details.viewportBefore
          && typeof event.details?.scrollLines === 'number'
          && event.details.scrollLines < 0);
    }, { timeout: 5000 }).toBe(true);

    await expect.poll(async () => {
      return (await readVisibleTerminalText(page)) !== beforeText;
    }, { timeout: 5000 }).toBe(true);
  });

  test('TC-MOBILE-02: two-touch pinch should keep changing terminal font size', async ({ page }) => {
    const shell = await getPreferredShell(page);
    test.skip(!shell, 'Need an available interactive shell');

    await activateFreshWorkspace(page, shell);
    await page.evaluate(() => {
      localStorage.removeItem('terminal_font_size');
    });

    const beforeSize = await readStoredFontSize(page);
    await dispatchPinchOut(page, '.terminal-view[data-terminal-view="true"]');

    await expect.poll(async () => {
      const currentSize = await readStoredFontSize(page);
      return typeof currentSize === 'number' && currentSize > (beforeSize ?? 14);
    }, { timeout: 5000 }).toBe(true);
  });
});
