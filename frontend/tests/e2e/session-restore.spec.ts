// FR-AITUI-008 / FR-AITUI-009 — resuming a saved agent session after BuilderGate
// restarts.
//
// The restart happens in the middle of this one test, and the operator makes it,
// never the test: after the save the test prints a line and waits until /health
// reports a different server pid. One run keeps the workspace inside that run's
// ownership registry, so it is created and removed by the owned-workspace helpers
// like any other spec's (B2 ownership inventory); a workspace cannot be handed
// from one run to the next, by design.
//
// It runs only with BUILDERGATE_E2E_RESTORE_WITH_RESTART=1, so an ordinary run
// never sits waiting for a restart that is not coming. The wait is
// BUILDERGATE_E2E_RESTART_WAIT_MS (10 minutes by default).
//
// As in session-save.spec.ts no real agent runs: a recovery option whose command
// contains `claude` makes the tab an AI tab, and the Claude session record the
// save reads is written into the fixture home the server was started with
// (BUILDERGATE_AGENT_CLAUDE_HOME). The server started after the restart does not
// need it: resuming reads only the saved snapshot.
//
// Fixture:
//   * one workspace created through createOwnedWorkspaceViaApi and removed by id
//   * one recovery option named e2e-recovery-claude-<stamp>, removed afterwards
//   * one file <agent home>/claude/sessions/<pid>.json, removed after the save
//   * the server's session snapshot — a save replaces it — discarded afterwards

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect, createOwnedWorkspaceViaApi, type APIRequestContext } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import {
  addAgentAliasForE2E,
  clearAgentAliasesForE2E,
  login,
  sendVisibleTerminalCommand,
  waitForTerminal,
} from './helpers';

const ORIGIN = 'https://localhost:2222';
const RESTART_ENABLED = process.env.BUILDERGATE_E2E_RESTORE_WITH_RESTART === '1';
const RESTART_WAIT_MS = Number(process.env.BUILDERGATE_E2E_RESTART_WAIT_MS ?? 600_000);
const AGENT_HOME = process.env.BUILDERGATE_E2E_AGENT_HOME ?? path.join(os.tmpdir(), 'buildergate-e2e-agents');
const CLAUDE_SESSIONS = path.join(AGENT_HOME, 'claude', 'sessions');

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readToken(page: import('@playwright/test').Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('login left no auth token');
  return token;
}

async function tabRecord(request: APIRequestContext, token: string, tabId: string): Promise<Record<string, unknown> | undefined> {
  const response = await request.get(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token) });
  const body = await response.json() as { tabs: Array<Record<string, unknown>> };
  return body.tabs.find((item) => item.id === tabId);
}

async function serverPid(request: APIRequestContext): Promise<number | null> {
  const response = await request.get(`${ORIGIN}/health`).catch(() => null);
  if (!response || !response.ok()) return null;
  const body = await response.json() as { pid?: unknown };
  return typeof body.pid === 'number' ? body.pid : null;
}

test.describe('세션 이어하기 (재시작 사이)', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('재시작 뒤 배너에서 검토하고 저장한 세션을 이어한다', async ({ page, request }, testInfo) => {
    test.skip(!RESTART_ENABLED, 'set BUILDERGATE_E2E_RESTORE_WITH_RESTART=1 and restart the 2222 server when the test asks');
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.setTimeout(RESTART_WAIT_MS + 180_000);

    const ownerId = `session-restore/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    const optionCommand = `e2e-recovery-claude-${Date.now()}`;
    const sessionId = randomUUID();
    const recordFile = path.join(CLAUDE_SESSIONS, `${process.pid}.json`);

    await login(page);
    let token = await readToken(page);
    const workspaceName = `e2e-restore-${randomUUID().slice(0, 8)}`;
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
      headers: authHeaders(token), data: { name: workspaceName },
    });

    try {
      const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, {
        headers: authHeaders(token), data: { name: 'e2e-restore-agent' },
      });
      expect(createdTab.status()).toBe(201);
      const tabId = (await createdTab.json() as { id: string }).id;

      await addAgentAliasForE2E(page, 'claude', optionCommand);
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);
      await sendVisibleTerminalCommand(page, `${optionCommand} --continue`);
      // FR-AITUI-011 AC-5: the alias makes the tab a save candidate.
      await expect.poll(async () => {
        const res = await request.get(`${ORIGIN}/api/session-snapshot/candidates`, { headers: authHeaders(token) });
        return ((await res.json()) as { candidates: Array<{ tabId: string }> }).candidates.some((c) => c.tabId === tabId);
      }, { timeout: 15000 }).toBe(true);

      const tab = await tabRecord(request, token, tabId);
      const cwdResponse = await request.get(`${ORIGIN}/api/sessions/${String(tab?.sessionId)}/cwd`, { headers: authHeaders(token) });
      const cwd = (await cwdResponse.json() as { cwd: string }).cwd;
      mkdirSync(CLAUDE_SESSIONS, { recursive: true });
      writeFileSync(recordFile, JSON.stringify({ pid: process.pid, sessionId, cwd, startedAt: Date.now(), kind: 'interactive' }));
      try {
        const saved = await request.post(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token), data: { tabIds: [tabId] } });
        expect(saved.status()).toBe(200);
        const result = (await saved.json() as { results: Array<{ tabId: string; status: string; confidence?: string }> }).results;
        expect(result).toEqual([expect.objectContaining({ tabId, status: 'found', confidence: 'exact' })]);
      } finally {
        rmSync(recordFile, { force: true });
      }

      // The operator restarts the server here.
      const before = await serverPid(request);
      expect(before, '/health reports the server pid').not.toBeNull();
      console.log(`[session-restore] snapshot saved; restart the 2222 server now (pid ${before})`);
      await expect.poll(async () => {
        const pid = await serverPid(request);
        return pid !== null && pid !== before;
      }, { timeout: RESTART_WAIT_MS, intervals: [2000] }).toBe(true);

      // A token may or may not outlive the restart; take whichever screen comes.
      await page.goto('/');
      const passwordInput = page.locator('input[type="password"]');
      await expect(passwordInput.or(page.locator('.workspace-screen'))).toBeVisible({ timeout: 30000 });
      if (await passwordInput.isVisible()) await login(page);
      token = await readToken(page);

      // AC-3: saved sessions wait behind a banner, the shells are already open.
      const banner = page.locator('.session-restore-banner');
      await expect(banner).toContainText('지난번 저장한 AI 세션', { timeout: 20000 });
      await expect(page.getByRole('button', { name: /^저장된 세션 \d+개 이어하기$/ })).toBeVisible();
      const pending = await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      const pendingBody = await pending.json() as { restorable: boolean; snapshot: { entries: Array<{ tabId: string; restore: string }> } };
      expect(pendingBody.restorable, 'a snapshot from before the restart is offered').toBe(true);
      expect(pendingBody.snapshot.entries.find((entry) => entry.tabId === tabId)?.restore).toBe('pending');

      // The auto recovery command did not run over the pending tab (FR-AITUI-008 AC-1).
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);
      await expect(page.locator('.xterm-screen:visible').first()).not.toContainText(`${optionCommand} --continue`);

      await banner.getByRole('button', { name: '검토하고 이어하기' }).click();
      const dialog = page.locator('.window-dialog').filter({ has: page.locator('.session-save-dialog') });
      await expect(dialog).toContainText('저장된 세션 이어하기');
      // AC-4: the exact id is checked by default and the command is shown before it runs.
      const row = dialog.locator('.ui-row', { hasText: 'e2e-restore-agent' });
      await expect(row).toContainText('정확한 ID');
      await expect(row).toContainText(`${optionCommand} --resume ${sessionId}`);
      await expect(row.getByRole('checkbox')).toBeChecked();
      await page.screenshot({ path: '../.playwright-mcp/session-restore-review.png' });

      // A save replaces the snapshot, so this tab is its only entry.
      await dialog.getByRole('button', { name: /^선택한 1개 이어하기$/ }).click();
      await expect(row).toContainText('이어함', { timeout: 20000 });
      const after = await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      const afterBody = await after.json() as { snapshot: { entries: Array<{ tabId: string; restore: string }> } };
      expect(afterBody.snapshot.entries.find((entry) => entry.tabId === tabId)?.restore).toBe('restored');

      // The resume command reaches the tab's shell (FR-AITUI-008 AC-4). PowerShell
      // gets each argument quoted ('--resume' '<id>'), a POSIX shell does not.
      await dialog.locator('.ui-dialog-footer').getByRole('button', { name: '닫기' }).click();
      await expect(page.locator('.xterm-screen:visible').first())
        .toContainText(new RegExp(`${optionCommand} '?--resume'? '?${sessionId}`), { timeout: 20000 });
      await page.screenshot({ path: '../.playwright-mcp/session-restore-resumed.png' });
    } finally {
      rmSync(recordFile, { force: true });
      await request.delete(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      await clearAgentAliasesForE2E(page);
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});
