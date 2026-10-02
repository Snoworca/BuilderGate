import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// Reported 2026-10-02 (diagnostic capture buildergate-diag-1790951231404): after moving back to a
// workspace, a terminal stayed frozen on old content until the page was reloaded. On reveal its
// local snapshot could not be restored (hidden_output_recovery_restore_failed). The failure path
// left the hidden-output replay pending, which holds the input barrier at 'replay-pending'; the
// screen repair meant to fetch a fresh screen was then refused because of that same barrier
// (screen_repair_deferred_input_active), so live output kept being skipped while visible.
// A missing local snapshot is the simplest way to make the local restore fail.

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

async function lastFrame(page: Page, sessionId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const text = window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? '';
    const frames = [...text.matchAll(/F(\d{6}) L\d\d/g)].map((m) => Number(m[1]));
    return frames.length ? Math.max(...frames) : null;
  }, sessionId);
}

test.describe('Revealing a workspace whose local snapshot cannot be restored', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1800, height: 1000 }, isMobile: false });

  for (const grid of [false, true]) {
    test(`the terminal keeps applying output (${grid ? 'grid' : 'tab'} mode)`, async ({ page, request }, testInfo) => {
      test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
      test.setTimeout(300_000);
      const ownerId = `hidden-reveal-restore-failed/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
      await login(page);
      const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
      const headers = { Authorization: `Bearer ${token}` };
      const create = async (label: string, tabs: number, asGrid: boolean): Promise<Ws> => {
        const name = `e2e-restorefail-${label}-${randomUUID().slice(0, 6)}`;
        const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
        const list = async () => ((await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as { tabs: Array<{ workspaceId: string; sessionId: string }> })
          .tabs.filter((t) => t.workspaceId === ws.id).map((t) => t.sessionId);
        for (let i = (await list()).length; i < tabs; i += 1) {
          expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: `${label}${i + 1}` } })).status()).toBe(201);
        }
        if (asGrid) await request.patch(`${ORIGIN}/api/workspaces/${ws.id}`, { headers, data: { viewMode: 'grid' } });
        return { id: ws.id, name, sessions: await list() };
      };
      const busy = await create('busy', grid ? 2 : 1, grid);
      const other = await create('other', 1, false);
      await page.reload();
      await page.waitForSelector('.workspace-screen');
      await page.evaluate(() => window.__buildergateTerminalDebug?.enable());
      const open = async (ws: Ws) => {
        await page.locator('.workspace-item', { hasText: ws.name }).first().click();
        await page.waitForTimeout(500);
      };
      await open(busy);
      await page.waitForTimeout(1500);
      for (const sessionId of busy.sessions) {
        await sendVisibleTerminalCommand(page, `$env:PRE='50'; $env:TICK='200'; node "${hostPath(LOAD)}"`, { sessionId });
      }
      await page.waitForTimeout(2000);

      const problems: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        await open(other);
        await page.waitForTimeout(2500);
        await page.evaluate((ids) => {
          for (const id of ids) localStorage.removeItem(`terminal_snapshot_${id}`);
        }, busy.sessions);
        await open(busy);
        await page.waitForTimeout(3000);
        for (const sessionId of busy.sessions) {
          const first = await lastFrame(page, sessionId);
          await page.waitForTimeout(2000);
          const second = await lastFrame(page, sessionId);
          const kinds = await page.evaluate((id) => (window.__buildergateTerminalDebug?.getEvents(id) ?? [])
            .map((e) => e.kind)
            .filter((k) => /hidden_output_recovery|screen_repair_deferred|screen_snapshot_ack_sent/.test(k))
            .slice(-6), sessionId);
          const line = `round ${round} ${sessionId.slice(0, 8)} frames ${first}->${second} [${kinds.join(' ')}]`;
          console.log(line);
          if (first === null || second === null || second <= first) problems.push(line);
        }
      }
      expect(problems, 'a revealed terminal whose local restore failed keeps applying output').toEqual([]);
    });
  }
});
