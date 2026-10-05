import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import type { RegistryOptions } from './workspaceLeakGuard';
import { login, sendVisibleTerminalCommand } from './helpers';

// Reported 2026-10-06: after a waiting Claude Code session ended, moving the mouse over the
// terminal typed `[555;50;76M`-like text into PowerShell — SGR mouse reports, so the browser
// terminal still had mouse tracking on although the application that turned it on was gone.
// This measures whether the browser terminal's mouse tracking follows the application.
// Measured 2026-10-06 before the fix: only the hidden case fails. The output skipped while the
// workspace was hidden carried the app's exit (mouse tracking off, alternate screen off); the
// reveal restored a local snapshot saved while the app ran, and the follow-up screen repair was
// rejected as buffer-mismatch, so the stale screen and its mouse tracking stayed.

const ORIGIN = 'https://localhost:2222';
const APP = fileURLToPath(new URL('./fixtures/mouse-mode-app.mjs', import.meta.url));

function hostPath(path: string): string {
  const wsl = /^\/mnt\/([a-z])\/(.*)$/.exec(path);
  return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
}
function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

interface Ws { id: string; name: string; sessionId: string }

/** Whether xterm in the browser is currently reporting mouse events to the application. */
async function mouseTracking(page: Page, sessionId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const host = document.querySelector(`[data-session-id="${id}"] .xterm`);
    return host?.classList.contains('enable-mouse-events') ?? false;
  }, sessionId);
}

async function screenText(page: Page, sessionId: string): Promise<string> {
  return page.evaluate((id) => window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? '', sessionId);
}

test.describe('Mouse tracking after the application exits', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, isMobile: false });

  for (const variant of [
    { label: 'clean exit while visible', clean: true, hidden: false, expectTracking: false },
    { label: 'clean exit while the workspace is hidden', clean: true, hidden: true, expectTracking: false },
    { label: 'clean exit, then a page reload', clean: true, hidden: false, reload: true, expectTracking: false },
    { label: 'killed without cleanup (control)', clean: false, hidden: false, expectTracking: true },
  ] as const) {
    test(variant.label, async ({ page, request }, testInfo) => {
      test.skip(testInfo.project.name !== 'Desktop Chrome', 'desktop only');
      test.setTimeout(180_000);
      const ownerId = `mouse-mode-after-exit/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
      await login(page);
      const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
      const headers = { Authorization: `Bearer ${token}` };
      const create = async (label: string): Promise<Ws> => {
        const name = `e2e-mouse-${label}-${randomUUID().slice(0, 6)}`;
        const ws = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, { headers, data: { name } });
        expect((await request.post(`${ORIGIN}/api/workspaces/${ws.id}/tabs`, { headers, data: { name: label } })).status()).toBe(201);
        const state = await (await request.get(`${ORIGIN}/api/workspaces`, { headers })).json() as { tabs: Array<{ workspaceId: string; sessionId: string }> };
        return { id: ws.id, name, sessionId: state.tabs.find((t) => t.workspaceId === ws.id)!.sessionId };
      };
      const app = await create('app');
      const other = await create('other');
      await page.reload();
      await page.waitForSelector('.workspace-screen');
      await page.evaluate(() => window.__buildergateTerminalDebug?.enable());
      const open = async (ws: Ws) => {
        await page.locator('.workspace-item', { hasText: ws.name }).first().click();
        await page.waitForTimeout(500);
      };
      await open(app);
      await page.waitForTimeout(1500);
      await sendVisibleTerminalCommand(page, `$env:CLEAN='${variant.clean ? 1 : 0}'; $env:EXIT_AFTER_MS='6000'; node "${hostPath(APP)}"`, { sessionId: app.sessionId });
      await expect.poll(() => mouseTracking(page, app.sessionId), { timeout: 15_000, message: 'the app turned tracking on' }).toBe(true);

      if (variant.hidden) await open(other);
      await page.waitForTimeout(9000); // the app exits after 6 s
      if (variant.hidden) await open(app);
      if ('reload' in variant && variant.reload) {
        await page.reload();
        await page.waitForSelector('.workspace-screen');
        await open(app);
      }
      await page.waitForTimeout(3000);
      const tracking = await mouseTracking(page, app.sessionId);
      const text = await screenText(page, app.sessionId);
      console.log(`${variant.label}: tracking=${tracking} exitedLine=${/MOUSE-APP-EXITED/.test(text)}`);
      const events = await page.evaluate((id) => (window.__buildergateTerminalDebug?.getEvents(id) ?? [])
        .filter((e) => /hidden_output|recovery|repair|snapshot|restore/.test(e.kind))
        .slice(-20).map((e) => `${e.kind} ${JSON.stringify(e.details ?? {}).slice(0, 140)}`), app.sessionId);
      for (const e of events) console.log(`  EV ${e}`);
      await page.screenshot({ path: `../.playwright-mcp/mouse-mode-${variant.label.replace(/[^a-z]+/gi, '-')}.png` });
      expect(tracking, `${variant.label}: browser mouse tracking`).toBe(variant.expectTracking);
    });
  }
});
