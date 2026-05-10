import { test, expect, type Page } from '@playwright/test';
import {
  clearTerminalShortcuts,
  login,
  openTerminalShortcutDialog,
  waitForTerminal,
} from './helpers';

test.describe('Terminal Shortcut Manager', () => {
  let e2eWorkspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only shortcut manager coverage');
    await login(page);
    e2eWorkspaceId = await createFreshTerminalShortcutWorkspace(page, `KBD-E2E-${Date.now()}`);
    await page.reload();
    await waitForTerminal(page);
    await clearTerminalShortcuts(page);
    await expectActiveSessionStatus(page, 'idle');
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome') return;
    await clearTerminalShortcuts(page);
    if (e2eWorkspaceId) {
      await resetWorkspaceTerminalShortcuts(page, e2eWorkspaceId);
      await deleteWorkspace(page, e2eWorkspaceId);
      e2eWorkspaceId = null;
    }
  });

  test('opens from tools menu and captures Escape and Tab through WindowDialog capture mode', async ({ page }) => {
    await openTerminalShortcutDialog(page);

    const dialog = page.getByTestId('terminal-shortcut-dialog');
    await expect(dialog.getByRole('tab', { name: '캡처' })).toHaveAttribute('aria-selected', 'true');

    await dialog.getByRole('button', { name: '감지 시작' }).click();
    await expectActiveSessionStatus(page, 'idle');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.terminal-shortcut-capture-value')).toContainText('Escape');
    await expectActiveSessionStatus(page, 'idle');

    await dialog.getByLabel('단축키 설명').fill('e2e-terminal-shortcut:escape');
    await dialog.getByRole('button', { name: '테스트 전송' }).click();
    await expectActiveSessionStatus(page, 'idle');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('tab', { name: '등록 목록' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('.terminal-shortcut-binding-item', { hasText: 'Escape' })).toBeVisible();
    await dialog.getByLabel('Escape 수정').click();
    await dialog.getByLabel('단축키 설명').fill('e2e-terminal-shortcut:escape-edited');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.locator('.terminal-shortcut-binding-item', { hasText: 'escape-edited' })).toBeVisible();

    await dialog.getByRole('tab', { name: '캡처' }).click();
    await dialog.getByRole('button', { name: '감지 시작' }).click();
    await page.keyboard.press('Tab');
    await expect(dialog.locator('.terminal-shortcut-capture-value')).toContainText('Tab');

    await dialog.getByLabel('단축키 설명').fill('e2e-terminal-shortcut:tab');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.locator('.terminal-shortcut-binding-item', { hasText: 'Tab' })).toBeVisible();
    await expectActiveSessionStatus(page, 'idle');

    await dialog.getByLabel('Escape 삭제').click();
    await expect(page.getByRole('alertdialog', { name: '삭제 확인' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.locator('.terminal-shortcut-binding-item', { hasText: 'Escape' })).toBeVisible();
  });

  test('applies ai-tui-compat profile and sends Shift+Enter through shortcut path without xterm duplicate', async ({ page }) => {
    await setActiveWorkspaceTerminalShortcutProfile(page, 'ai-tui-compat');
    await createWorkspaceShiftEnterCodexBinding(page);
    await page.reload();
    await waitForTerminal(page);
    await startTerminalDebugForAllSessions(page);
    await expectActiveSessionStatus(page, 'idle');

    await page.locator('.terminal-view[data-terminal-view="true"]:visible').first().click({ position: { x: 24, y: 24 } });
    await focusTerminalInput(page);
    await page.keyboard.press('Shift+Enter');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page);
      return events.some((event: { kind: string }) => event.kind === 'shortcut_binding_sent');
    }, { timeout: 10000 }).toBe(true);

    const events = await getTerminalDebugEvents(page);
    expect(events.some((event: { kind: string }) => event.kind === 'shortcut_binding_matched')).toBe(true);
    expect(events.some((event: { kind: string }) => event.kind === 'shortcut_binding_sent')).toBe(true);
    const sentEvent = events.find((event: { kind: string }) => event.kind === 'shortcut_binding_sent') as {
      preview?: string;
      details?: { escapeCount?: number; enterCount?: number };
    } | undefined;
    expect(sentEvent?.preview).toBe('\\x1b\\r');
    expect(sentEvent?.details?.escapeCount).toBe(1);
    expect(sentEvent?.details?.enterCount).toBe(1);
    expect(events.filter((event: { kind: string; details?: { hasEnter?: boolean } }) =>
      event.kind === 'xterm_data_emitted' && event.details?.hasEnter === true,
    )).toHaveLength(0);
  });
});

async function createFreshTerminalShortcutWorkspace(page: Page, workspaceName: string): Promise<string> {
  return page.evaluate(async (name) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

    const createWorkspace = async () => fetch('/api/workspaces', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
    });

    let createWorkspaceResponse = await createWorkspace();
    for (let attempt = 0; createWorkspaceResponse.status === 409 && attempt < 12; attempt += 1) {
      const stateResponse = await fetch('/api/workspaces', { headers: authHeaders });
      if (!stateResponse.ok) break;
      const state = await stateResponse.json();
      const oldWorkspace = state.workspaces
        .filter((workspace: { name: string }) => workspace.name.startsWith('KBD-E2E-'))
        .sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name))[0];
      if (!oldWorkspace) break;
      await fetch(`/api/terminal-shortcuts/reset`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ scope: 'workspace', workspaceId: oldWorkspace.id }),
      });
      await fetch(`/api/workspaces/${oldWorkspace.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      createWorkspaceResponse = await createWorkspace();
    }

    if (!createWorkspaceResponse.ok) {
      throw new Error(`workspace create failed: ${createWorkspaceResponse.status}`);
    }
    const workspace = await createWorkspaceResponse.json();
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!tabResponse.ok) {
      throw new Error(`tab create failed: ${tabResponse.status}`);
    }
    localStorage.setItem('active_workspace_id', workspace.id);
    return workspace.id as string;
  }, workspaceName);
}

async function resetWorkspaceTerminalShortcuts(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async (targetWorkspaceId) => {
    const token = localStorage.getItem('cws_auth_token');
    await fetch('/api/terminal-shortcuts/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ scope: 'workspace', workspaceId: targetWorkspaceId }),
    });
  }, workspaceId);
}

async function deleteWorkspace(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async (targetWorkspaceId) => {
    const token = localStorage.getItem('cws_auth_token');
    await fetch(`/api/workspaces/${targetWorkspaceId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }, workspaceId);
}

async function setActiveWorkspaceTerminalShortcutProfile(page: Page, profile: 'xterm-default' | 'ai-tui-compat'): Promise<void> {
  await page.evaluate(async (nextProfile) => {
    const token = localStorage.getItem('cws_auth_token');
    const workspaceId = localStorage.getItem('active_workspace_id');
    if (!workspaceId) {
      throw new Error('active workspace missing');
    }
    const response = await fetch('/api/terminal-shortcuts/profile', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ scope: 'workspace', workspaceId, profile: nextProfile }),
    });
    if (!response.ok) {
      throw new Error(`profile update failed: ${response.status}`);
    }
  }, profile);
}

async function createWorkspaceShiftEnterCodexBinding(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const workspaceId = localStorage.getItem('active_workspace_id');
    if (!workspaceId) {
      throw new Error('active workspace missing');
    }
    const response = await fetch('/api/terminal-shortcuts/bindings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        scope: 'workspace',
        workspaceId,
        key: 'Enter',
        code: 'Enter',
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        location: 0,
        action: { type: 'send', data: '\x1b\r', label: 'Codex 줄바꿈' },
        description: 'e2e-terminal-shortcut:codex-newline',
      }),
    });
    if (!response.ok) {
      throw new Error(`binding create failed: ${response.status}`);
    }
  });
}

async function startTerminalDebugForAllSessions(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__buildergateTerminalDebug?.clear();
    window.__buildergateTerminalDebug?.enable();
  });
}

async function getTerminalDebugEvents(page: Page) {
  return page.evaluate(() => {
    return window.__buildergateTerminalDebug?.getEvents() ?? [];
  });
}

async function focusTerminalInput(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: 'Terminal input' }).first().click();
}

async function expectActiveSessionStatus(page: Page, expected: 'idle' | 'running'): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(async () => {
      const token = localStorage.getItem('cws_auth_token');
      const activeWorkspaceId = localStorage.getItem('active_workspace_id');
      const response = await fetch('/api/workspaces', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return null;
      const state = await response.json();
      const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
      const tab = state.tabs.find((item: { id: string }) => item.id === workspace?.activeTabId);
      if (!tab?.sessionId) return null;
      const sessionResponse = await fetch('/api/sessions', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!sessionResponse.ok) return null;
      const sessions = await sessionResponse.json();
      const session = Array.isArray(sessions)
        ? sessions.find((item: { id: string }) => item.id === tab.sessionId)
        : null;
      return session?.status ?? null;
    });
  }, { timeout: 15000 }).toBe(expected);
}
