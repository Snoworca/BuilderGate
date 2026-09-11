import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * SEC-MCP-003 — a real terminal does not carry the host's agent identity.
 *
 * The unit suite reads the environment object handed to the spawn. This reads
 * what a shell actually has, which is what the user meets: they open a
 * terminal, run an agent in it, and the agent either keeps a transcript or does
 * not.
 *
 * A bare "no agent variable is present" would pass on a terminal that inherited
 * nothing at all, and on one whose shell never answered. So the same command
 * reports three things and all three are judged: a control variable the terminal
 * must have inherited, the count of variables the rule covers, and an end
 * sentinel that says the shell finished.
 *
 * The count is taken over `CLAUDE*` plus `AI_AGENT` rather than over
 * `CLAUDE_CODE_*`. Five of the host's twelve carry no `CLAUDE_CODE_` prefix, and
 * a count that missed them would go green while the host's presence marker and
 * process id were still in the terminal.
 *
 * The tab is created by this spec rather than assumed. A freshly started
 * instance has workspaces with no tabs at all, and a spec that waits for a
 * terminal it did not create waits forever there.
 */

const START = 'SECMCP003-BEGIN';
const END = 'SECMCP003-END';
const TAB_NAME = `e2e-secmcp003-${Date.now()}`;

async function activeWorkspaceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const stored = localStorage.getItem('active_workspace_id');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    const state = await res.json();
    const workspace = state.workspaces.find((item: { id: string }) => item.id === stored)
      ?? state.workspaces[0];
    return workspace.id as string;
  });
}

async function addTab(page: Page, workspaceId: string, name: string): Promise<string> {
  return page.evaluate(async ({ workspaceId, name }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`tab create failed: ${res.status}`);
    const tab = await res.json();
    return tab.id as string;
  }, { workspaceId, name });
}

async function removeTab(page: Page, workspaceId: string, tabId: string): Promise<void> {
  await page.evaluate(async ({ workspaceId, tabId }) => {
    const token = localStorage.getItem('cws_auth_token');
    await fetch(`/api/workspaces/${workspaceId}/tabs/${tabId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }, { workspaceId, tabId });
}

async function sendVisibleTerminalCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('.terminal-view:visible .xterm-helper-textarea').first();
  await input.click();
  await page.keyboard.type(command, { delay: 0 });
  await page.keyboard.press('Enter');
}

/** Everything the visible terminal has on screen. */
async function visibleTerminalText(page: Page): Promise<string> {
  return (await page.locator('.terminal-view:visible .xterm-rows').first().textContent()) ?? '';
}

test.describe('session environment isolation', () => {
  test('SEC-MCP-003 a terminal inherits the ordinary environment and none of the agent namespace', async ({ page }) => {
    await login(page);

    const workspaceId = await activeWorkspaceId(page);
    const tabId = await addTab(page, workspaceId, TAB_NAME);

    try {
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      await page.waitForSelector('.terminal-view:visible .xterm-screen', { timeout: 30000 });

      // PowerShell is the default shell on this platform. `PATH` is the
      // control: every shell has one, and a terminal that inherited nothing
      // would report it empty.
      await sendVisibleTerminalCommand(
        page,
        `echo ${START}; `
        + `echo "PATHLEN=$($env:PATH.Length)"; `
        + `echo "AGENTVARS=$((Get-ChildItem Env: | Where-Object { $_.Name -like 'CLAUDE*' -or $_.Name -eq 'AI_AGENT' }).Count)"; `
        + `echo ${END}`,
      );

      await expect
        .poll(async () => visibleTerminalText(page), {
          timeout: 40000,
          message: 'the terminal never finished answering',
        })
        .toMatch(/AGENTVARS=\d+/);

      const screen = await visibleTerminalText(page);
      // The shell echoes the command before running it, so the sentinels appear
      // twice; the answer is what lies after the last START.
      const answer = screen.slice(screen.lastIndexOf(START) + START.length);

      // The control. A terminal that inherited no environment at all would
      // report zero here, and the assertion below would then hold for the wrong
      // reason.
      const pathLen = /PATHLEN=(\d+)/.exec(answer);
      expect(pathLen, `the terminal did not report PATHLEN. screen tail: ${answer}`).not.toBeNull();
      expect(Number(pathLen![1])).toBeGreaterThan(0);

      // The rule itself.
      const agentVars = /AGENTVARS=(\d+)/.exec(answer);
      expect(agentVars, `the terminal did not report AGENTVARS. screen tail: ${answer}`).not.toBeNull();
      expect(
        Number(agentVars![1]),
        `the terminal carries variables from the host agent session, so an agent run`
      + ` there keeps no transcript. What the shell reported: ${answer}`,
      ).toBe(0);
    } finally {
      await removeTab(page, workspaceId, tabId);
    }
  });
});
