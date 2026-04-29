import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

type TerminalDebugEvent = {
  kind: string;
  details?: Record<string, unknown>;
  preview?: string;
};

async function createFreshPowerShellWorkspace(page: Page, name: string) {
  return page.evaluate(async ({ workspaceName }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const extractWorkspaceTimestamp = (name: string) => {
      const match = name.match(/(?:PW-(?:IME|KEYS)|SwitchTarget|E2E Equal(?: Grid| Reorder)?|REAL DND|DBG Verify|ROOTCAUSE)[ -]?(\d+)/);
      return match ? Number.parseInt(match[1], 10) : 0;
    };
    const isEvictableTestWorkspace = (name: string) =>
      name.startsWith('PW-IME-')
      || name.startsWith('PW-KEYS-')
      || name.startsWith('E2E Equal ')
      || name.startsWith('SwitchTarget-')
      || name.startsWith('REAL DND ')
      || name.startsWith('DBG Verify ')
      || name.startsWith('ROOTCAUSE ');

    const createWorkspace = async () => fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name: workspaceName }),
    });

    let res = await createWorkspace();
    for (let attempt = 0; res.status === 409 && attempt < 20; attempt += 1) {
      const stateRes = await fetch('/api/workspaces', { headers });
      if (!stateRes.ok) throw new Error(`workspace fetch failed: ${stateRes.status}`);
      const state = await stateRes.json();
      const evictCandidate = (state.workspaces as Array<{ id: string; name: string }>).filter(
        (w) => isEvictableTestWorkspace(w.name),
      ).sort((left, right) => extractWorkspaceTimestamp(left.name) - extractWorkspaceTimestamp(right.name))[0] ?? null;
      if (!evictCandidate) {
        break;
      }
      const deleteRes = await fetch(`/api/workspaces/${evictCandidate.id}`, { method: 'DELETE', headers });
      if (!deleteRes.ok && deleteRes.status !== 404) throw new Error(`workspace delete failed: ${deleteRes.status}`);
      res = await createWorkspace();
    }
    if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);

    const workspace = await res.json();
    const tabRes = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!tabRes.ok) throw new Error(`tab create failed: ${tabRes.status}`);
    const tab = await tabRes.json();
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspace, tab };
  }, { workspaceName: name });
}

async function readVisibleTerminalText(page: Page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    const activeInput = activeElement instanceof HTMLTextAreaElement ? activeElement : null;
    const visibleViews = Array.from(document.querySelectorAll('.terminal-view')).filter((node) => {
      if (!(node instanceof HTMLElement)) return false;
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

async function activateFreshWorkspace(page: Page) {
  await createFreshPowerShellWorkspace(page, `PW-IME-${Date.now()}`);
  await page.reload();
  await waitForTerminal(page);
  await expect.poll(async () => await readVisibleTerminalText(page), { timeout: 15000 }).toContain('PS ');
}

async function getActiveSessionId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) return null;
    const res = await fetch('/api/workspaces', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const state = await res.json();
    const workspaceId = localStorage.getItem('active_workspace_id');
    const workspace = state.workspaces?.find((w: { id: string }) => w.id === workspaceId)
      ?? state.workspaces?.[0];
    if (!workspace) return null;
    const tab = state.tabs?.find((t: { id: string }) => t.id === workspace.activeTabId);
    return tab?.sessionId ?? null;
  });
}

async function startTerminalDebug(page: Page, sessionId: string) {
  await page.evaluate(async (id) => {
    await (window as any).__buildergateTerminalDebug?.start(id);
  }, sessionId);
}

async function getDebugEvents(page: Page, sessionId: string): Promise<TerminalDebugEvent[]> {
  return page.evaluate((id) => {
    return (window as any).__buildergateTerminalDebug?.getEvents(id) ?? [];
  }, sessionId);
}

async function focusHelperTextarea(page: Page) {
  const input = page.getByRole('textbox', { name: 'Terminal input' }).first();
  await input.click();
}

function getActiveHelperTextareaSnippet() {
  return `
    (() => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea')) {
        return active;
      }
      throw new Error('focused helper textarea not found; focus it first');
    })()
  `;
}

async function enterKoreanComposition(page: Page) {
  await page.evaluate(`(() => {
    const ta = ${getActiveHelperTextareaSnippet()};
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    for (const partial of ['이', '이곳', '이곳에', '이곳에서']) {
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: partial }));
    }
  })()`);
}

async function exitKoreanComposition(page: Page, finalText: string) {
  await page.evaluate((text) => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea')) {
      active.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
    }
  }, finalText);
}

function assertNoRawInputDebugLeak(events: TerminalDebugEvent[], raw: string) {
  const inputEvents = events.filter((event) => [
    'helper_keydown',
    'helper_beforeinput',
    'helper_input',
    'helper_compositionstart',
    'helper_compositionupdate',
    'helper_compositionend',
    'xterm_data_emitted',
    'ws_input_sent',
    'manual_input_forwarded',
    'key_event_observed',
    'ime_guard_delegated',
  ].includes(event.kind));

  for (const event of inputEvents) {
    expect(event.details?.code).toBeUndefined();
    expect(event.details?.key).toBeUndefined();
    for (const value of Object.values(event.details ?? {})) {
      if (typeof value === 'string') {
        expect(value).not.toContain(raw);
      }
    }
    if (event.preview !== undefined) {
      expect(event.preview).not.toContain(raw);
    }
  }
}

test.describe('Terminal Korean IME', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop Chrome 전용 회귀 테스트');
    await login(page);
    await waitForTerminal(page);
    await activateFreshWorkspace(page);
  });

  test('TC-IME-01: compositionend 직전 Space race에서 IME 가드가 keydown을 xterm 네이티브로 위임한다', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Active session required');
    await startTerminalDebug(page, sessionId!);
    await focusHelperTextarea(page);
    await page.waitForTimeout(300);

    await enterKoreanComposition(page);
    await page.keyboard.press('Space');
    await exitKoreanComposition(page, '이곳에서');
    await page.waitForTimeout(300);

    const events = await getDebugEvents(page, sessionId!);
    const guardEvents = events.filter((e) => e.kind === 'ime_guard_delegated');
    expect(guardEvents.length, `ime_guard_delegated 이벤트가 기록되지 않음. events=${JSON.stringify(events.map((e) => e.kind))}`).toBeGreaterThan(0);

    const compositionKinds = events
      .filter((e) => String(e.kind).startsWith('helper_composition'))
      .map((e) => e.kind);
    expect(compositionKinds).toEqual(expect.arrayContaining([
      'helper_compositionstart',
      'helper_compositionupdate',
      'helper_compositionend',
    ]));
    const compositionEvents = events.filter((e) => String(e.kind).startsWith('helper_composition'));
    expect(compositionEvents.every((e) => typeof e.details?.compositionSeq === 'number')).toBe(true);
    expect(compositionEvents.every((e) => e.details?.dataLength !== undefined)).toBe(true);
    expect(JSON.stringify(compositionEvents)).not.toContain('이곳에서');
    assertNoRawInputDebugLeak(events, '이곳에서');

    const manualSpace = events.filter((e) => e.kind === 'manual_input_forwarded' && e.details?.keyCategory === 'space');
    expect(manualSpace.length, `race 중 수동 Space 경로가 호출됨: ${JSON.stringify(manualSpace)}`).toBe(0);
  });

  test('TC-IME-02: IME 비활성 상태의 Space는 기존 수동 경로(manual_input_forwarded)로 그대로 전송된다', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Active session required');
    await startTerminalDebug(page, sessionId!);
    await focusHelperTextarea(page);
    await page.waitForTimeout(300);

    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);

    const events = await getDebugEvents(page, sessionId!);
    const spaceForwarded = events.filter(
      (e) => e.kind === 'manual_input_forwarded' && e.details?.keyCategory === 'space',
    );
    expect(spaceForwarded.length, `영문 Space 회귀 (manual_input_forwarded 미기록): events=${JSON.stringify(events.map((e) => e.kind))}`).toBe(3);
    expect(spaceForwarded.every((e) => e.details?.key === undefined && e.details?.safeKeyName == null)).toBe(true);

    const guardEvents = events.filter((e) => e.kind === 'ime_guard_delegated');
    expect(guardEvents.length, `IME 비활성인데 가드가 오작동: ${JSON.stringify(guardEvents)}`).toBe(0);
  });

  test('TC-IME-03: IME 조합 중 Backspace는 가드에 의해 xterm 네이티브로 위임된다', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Active session required');
    await startTerminalDebug(page, sessionId!);
    await focusHelperTextarea(page);
    await page.waitForTimeout(300);

    await page.evaluate(`(() => {
      const ta = ${getActiveHelperTextareaSnippet()};
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '안' }));
    })()`);
    await page.keyboard.press('Backspace');
    await exitKoreanComposition(page, '안');
    await page.waitForTimeout(300);

    const events = await getDebugEvents(page, sessionId!);
    const guardEvents = events.filter((e) => e.kind === 'ime_guard_delegated' && e.details?.safeKeyName === 'Backspace');
    expect(guardEvents.length, `IME 조합 중 Backspace에 대해 가드 미작동: ${JSON.stringify(events.map((e) => e.kind))}`).toBeGreaterThan(0);

    const manualBackspace = events.filter((e) => e.kind === 'manual_input_forwarded' && e.details?.safeKeyName === 'Backspace');
    expect(manualBackspace.length, `IME 중 수동 Backspace 경로 호출됨: ${JSON.stringify(manualBackspace)}`).toBe(0);
    assertNoRawInputDebugLeak(events, '안');
  });
});
