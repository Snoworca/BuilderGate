// FR-AITUI-010 AC-4..AC-7 — an AI TUI session stays "실행 중" while it waits
// on a subagent or a long tool call and only its working indicator moves, and
// returns to "대기" once the screen stops. Claude Code, Codex and Hermes each
// draw that indicator differently (see fixtures/fake-ai-tui-spinner.mjs).
//
// No real agent runs. The agent's command name is defined as a PowerShell
// function in the test tab that starts the fixture; the server knows the
// foreground app from the submitted command name, as it does for the real one.
//
// Fixture: per test one workspace with one tab, created through
// createOwnedWorkspaceViaApi and removed by id.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { test, expect, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { clearRecoveryOptionsForE2E, createRecoveryOptionViaApi, login, sendVisibleTerminalCommand, waitForTerminal } from './helpers';

const ORIGIN = 'https://localhost:2222';
const FAKE_TUI = fileURLToPath(new URL('./fixtures/fake-ai-tui-spinner.mjs', import.meta.url));
const BUSY_MS = 9000;
const IDLE_MS = 6000;

// `alias` stands for a command known only through a recovery option, like the
// user's `claudep`; the built-in detector knows exact names only.
const AGENTS = [
  { command: 'claude', mode: 'claude', onScreen: 'Task(Research the codebase)', alias: false },
  { command: 'codex', mode: 'codex', onScreen: 'Working (', alias: false },
  { command: 'hermes', mode: 'hermes', onScreen: 'pondering...', alias: false },
  { command: 'e2e-recovery-claudealias', mode: 'claude', onScreen: 'Task(Research the codebase)', alias: true },
] as const;

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

test.describe('AI TUI 작업 중 상태', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  for (const agent of AGENTS) {
    test(`${agent.alias ? '복구 옵션 별칭' : agent.command}: 작업 표시만 움직이는 동안에도 실행 중으로 보인다`, async ({ page, request }, testInfo) => {
      test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
      test.setTimeout(90_000);
      const ownerId = `ai-tui-busy-status/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;

      await login(page);
      const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
      if (!token) throw new Error('login left no auth token');
      const headers = { Authorization: `Bearer ${token}` };
      const workspaceName = `e2e-busy-${randomUUID().slice(0, 8)}`;
      const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name: workspaceName } });

      try {
        if (agent.alias) await createRecoveryOptionViaApi(page, { command: agent.command, arguments: ['--continue'] });
        const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: 'e2e-busy-tab' } });
        expect(createdTab.status()).toBe(201);
        await page.reload();
        await page.waitForSelector('.workspace-screen', { timeout: 15000 });
        const row = page.locator('.sidebar [role="option"]', { hasText: workspaceName });
        await row.click();
        await waitForTerminal(page);
        await page.waitForTimeout(1500);

        const dot = row.locator('.workspace-item-dot');
        await sendVisibleTerminalCommand(page, `function ${agent.command} { node "${FAKE_TUI}" ${agent.mode} ${BUSY_MS} ${IDLE_MS} }`);
        await expect(dot).toHaveAttribute('aria-label', '대기', { timeout: 10000 });

        await sendVisibleTerminalCommand(page, agent.command);
        // Precondition: the fake is on screen, so the samples below are about it.
        await expect(page.locator('.terminal-view:visible .xterm-screen').first()).toContainText(agent.onScreen, { timeout: 10000 });
        const startedAt = Date.now();

        // From 1.5 s in, only the working indicator moves. Sample the dot in the
        // page every 250 ms until 1.5 s before the fake stops.
        await page.waitForTimeout(1500);
        const sampleMs = BUSY_MS - 1500 - (Date.now() - startedAt);
        const samples = await page.evaluate(async ({ name, ms }) => {
          const out: string[] = [];
          const until = performance.now() + ms;
          while (performance.now() < until) {
            const item = Array.from(document.querySelectorAll('.sidebar [role="option"]')).find(el => el.textContent?.includes(name));
            out.push(item?.querySelector('.workspace-item-dot')?.getAttribute('aria-label') ?? 'missing');
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return out;
        }, { name: workspaceName, ms: sampleMs });
        const idleSamples = samples.filter(label => label !== '실행 중').length;
        console.log(`[ai-tui-busy] ${agent.command} samples=${samples.length} notRunning=${idleSamples} labels=${samples.join(',')}`);
        await page.screenshot({ path: `../.playwright-mcp/ai-tui-busy-status-${agent.alias ? 'alias' : agent.command}.png` });

        expect(samples.length).toBeGreaterThan(10);
        expect(idleSamples, 'every sample while only the working indicator moves reads 실행 중').toBe(0);

        // After the indicator stops, the dot returns to 대기 (grace 1.5 s + margin).
        await expect(dot).toHaveAttribute('aria-label', '대기', { timeout: BUSY_MS + 3000 });
      } finally {
        // Only the e2e-recovery- options this spec made; the user's own stay.
        if (agent.alias) await clearRecoveryOptionsForE2E(page);
        const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
        if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
      }
    });
  }
});
