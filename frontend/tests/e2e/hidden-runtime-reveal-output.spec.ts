import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// A workspace hidden longer than resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs loses its
// browser terminals and gets new ones when shown again. Reported 2026-10-02: after moving back
// to such a workspace a Claude Code terminal kept showing content 80 columns wide (the size of a
// terminal that was never fitted) in a 308-column view, while the server's raw output showed
// Claude drawing at the full width -- the revealed terminal no longer applied its output.
// Run against a server whose hiddenRuntimeTtlMs is short (e.g. 2000).

const ORIGIN = 'https://localhost:2222';
const LOAD = fileURLToPath(new URL('./fixtures/ink-like-redraw-tui.mjs', import.meta.url));

function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}
function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

interface Ws { id: string; name: string; sessions: string[] }

async function frameState(page: Page, sessionId: string) {
  return page.evaluate((id) => {
    const debug = window.__buildergateTerminalDebug;
    const lengths = debug?.captureTerminalBufferLengths?.(id) ?? null;
    const text = debug?.captureTerminalText?.(id) ?? '';
    const lines = text.split('\n');
    const frames = [...text.matchAll(/F(\d{6}) L\d\d/g)].map((m) => Number(m[1]));
    const top = lines.filter((line) => line.includes('┌')).at(-1) ?? '';
    return {
      cols: lengths?.cols ?? null,
      frame: frames.length ? Math.max(...frames) : null,
      borderWidth: top.trimEnd().length,
    };
  }, sessionId);
}

test.describe('Revealing a workspace after its hidden runtime expired', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 2700, height: 1500 }, isMobile: false });

  test('the recreated terminal keeps applying output at its own width', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
    test.setTimeout(900_000);
    const ownerId = `hidden-runtime-reveal-output/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    const headers = { Authorization: `Bearer ${token}` };
    const create = async (label: string, grid: boolean, tabs: number): Promise<Ws> => {
      const name = `e2e-reveal-${label}-${randomUUID().slice(0, 6)}`;
      const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
      const list = async () => ((await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as { tabs: Array<{ workspaceId: string; sessionId: string }> })
        .tabs.filter((t) => t.workspaceId === ws.id).map((t) => t.sessionId);
      for (let i = (await list()).length; i < tabs; i += 1) {
        expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: `${label}${i + 1}` } })).status()).toBe(201);
      }
      if (grid) await request.patch(`${ORIGIN}/api/workspaces/${ws.id}`, { headers, data: { viewMode: 'grid' } });
      return { id: ws.id, name, sessions: await list() };
    };
    const busyTab = await create('tab', false, 1);
    const busyGrid = await create('grid', true, 2);
    const other = await create('other', false, 1);
    await page.reload();
    await page.waitForSelector('.workspace-screen');
    const open = async (ws: Ws) => {
      await page.locator('.workspace-item', { hasText: ws.name }).first().click();
      await page.waitForTimeout(500);
    };
    for (const ws of [busyTab, busyGrid]) {
      await open(ws);
      await page.waitForTimeout(1500);
      for (const sessionId of ws.sessions) {
        await sendVisibleTerminalCommand(page, `$env:PRE='200'; $env:TICK='250'; node "${hostPath(LOAD)}"`, { sessionId });
      }
    }

    const problems: string[] = [];
    const rounds = Number(process.env.REVEAL_ROUNDS ?? 8);
    const hiddenMs = Number(process.env.REVEAL_HIDDEN_MS ?? 6000);
    for (let round = 0; round < rounds; round += 1) {
      for (const ws of [busyTab, busyGrid]) {
        await open(other);
        await page.waitForTimeout(hiddenMs);
        await open(ws);
        await page.waitForTimeout(4000);
        for (const sessionId of ws.sessions) {
          const first = await frameState(page, sessionId);
          await page.waitForTimeout(2000);
          const second = await frameState(page, sessionId);
          const advancing = first.frame !== null && second.frame !== null && second.frame > first.frame;
          const widthOk = second.cols !== null && second.borderWidth === second.cols - 2;
          const line = `round ${round} ${ws.name.split('-')[2]} ${sessionId.slice(0, 8)} cols=${second.cols} border=${second.borderWidth} frames ${first.frame}->${second.frame}`;
          console.log(line);
          if (!advancing || !widthOk) problems.push(line);
        }
      }
    }
    expect(problems, 'revealed terminals keep applying output at their own width').toEqual([]);
  });
});
