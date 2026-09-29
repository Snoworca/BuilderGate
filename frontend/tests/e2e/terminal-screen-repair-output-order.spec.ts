import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// REL-BGSTAB-041 — a screen repair must not be followed by output it already contains.
//
// The repair patch is the server's screen at `repair.seq`. Output that reached the browser
// before the patch could still be waiting in the client output scheduler, and the patch was
// written straight to xterm ahead of it, so those chunks were applied a second time. An Ink-
// like TUI (Claude Code) then redrew one row off -- a stray top border above the frame -- and
// only a page reload cleared it. Measured on 2222 before the fix: 6/45 and 9/75 captures broken
// with repeated repairs, 18/72 twice with rapid grid workspace switching; after it 0/60 and 0/72.

const ORIGIN = 'https://localhost:2222';
const FIXTURE = fileURLToPath(new URL('./fixtures/ink-like-redraw-tui.mjs', import.meta.url));

// The shell runs on the server host. A WSL runner sees the checkout under /mnt/<drive>.
function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

interface GridWorkspace { id: string; name: string; sessions: string[] }

async function createGridWorkspace(page: Page, request: Parameters<typeof createOwnedWorkspaceViaApi>[0], ownerId: string, label: string): Promise<GridWorkspace> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('login left no auth token');
  const headers = { Authorization: `Bearer ${token}` };
  const name = `e2e-repair-order-${label}-${randomUUID().slice(0, 8)}`;
  const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
  const tabsOf = async () => ((await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json()) as { tabs: Array<{ workspaceId: string; sessionId: string }> })
    .tabs.filter((tab) => tab.workspaceId === workspace.id);
  for (let i = (await tabsOf()).length; i < 3; i += 1) {
    expect((await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, { headers, data: { name: `${label}${i + 1}` } })).status()).toBe(201);
  }
  expect((await request.patch(`${ORIGIN}/api/workspaces/${workspace.id}`, { headers, data: { viewMode: 'grid' } })).ok()).toBe(true);
  return { id: workspace.id, name, sessions: (await tabsOf()).map((tab) => tab.sessionId) };
}

// One consistent frame: one top border, 14 body rows from the same frame, one bottom border.
function frameProblem(text: string | null): string | null {
  if (text === null) return 'no-capture';
  const lines = text.split('\n');
  const body = lines.filter((line) => /L\d\d/.test(line));
  const tops = lines.filter((line) => line.includes('┌')).length;
  const bottoms = lines.filter((line) => line.includes('└')).length;
  const frames = new Set(body.map((line) => /F(\d{6})/.exec(line)?.[1] ?? '?'));
  const malformed = body.filter((line) => !/^│F\d{6} L\d\d /.test(line)).length;
  return body.length === 14 && tops === 1 && bottoms === 1 && frames.size === 1 && malformed === 0
    ? null
    : `body=${body.length} tops=${tops} bottoms=${bottoms} frames=${[...frames].join('|')} malformed=${malformed}`;
}

async function capture(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate((id) => window.__buildergateTerminalDebug?.captureTerminalText(id) ?? null, sessionId);
}

test.describe('REL-BGSTAB-041 screen repair output order', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('AC-1/AC-2: an Ink-like TUI stays one frame through repairs and grid workspace switches', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'grid mode is a desktop layout');
    test.setTimeout(420_000);
    const ownerId = `terminal-screen-repair-output-order/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    await login(page);
    const a = await createGridWorkspace(page, request, ownerId, 'A');
    const b = await createGridWorkspace(page, request, ownerId, 'B');
    await page.reload();
    await page.waitForSelector('.workspace-screen');
    const open = async (workspace: GridWorkspace) => {
      await page.locator('.workspace-item', { hasText: workspace.name }).first().click();
      await expect(page.locator('.mosaic-tile')).toHaveCount(3);
    };
    for (const workspace of [a, b]) {
      await open(workspace);
      await page.waitForTimeout(1500);
      for (const sessionId of workspace.sessions) {
        await sendVisibleTerminalCommand(page, `node "${hostPath(FIXTURE)}"`, { sessionId });
      }
      await page.waitForTimeout(1500);
    }

    const broken: string[] = [];
    const check = async (workspace: GridWorkspace, step: string) => {
      for (const sessionId of workspace.sessions) {
        const text = await capture(page, sessionId);
        const problem = frameProblem(text);
        if (problem) {
          broken.push(`${step} ${sessionId.slice(0, 8)} ${problem}`);
          console.log(`${step} ${sessionId.slice(0, 8)} ${problem}\n${text}`);
        }
      }
    };

    // AC-1: repairs requested by the user (middle click) on a busy screen.
    await open(a);
    await page.waitForTimeout(1500);
    for (let round = 0; round < 15; round += 1) {
      for (const sessionId of a.sessions) {
        await page.locator(`[data-session-id="${sessionId}"] .xterm-screen`).click({ button: 'middle' });
      }
      await page.waitForTimeout(1600 + Math.floor(Math.random() * 600));
      await check(a, `repair ${round}`);
    }

    // AC-2: rapid grid-to-grid switches, which request workspace repairs on every reveal.
    for (let round = 0; round < 10; round += 1) {
      for (const target of [a, b]) {
        const other = target === a ? b : a;
        const hops = 1 + Math.floor(Math.random() * 4);
        for (let hop = 0; hop < hops; hop += 1) {
          await open(hop % 2 === 0 ? other : target);
          await page.waitForTimeout(100 + Math.floor(Math.random() * 600));
        }
        await open(target);
        await page.waitForTimeout(2000);
        await check(target, `switch ${round}`);
      }
    }

    console.log(`broken captures: ${broken.length}`);
    expect(broken, 'every capture shows exactly one consistent frame').toEqual([]);
  });
});
