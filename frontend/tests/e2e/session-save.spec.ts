// FR-AITUI-007 / FR-AITUI-009 — saving a running agent session from the header.
//
// No real agent is started (that would call a model). The tab is made an "AI
// tab" by a recovery option whose command name contains `claude`, and the
// Claude session record the save reads is written here, into the fixture home
// the 2222 server was started with (BUILDERGATE_AGENT_CLAUDE_HOME). The record's
// pid is this test process, so the server sees a live pid.
//
// Fixture:
//   * one workspace created through createOwnedWorkspaceViaApi and removed by id
//   * one recovery option named e2e-recovery-claude-<stamp>, removed afterwards
//   * one file <agent home>/claude/sessions/<pid>.json, removed afterwards
//   * the server's session snapshot — a save replaces it — discarded afterwards

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test, expect, createOwnedWorkspaceViaApi, type APIRequestContext } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import {
  clearRecoveryOptionsForE2E,
  createRecoveryOptionViaApi,
  ensureDefaultRecoveryOptionsForE2E,
  login,
  sendVisibleTerminalCommand,
  waitForTerminal,
} from './helpers';

const ORIGIN = 'https://localhost:2222';
const AGENT_HOME = process.env.BUILDERGATE_E2E_AGENT_HOME ?? path.join(os.tmpdir(), 'buildergate-e2e-agents');
const CLAUDE_SESSIONS = path.join(AGENT_HOME, 'claude', 'sessions');

function registryOptions(): RegistryOptions {
  return { registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '', runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: ORIGIN };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function tabState(request: APIRequestContext, token: string, tabId: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token) });
  const body = await response.json() as { tabs: Array<Record<string, unknown>> };
  const tab = body.tabs.find((item) => item.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} is missing`);
  return tab;
}

test.describe('세션 저장', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('헤더 책갈피 버튼으로 실행 중인 AI 세션의 ID를 멈추지 않고 저장한다', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.setTimeout(120000);
    const ownerId = `session-save/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    const stamp = Date.now();
    const optionCommand = `e2e-recovery-claude-${stamp}`;
    const sessionId = randomUUID();
    const recordFile = path.join(CLAUDE_SESSIONS, `${process.pid}.json`);

    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');

    const workspaceName = `e2e-save-${randomUUID().slice(0, 8)}`;
    const workspace = await createOwnedWorkspaceViaApi(request, registryOptions(), ownerId, {
      headers: authHeaders(token), data: { name: workspaceName },
    });
    const created = await request.post(`${ORIGIN}/api/workspaces/${workspace.id}/tabs`, {
      headers: authHeaders(token), data: { name: 'e2e-save-agent' },
    });
    expect(created.status()).toBe(201);
    const tabId = (await created.json() as { id: string }).id;

    try {
      await createRecoveryOptionViaApi(page, { command: optionCommand, arguments: ['--continue'] });
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);

      // The submitted command matches the recovery option, which is what marks
      // the tab as an AI tab (FR-AITUI-003); the command itself need not exist.
      await sendVisibleTerminalCommand(page, `${optionCommand} --continue`);
      await expect.poll(async () => (await tabState(request, token, tabId)).recoveryCommand, { timeout: 15000 }).toBe(optionCommand);
      const tab = await tabState(request, token, tabId);
      const cwdResponse = await request.get(`${ORIGIN}/api/sessions/${String(tab.sessionId)}/cwd`, { headers: authHeaders(token) });
      const cwd = (await cwdResponse.json() as { cwd: string }).cwd;

      mkdirSync(CLAUDE_SESSIONS, { recursive: true });
      writeFileSync(recordFile, JSON.stringify({ pid: process.pid, sessionId, cwd, startedAt: Date.now(), kind: 'interactive' }));

      const candidates = await request.get(`${ORIGIN}/api/session-snapshot/candidates`, { headers: authHeaders(token) });
      const candidateList = (await candidates.json() as { candidates: Array<{ tabId: string; agent: string }> }).candidates;
      expect(candidateList.find((c) => c.tabId === tabId)?.agent).toBe('claude');

      const saveButton = page.getByRole('button', { name: /^세션 저장 · 재시작 준비/ });
      await expect(saveButton).toBeVisible({ timeout: 20000 });
      await saveButton.click();

      // Found by its body, not by its copy: the lead sentence changes once the save is done.
      const dialog = page.locator('.window-dialog').filter({ has: page.locator('.session-save-dialog') });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('에이전트는 멈추지 않습니다');
      await dialog.getByText('AI 세션 전체').click();
      await dialog.getByRole('checkbox', { name: 'e2e-save-agent 저장' }).check();
      await dialog.getByRole('button', { name: '세션 저장', exact: true }).click();
      // Precondition, not a product check: the 2222 server must read agent records from this
      // run's fixture home. Without it the save still succeeds but finds no ID, and the bare
      // timeout below used to hide why.
      await expect(
        dialog.getByText(`ID 확인 · ${sessionId.slice(0, 12)}…`),
        `no exact ID: is 2222 running with BUILDERGATE_AGENT_CLAUDE_HOME=${path.join(AGENT_HOME, 'claude')}?`,
      ).toBeVisible({ timeout: 30000 });
      await page.screenshot({ path: '../.playwright-mcp/session-save-result.png' });

      const status = await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      const body = await status.json() as { restorable: boolean; snapshot: { entries: Array<Record<string, unknown>> } };
      const entry = body.snapshot.entries.find((item) => item.tabId === tabId);
      expect(entry?.sessionId).toBe(sessionId);
      expect(entry?.confidence).toBe('exact');
      expect(entry?.resumeCommand).toBe(optionCommand);
      expect(entry?.resumeArguments).toEqual(['--resume', sessionId]);
      expect(body.restorable, 'a snapshot saved in this run is not offered for resuming').toBe(false);

      await dialog.getByRole('button', { name: '확인' }).click();
      await expect(page.getByRole('button', { name: /^저장됨 · / })).toBeVisible();
    } finally {
      rmSync(recordFile, { force: true });
      await request.delete(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      await clearRecoveryOptionsForE2E(page);
      await ensureDefaultRecoveryOptionsForE2E(page);
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});
