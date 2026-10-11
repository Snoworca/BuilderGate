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
//   * one manual save in the list (FR-AITUI-017), deleted by its id afterwards

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
  manualSaveListHasRoom,
} from './helpers';

const ORIGIN = 'https://localhost:2222';
const AGENT_HOME = process.env.BUILDERGATE_E2E_AGENT_HOME ?? path.join(os.tmpdir(), 'buildergate-e2e-agents');
const CLAUDE_SESSIONS = path.join(AGENT_HOME, 'claude', 'sessions');
// The stand-in agent is a script named like the registered alias that keeps running, so the tab
// stays an AI tab while the test saves. A name the shell cannot find returned to the prompt at
// once, the foreground mark went with it, and whether the save still saw an agent was a race
// (measured 2026-10-11: one run found the id, the next showed the tab as shell only).
const AGENT_BIN = path.join(AGENT_HOME, 'bin');

function writeStandInAgent(alias: string): string {
  mkdirSync(AGENT_BIN, { recursive: true });
  const script = path.join(AGENT_BIN, `${alias}.cmd`);
  writeFileSync(script, '@ping -n 600 127.0.0.1 >nul\r\n');
  return script;
}

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
    let savedId: string | null = null;

    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    if (!token) throw new Error('login left no auth token');
    test.skip(!(await manualSaveListHasRoom(request, ORIGIN, token)), 'the manual save list is full: saving would delete a user save');

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
      await addAgentAliasForE2E(page, 'claude', optionCommand);
      await page.reload();
      await page.waitForSelector('.workspace-screen', { timeout: 15000 });
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);

      // The submitted command is a registered alias, which marks the tab as an AI tab (FR-AITUI-011).
      await sendVisibleTerminalCommand(page, `${writeStandInAgent(optionCommand)} --continue`);
      // FR-AITUI-011 AC-5: the alias makes the tab a save candidate.
      await expect.poll(async () => {
        const res = await request.get(`${ORIGIN}/api/session-snapshot/candidates`, { headers: authHeaders(token) });
        return ((await res.json()) as { candidates: Array<{ tabId: string }> }).candidates.some((c) => c.tabId === tabId);
      }, { timeout: 15000 }).toBe(true);
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
      await expect(dialog).toContainText('에이전트는 계속 실행됩니다');
      // FR-AITUI-015 AC-1: every terminal is listed and picked; only this test's terminal is saved here.
      const agentRow = dialog.locator('.session-row', { has: page.getByRole('checkbox', { name: 'e2e-save-agent 저장' }) });
      // Precondition, not a product check: the 2222 server must read agent records from this
      // run's fixture home. Without it the save still succeeds but finds no ID, and the bare
      // timeout below used to hide why.
      await expect(
        agentRow.getByText(sessionId),
        `no exact ID: is 2222 running with BUILDERGATE_AGENT_CLAUDE_HOME=${path.join(AGENT_HOME, 'claude')}?`,
      ).toBeVisible({ timeout: 30000 });
      await expect(agentRow).toContainText('확실');
      await dialog.locator('.session-save-all-toggle input[type="checkbox"]').uncheck();
      await dialog.getByRole('checkbox', { name: 'e2e-save-agent 저장' }).check();
      await dialog.getByRole('button', { name: '모두 저장 (1)', exact: true }).click();
      await expect(dialog.getByText('터미널 1개 저장됨')).toBeVisible({ timeout: 30000 });
      await page.screenshot({ path: '../.playwright-mcp/session-save-result.png' });

      // FR-AITUI-017 AC-1: the save is the newest manual one in the list, and the agent keeps running.
      const status = await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) });
      const body = await status.json() as { restorable: boolean; snapshot: { id: string; origin: string; entries: Array<Record<string, unknown>> } };
      savedId = body.snapshot.id;
      expect(body.snapshot.origin).toBe('manual');
      const entry = body.snapshot.entries.find((item) => item.tabId === tabId);
      expect(entry?.sessionId).toBe(sessionId);
      // FR-AITUI-013 AC-3: what the save dialog writes is what the user confirmed, recorded as manual.
      expect(entry?.confidence).toBe('manual');
      expect(entry?.resumeCommand).toBe(optionCommand);
      expect(entry?.resumeArguments).toEqual(['--resume', sessionId]);
      expect(body.restorable, 'FR-AITUI-018 AC-1: nothing is offered for resuming; the next start restores the newest save').toBe(false);

      await dialog.getByRole('button', { name: '확인' }).click();
      await expect(page.getByRole('button', { name: /^저장됨 · / })).toBeVisible();
    } finally {
      rmSync(recordFile, { force: true });
      rmSync(path.join(AGENT_BIN, `${optionCommand}.cmd`), { force: true });
      // FR-AITUI-017 AC-5: only this test's own save, by its id.
      if (savedId) await request.delete(`${ORIGIN}/api/session-snapshot/list/${savedId}`, { headers: authHeaders(token) });
      await clearAgentAliasesForE2E(page);
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});
