import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// After moving between workspaces (and reloading), the PTY of every visible terminal must have
// the size the browser's xterm has. Reported 2026-10-02 on a 4K screen: a tab-mode terminal
// filled the screen while Claude Code drew in its left third, as if the PTY kept an old width.

const ORIGIN = 'https://localhost:2222';
const REPORTER = fileURLToPath(new URL('./fixtures/pty-size-reporter.mjs', import.meta.url));

function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}
function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

interface Ws { id: string; name: string; tabs: Array<{ id: string; sessionId: string }> }

async function sizes(page: Page, sessionId: string): Promise<{ view: string | null; pty: string | null; polled: string | null }> {
  return page.evaluate((id) => {
    const debug = window.__buildergateTerminalDebug;
    const lengths = debug?.captureTerminalBufferLengths?.(id) ?? null;
    const text = debug?.captureTerminalText?.(id) ?? '';
    const lastOf = (pattern: RegExp) => { const all = [...text.matchAll(pattern)]; const m = all.at(-1); return m ? `${m[1]}x${m[2]}` : null; };
    return {
      view: lengths ? `${lengths.cols}x${lengths.rows}` : null,
      pty: lastOf(/PTYSIZE (\d+)x(\d+)/g),
      polled: lastOf(/PTYPOLL (\d+)x(\d+)/g),
    };
  }, sessionId);
}

test.describe('PTY size follows the visible view', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 3800, height: 1950 }, isMobile: false });

  test('after workspace switches, tab switches and reloads the PTY matches the xterm', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
    test.setTimeout(900_000);
    const ownerId = `pty-size-follows-view/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    const headers = { Authorization: `Bearer ${token}` };
    const state = async () => (await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as {
      tabs: Array<{ id: string; workspaceId: string; sessionId: string }>;
    };
    const create = async (label: string, tabs: number, grid: boolean): Promise<Ws> => {
      const name = `e2e-ptysize-${label}-${randomUUID().slice(0, 6)}`;
      const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
      for (let i = (await state()).tabs.filter((t) => t.workspaceId === ws.id).length; i < tabs; i += 1) {
        expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: `${label}${i + 1}` } })).status()).toBe(201);
      }
      if (grid) await request.patch(`${ORIGIN}/api/workspaces/${ws.id}`, { headers, data: { viewMode: 'grid' } });
      return { id: ws.id, name, tabs: (await state()).tabs.filter((t) => t.workspaceId === ws.id).map((t) => ({ id: t.id, sessionId: t.sessionId })) };
    };
    // PTYSIZE_EXISTING='{"tabs":"<name>","grid":"<name>"}' runs against workspaces that already
    // exist, e.g. ones the server restored after a restart.
    const existing = process.env.PTYSIZE_EXISTING ? JSON.parse(process.env.PTYSIZE_EXISTING) as { tabs: string; grid: string } : null;
    const find = async (name: string): Promise<Ws> => {
      const all = (await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as {
        workspaces: Array<{ id: string; name: string }>; tabs: Array<{ id: string; workspaceId: string; sessionId: string }>;
      };
      const ws = all.workspaces.find((w) => w.name === name);
      if (!ws) throw new Error(`E2E precondition failed: workspace ${name} not found`);
      return { id: ws.id, name, tabs: all.tabs.filter((t) => t.workspaceId === ws.id).map((t) => ({ id: t.id, sessionId: t.sessionId })) };
    };
    const tabWs = existing ? await find(existing.tabs) : await create('tabs', 2, false);
    const gridWs = existing ? await find(existing.grid) : await create('grid', 3, true);
    await page.reload();
    await page.waitForSelector('.workspace-screen');
    const open = async (ws: Ws) => {
      await page.locator('.workspace-item', { hasText: ws.name }).first().click();
      await page.waitForTimeout(500);
    };
    const visibleSessions = async (ws: Ws, activeTab: number) => (ws === gridWs ? ws.tabs.map((t) => t.sessionId) : [ws.tabs[activeTab].sessionId]);
    const clickTab = async (index: number) => {
      await page.locator(`[role="tab"][aria-controls="terminal-${tabWs.tabs[index].sessionId}"]`).click();
      await page.waitForTimeout(500);
    };

    const enableDebug = () => page.evaluate(() => {
      const store = (window as unknown as { __buildergateTerminalDebug?: { events: unknown[]; enable(): void } }).__buildergateTerminalDebug;
      if (!store) return;
      class Unbounded extends Array { splice(start: number, count?: number) { return start === 0 && this.length > 400 ? [] : super.splice(start, count as number); } }
      if (!(store.events instanceof Unbounded)) store.events = Object.assign(new Unbounded(), store.events);
      store.enable();
    });
    await enableDebug();
    const dumpResizeEvents = async (sessionId: string) => {
      const events = await page.evaluate((id) => (window.__buildergateTerminalDebug?.getEvents(id) ?? [])
        .filter((e) => /resize|fit_|geometry/.test(e.kind))
        .slice(-25)
        .map((e) => `${e.recordedAt.slice(11, 23)} ${e.kind} ${JSON.stringify(e.details ?? {}).slice(0, 160)}`), sessionId);
      for (const e of events) console.log(`    EV ${sessionId.slice(0, 8)} ${e}`);
    };

    // Start the reporter everywhere.
    await open(tabWs);
    await page.waitForTimeout(1500);
    for (let index = 0; index < tabWs.tabs.length; index += 1) {
      await clickTab(index);
      await page.waitForTimeout(800);
      await sendVisibleTerminalCommand(page, `node "${hostPath(REPORTER)}"`, { sessionId: tabWs.tabs[index].sessionId });
    }
    await open(gridWs);
    await page.waitForTimeout(1500);
    for (const tab of gridWs.tabs) await sendVisibleTerminalCommand(page, `node "${hostPath(REPORTER)}"`, { sessionId: tab.sessionId });

    // Server-side capture (localhost only) for the grid sessions.
    for (const tab of gridWs.tabs) {
      await page.evaluate((id) => window.__buildergateTerminalDebug?.start(id), tab.sessionId);
    }
    const dumpServer = async (sessionId: string) => {
      const body = await (await request.get(`${ORIGIN}/api/sessions/debug-capture/${sessionId}?limit=500`, { headers })).json() as {
        server?: Array<{ recordedAt?: string; kind: string; details?: unknown }>;
        replay?: Array<{ recordedAt?: string; kind: string; details?: unknown }>;
      };
      const rows = [...(body.server ?? []), ...(body.replay ?? [])]
        .filter((e) => /resize|geometry|mutation|repair_reject/.test(e.kind))
        .sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)))
        .slice(-14);
      for (const e of rows) console.log(`    SRV ${sessionId.slice(0, 8)} ${String(e.recordedAt).slice(11, 23)} ${e.kind} ${JSON.stringify(e.details ?? {}).slice(0, 200)}`);
    };
    const mismatches: string[] = [];
    if (process.env.PTYSIZE_RESTART_CMD) {
      // The page stays open while the server restarts; it only reconnects its WebSocket.
      const { execFileSync } = await import('node:child_process');
      await page.waitForTimeout(40_000); // let the workspace state flush (30 s cycle)
      console.log(execFileSync('cmd.exe', ['/c', process.env.PTYSIZE_RESTART_CMD], { encoding: 'utf8' }));
      await expect.poll(async () => (await request.get(`${ORIGIN}/health`).catch(() => null))?.ok() ?? false, { timeout: 120_000 }).toBe(true);
      await page.waitForTimeout(15_000); // reconnect without a page reload
      const fresh = await find(tabWs.name);
      const freshGrid = await find(gridWs.name);
      tabWs.tabs = fresh.tabs;
      gridWs.tabs = freshGrid.tabs;
      // The restored sessions are new shells: start the reporter again, still without a reload.
      await open(tabWs);
      for (let index = 0; index < tabWs.tabs.length; index += 1) {
        await clickTab(index);
        await page.waitForTimeout(800);
        await sendVisibleTerminalCommand(page, `node "${hostPath(REPORTER)}"`, { sessionId: tabWs.tabs[index].sessionId });
      }
      await open(gridWs);
      await page.waitForTimeout(1500);
      for (const tab of gridWs.tabs) await sendVisibleTerminalCommand(page, `node "${hostPath(REPORTER)}"`, { sessionId: tab.sessionId });
    }
    let current: Ws = gridWs;
    let activeTab = 0;
    const steps = Number(process.env.PTYSIZE_STEPS ?? 30);
    for (let step = 0; step < steps; step += 1) {
      const roll = Math.random();
      let action: string;
      if (roll < Number(process.env.PTYSIZE_RELOAD_RATE ?? 0.15)) {
        action = 'reload';
        await page.reload();
        await page.waitForSelector('.workspace-screen');
        await enableDebug();
        await page.waitForTimeout(1500);
        await open(current);
      } else if (current === gridWs && roll < 0.6) {
        // Changing the grid layout mode refits every terminal through App's fit-all path.
        const mode = ['focus', 'equal', 'auto'][Math.floor(Math.random() * 3)];
        action = `layout ${mode}`;
        await page.locator('.mosaic-toolbar').first().hover();
        await page.locator(`[data-layout-mode-button="${mode}"]`).first().click();
      } else if (roll < 0.35 && current === tabWs) {
        activeTab = 1 - activeTab;
        action = `tab ${activeTab}`;
        await clickTab(activeTab);
      } else {
        current = current === tabWs ? gridWs : tabWs;
        action = `open ${current === tabWs ? 'tabs' : 'grid'}`;
        await open(current);
        if (current === tabWs) await clickTab(activeTab);
      }
      await page.waitForTimeout(3000);
      for (const sessionId of await visibleSessions(current, activeTab)) {
        const size = await sizes(page, sessionId);
        const line = `step ${step} ${action} ${sessionId.slice(0, 8)} view=${size.view} pty=${size.pty} polled=${size.polled}`;
        console.log(line);
        if (!size.view || !size.pty || size.view !== size.pty) {
          if (!mismatches.some((m) => m.includes(sessionId.slice(0, 8)))) {
            await dumpResizeEvents(sessionId);
            await dumpServer(sessionId);
          }
          mismatches.push(line);
        }
      }
    }
    expect(mismatches, 'every visible PTY has the size of its xterm').toEqual([]);
  });
});
