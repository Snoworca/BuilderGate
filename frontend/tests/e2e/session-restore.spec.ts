// FR-AITUI-008 / FR-AITUI-009 — resuming a saved agent session after BuilderGate
// restarts.
//
// A restart cannot happen inside one Playwright run, so this spec has two phases
// and runs only when BUILDERGATE_E2E_RESTORE_PHASE names one of them:
//
//   1. BUILDERGATE_E2E_RESTORE_PHASE=prepare  — make an AI tab, save its session
//   2. restart the 2222 server (the operator does this, never the test)
//   3. BUILDERGATE_E2E_RESTORE_PHASE=resume   — banner, review, resume, clean up
//
// Without the variable both tests skip, so an ordinary run never leaves state
// behind for a restart that is not coming.
//
// As in session-save.spec.ts no real agent runs: a recovery option whose
// command contains `claude` makes the tab an AI tab, and the Claude session
// record the save reads is written into the fixture home the server was started
// with (BUILDERGATE_AGENT_CLAUDE_HOME).
//
// Fixture, owned by id and handed from the first phase to the second through
// <agent home>/restore-state.json:
//   * one workspace, created by a direct POST and deleted by that response's id
//     in the resume phase. It is not put in the run registry on purpose: the
//     run teardown would delete it before the restart.
//   * one recovery option e2e-recovery-claude-<stamp>, removed in resume
//   * the server's session snapshot — a save replaces it — discarded in resume

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect, type APIRequestContext } from './workspaceOwnershipFixture';
import {
  clearRecoveryOptionsForE2E,
  createRecoveryOptionViaApi,
  ensureDefaultRecoveryOptionsForE2E,
  login,
  sendVisibleTerminalCommand,
  waitForTerminal,
} from './helpers';

const ORIGIN = 'https://localhost:2222';
const PHASE = process.env.BUILDERGATE_E2E_RESTORE_PHASE ?? '';
const AGENT_HOME = process.env.BUILDERGATE_E2E_AGENT_HOME ?? path.join(os.tmpdir(), 'buildergate-e2e-agents');
const CLAUDE_SESSIONS = path.join(AGENT_HOME, 'claude', 'sessions');
const STATE_FILE = path.join(AGENT_HOME, 'restore-state.json');

interface RestoreState {
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  sessionId: string;
  optionCommand: string;
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

async function deleteWorkspaceById(request: APIRequestContext, token: string, workspaceId: string): Promise<void> {
  // Tabs first: on Windows a workspace delete can race its own PTY teardown.
  const response = await request.get(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token) });
  const body = await response.json() as { tabs: Array<{ id: string; workspaceId: string }> };
  for (const tab of body.tabs.filter((item) => item.workspaceId === workspaceId)) {
    await request.delete(`${ORIGIN}/api/workspaces/${workspaceId}/tabs/${tab.id}`, { headers: authHeaders(token) });
  }
  const deleted = await request.delete(`${ORIGIN}/api/workspaces/${workspaceId}`, { headers: authHeaders(token) });
  expect([200, 204, 404]).toContain(deleted.status());
}

test.describe('세션 이어하기 (재시작 사이)', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('준비: AI 탭의 세션을 저장한다', async ({ page, request }, testInfo) => {
    test.skip(PHASE !== 'prepare', 'set BUILDERGATE_E2E_RESTORE_PHASE=prepare');
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.setTimeout(120000);
    expect(existsSync(STATE_FILE), `${STATE_FILE} is left from an earlier prepare; run the resume phase first`).toBe(false);

    const stamp = Date.now();
    const optionCommand = `e2e-recovery-claude-${stamp}`;
    const sessionId = randomUUID();
    const recordFile = path.join(CLAUDE_SESSIONS, `${process.pid}.json`);

    await login(page);
    const token = await readToken(page);
    const workspaceName = `e2e-restore-${randomUUID().slice(0, 8)}`;
    const createdWorkspace = await request.post(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token), data: { name: workspaceName } });
    expect(createdWorkspace.status()).toBe(201);
    const workspaceId = (await createdWorkspace.json() as { id: string }).id;
    let handedOver = false;

    try {
      const createdTab = await request.post(`${ORIGIN}/api/workspaces/${workspaceId}/tabs`, {
        headers: authHeaders(token), data: { name: 'e2e-restore-agent' },
      });
      expect(createdTab.status()).toBe(201);
      const tabId = (await createdTab.json() as { id: string }).id;

      await createRecoveryOptionViaApi(page, { command: optionCommand, arguments: ['--continue'] });
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);
      await sendVisibleTerminalCommand(page, `${optionCommand} --continue`);
      await expect.poll(async () => (await tabRecord(request, token, tabId))?.recoveryCommand, { timeout: 15000 }).toBe(optionCommand);

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

      const state: RestoreState = { workspaceId, workspaceName, tabId, sessionId, optionCommand };
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      handedOver = true;
    } finally {
      if (!handedOver) {
        await request.delete(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
        await clearRecoveryOptionsForE2E(page);
        await ensureDefaultRecoveryOptionsForE2E(page);
        await deleteWorkspaceById(request, token, workspaceId);
      }
    }
  });

  test('이어하기: 재시작 뒤 배너에서 검토하고 저장한 세션을 이어한다', async ({ page, request }, testInfo) => {
    test.skip(PHASE !== 'resume', 'set BUILDERGATE_E2E_RESTORE_PHASE=resume after restarting the server');
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.setTimeout(120000);
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RestoreState;

    await login(page);
    const token = await readToken(page);
    try {
      // AC-3: saved sessions wait behind a banner, the shells are already open.
      const banner = page.locator('.session-restore-banner');
      await expect(banner).toContainText('지난번 저장한 AI 세션', { timeout: 20000 });
      await expect(page.getByRole('button', { name: /^저장된 세션 \d+개 이어하기$/ })).toBeVisible();
      const before = await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      const beforeBody = await before.json() as { restorable: boolean; snapshot: { entries: Array<{ tabId: string; restore: string }> } };
      expect(beforeBody.restorable).toBe(true);
      expect(beforeBody.snapshot.entries.find((entry) => entry.tabId === state.tabId)?.restore).toBe('pending');

      // The auto recovery command did not run over the pending tab (FR-AITUI-008 AC-3).
      await page.locator('.sidebar [role="option"]', { hasText: state.workspaceName }).first().click();
      await waitForTerminal(page);
      await expect(page.locator('.xterm-screen:visible').first()).not.toContainText(`${state.optionCommand} --continue`);

      await banner.getByRole('button', { name: '검토하고 이어하기' }).click();
      const dialog = page.locator('.window-dialog').filter({ has: page.locator('.session-save-dialog') });
      await expect(dialog).toContainText('저장된 세션 이어하기');
      // AC-4: the exact id is checked by default and the command is shown before it runs.
      const row = dialog.locator('.ui-row', { hasText: 'e2e-restore-agent' });
      await expect(row).toContainText('정확한 ID');
      await expect(row).toContainText(`${state.optionCommand} --resume ${state.sessionId}`);
      await expect(row.getByRole('checkbox')).toBeChecked();
      await page.screenshot({ path: '../.playwright-mcp/session-restore-review.png' });

      // A save replaces the snapshot, so the prepare phase left this tab as its only entry.
      await dialog.getByRole('button', { name: /^선택한 1개 이어하기$/ }).click();
      await expect(row).toContainText('이어함', { timeout: 20000 });

      const after = await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      const afterBody = await after.json() as { snapshot: { entries: Array<{ tabId: string; restore: string }> } };
      expect(afterBody.snapshot.entries.find((entry) => entry.tabId === state.tabId)?.restore).toBe('restored');

      // The resume command reaches the tab's shell (FR-AITUI-008 AC-4). PowerShell
      // gets each argument quoted ('--resume' '<id>'), a POSIX shell does not.
      await dialog.locator('.ui-dialog-footer').getByRole('button', { name: '닫기' }).click();
      await expect(page.locator('.xterm-screen:visible').first())
        .toContainText(new RegExp(`${state.optionCommand} '?--resume'? '?${state.sessionId}`), { timeout: 20000 });
      await page.screenshot({ path: '../.playwright-mcp/session-restore-resumed.png' });
    } finally {
      await request.delete(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      await clearRecoveryOptionsForE2E(page);
      await ensureDefaultRecoveryOptionsForE2E(page);
      await deleteWorkspaceById(request, token, state.workspaceId);
      rmSync(STATE_FILE, { force: true });
    }
  });
});
