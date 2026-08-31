import { test, expect, type Page } from '@playwright/test';
import { login, sendVisibleTerminalCommand, waitForTerminal } from './helpers';

/**
 * A workspace switch while a long-running agent holds the terminal must not
 * leave the terminal reading "세션이 종료되었습니다".
 *
 * The overlay is gated on `tab.status === 'disconnected'`, and reaching it
 * unmounts the terminal host: the only way back is the restart button, which
 * kills whatever the agent was doing. So the status is not cosmetic, and it must
 * mean the session is actually gone.
 *
 * The path that produced it did not mean that. A re-subscribe asks for an atomic
 * restore snapshot, that snapshot was refused for any session with writes on its
 * headless chain — which a redrawing TUI holds continuously — and the refusal
 * arrived at the client as a `session:error` it could not tell apart from an
 * exited shell.
 *
 * Discrimination measured 2026-08-31: with the server-side fixes reverted this
 * spec reports `session:error` in roughly one run in three, and with them in
 * place ten consecutive runs produced none. It is still a sampling test — a
 * green run is weaker evidence than the unit coverage in
 * `server/src/services/SessionManagerBusySnapshot.test.ts`,
 * `server/src/services/SessionManagerBusyResize.test.ts` and
 * `server/src/ws/WsRouterRestoreAuthorityBudget.test.ts` — so read a single
 * failure here as a signal to repeat, not as proof either way.
 */

const SESSION_ENDED = '세션이 종료되었습니다';

async function fetchWorkspaceState(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    return res.json();
  });
}

async function createWorkspace(page: Page, name: string) {
  return page.evaluate(async ({ name }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`workspace create failed: ${res.status}`);
    return res.json();
  }, { name });
}

async function createTab(page: Page, workspaceId: string, shell?: string) {
  return page.evaluate(async ({ workspaceId, shell }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ shell }),
    });
    if (!res.ok) throw new Error(`tab create failed: ${res.status}`);
    return res.json();
  }, { workspaceId, shell });
}

async function findWorkspaceOption(page: Page, workspaceName: string) {
  return page.getByRole('option', { name: workspaceName }).first();
}

async function readVisibleTerminalText(page: Page) {
  const text = await page.locator('.terminal-view:visible .xterm-rows').first().textContent();
  return text ?? '';
}


interface CapturedFrame { type?: string; reason?: string; message?: string }

declare global {
  interface Window {
    __busyAgentFrames?: CapturedFrame[];
  }
}

/** Records the control frames the server sends, so a refusal is visible even
 * when the client recovers from it without showing anything. */
async function captureServerFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__busyAgentFrames = [];
    const Original = window.WebSocket;
    class Recording extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const parsed = JSON.parse(event.data) as CapturedFrame;
            if (typeof parsed?.type === 'string') window.__busyAgentFrames!.push(parsed);
          } catch {
            // Binary data-plane frames are not control frames.
          }
        });
      }
    }
    window.WebSocket = Recording as unknown as typeof WebSocket;
  });
}

async function readCapturedFrames(page: Page): Promise<CapturedFrame[]> {
  return page.evaluate(() => window.__busyAgentFrames ?? []);
}

/** Tab statuses as the client currently holds them, straight from the store. */
async function readTabStatuses(page: Page, workspaceId: string): Promise<string[]> {
  const state = await fetchWorkspaceState(page);
  return state.tabs
    .filter((tab: { workspaceId: string }) => tab.workspaceId === workspaceId)
    .map((tab: { status: string }) => tab.status);
}


const TEST_WORKSPACE_PREFIXES = ['BusyAgent-', 'BounceTarget-', 'Diag-', 'AuthoritySource-', 'SwitchTarget-', 'Authority', 'Test'];

/**
 * Workspaces are a bounded resource: a leftover from an earlier run makes the
 * next `POST /api/workspaces` answer 409, which would surface as this test
 * failing for a reason that has nothing to do with what it checks.
 */
async function deleteTestWorkspaces(page: Page): Promise<void> {
  await page.evaluate(async (prefixes) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/workspaces', { headers });
    if (!res.ok) return;
    const state = await res.json();
    const active = localStorage.getItem('active_workspace_id');
    for (const workspace of state.workspaces as Array<{ id: string; name: string }>) {
      if (workspace.id === active) continue;
      if (!prefixes.some((prefix: string) => workspace.name.startsWith(prefix))) continue;
      await fetch(`/api/workspaces/${workspace.id}`, { method: 'DELETE', headers });
    }
  }, TEST_WORKSPACE_PREFIXES);
}

test.describe('Busy agent survives workspace bounce', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await captureServerFrames(page);
    await login(page);
    await waitForTerminal(page);
    await deleteTestWorkspaces(page);
  });

  test.afterEach(async ({ page }) => {
    // The agent process keeps running inside its tab, so an undeleted workspace
    // leaves a live codex behind and starves the next run of its quota.
    await page.evaluate(() => localStorage.removeItem('active_workspace_id')).catch(() => {});
    await deleteTestWorkspaces(page).catch(() => {});
  });

  test('a codex session is not reported as ended after bouncing workspaces', async ({ page }) => {
    // codex boots its MCP servers before drawing; the default 60s covers neither
    // that nor the bounces that follow.
    test.setTimeout(240_000);
    const stamp = Date.now();
    const agentWorkspace = await createWorkspace(page, `BusyAgent-${stamp}`);
    const otherWorkspace = await createWorkspace(page, `BounceTarget-${stamp}`);
    await createTab(page, agentWorkspace.id, 'auto');

    await page.evaluate((id) => localStorage.setItem('active_workspace_id', id), agentWorkspace.id);
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 15000 });
    await waitForTerminal(page);

    const agentOption = await findWorkspaceOption(page, agentWorkspace.name);
    await agentOption.click();
    await expect(agentOption).toHaveAttribute('aria-selected', 'true');

    // codex draws a full-screen TUI and keeps redrawing it, which is what holds
    // the headless write chain non-empty for as long as it runs.
    await sendVisibleTerminalCommand(page, 'codex');
    // codex may open on an update notice; nothing else draws until it is
    // dismissed, so clear it before waiting for the banner.
    await page.waitForTimeout(4000);
    if ((await readVisibleTerminalText(page)).includes('Update available')) {
      await page.keyboard.press('2');
      await page.waitForTimeout(2000);
    }
    // The banner proves codex is actually drawing, which is the precondition of
    // this test: a prompt alone would make every assertion below vacuous.
    await expect.poll(
      async () => readVisibleTerminalText(page),
      { timeout: 60000, message: 'codex never drew its interface' },
    ).toContain('OpenAI Codex');

    const otherOption = await findWorkspaceOption(page, otherWorkspace.name);
    await page.evaluate(() => { window.__busyAgentFrames = []; });

    // One switch is enough to ask for a restore; several make the race reliable.
    for (let bounce = 0; bounce < 4; bounce += 1) {
      await otherOption.click();
      await expect(otherOption).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(150);
      await agentOption.click();
      await expect(agentOption).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(150);

      await expect(
        page.getByText(SESSION_ENDED),
        `the terminal reported the session as ended on bounce ${bounce + 1}`,
      ).toHaveCount(0);
    }

    const statuses = await readTabStatuses(page, agentWorkspace.id);
    expect(statuses, 'a tab was left disconnected after the bounces').not.toContain('disconnected');

    // The overlay is the symptom; these are the refusals that lead to it. A busy
    // session is not a fault, so neither should appear.
    const frames = await readCapturedFrames(page);
    const rejections = frames.filter(frame => frame.type === 'screen-repair:rejected');
    console.log('screen-repair rejection reasons:', JSON.stringify(rejections.map(f => f.reason)));
    expect(
      rejections.filter(frame => frame.reason === 'headless-busy'),
      'the server refused a screen repair for a session that was merely busy',
    ).toEqual([]);
    // Asserted again. It was demoted to an observation while the server side was
    // open: measured 2026-08-30 it appeared in roughly one run in three. After
    // the restore-authority sampling ramp replaced the 32ms budget, ten
    // consecutive runs produced none. A running session is not an error.
    expect(
      frames.filter(frame => frame.type === 'session:error').map(frame => frame.message),
      'the server reported a session error for a running session',
    ).toEqual([]);
  });
});
