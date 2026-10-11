// FR-AITUI-007 / FR-AITUI-014 / FR-AITUI-018 — a saved agent session is resumed on its own
// when BuilderGate restarts.
//
// Rewritten 2026-10-11: the earlier version drove the FR-AITUI-008 review dialog ("검토하고
// 이어하기"), which FR-AITUI-014 replaced on 2026-09-28 with an automatic resume, and it waited
// for an operator to restart the server. It now restarts the server itself through
// RESTORE_RESTART_CMD (as restore-report-dismiss.spec.ts does) and checks what the start did.
//
// As in session-save.spec.ts no real agent runs: a registered agent alias whose name contains
// `claude` makes the tab an AI tab, and the Claude session record the save reads is written
// into the fixture home the server was started with (BUILDERGATE_AGENT_CLAUDE_HOME). Resuming
// reads only the save, so the record is removed right after it.
//
// Fixture:
//   * one workspace created through createOwnedWorkspaceViaApi and removed by id
//   * one agent alias named e2e-recovery-claude-<stamp>, removed afterwards
//   * one file <agent home>/claude/sessions/<pid>.json, removed after the save
//   * one manual save in the list (FR-AITUI-017), deleted by its id afterwards

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';
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
const RESTART = process.env.RESTORE_RESTART_CMD ?? '';
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

async function readToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  if (!token) throw new Error('login left no auth token');
  return token;
}

async function tabRecord(request: APIRequestContext, token: string, tabId: string): Promise<Record<string, unknown> | undefined> {
  const response = await request.get(`${ORIGIN}/api/workspaces`, { headers: authHeaders(token) });
  const body = await response.json() as { tabs: Array<Record<string, unknown>> };
  return body.tabs.find((item) => item.id === tabId);
}

async function restartServer(request: APIRequestContext, page: Page): Promise<void> {
  await page.goto('about:blank');
  console.log(execFileSync('cmd.exe', ['/c', RESTART], { encoding: 'utf8' }).trim());
  await expect.poll(async () => (await request.get(`${ORIGIN}/health`).catch(() => null))?.ok() ?? false, { timeout: 120_000 }).toBe(true);
}

/** After a restart the stored token may still be valid; log in only when asked to. */
async function openAfterRestart(page: Page): Promise<void> {
  await page.goto('/');
  const password = page.locator('input[type="password"]');
  await Promise.race([
    password.waitFor({ timeout: 30_000 }).catch(() => undefined),
    page.waitForSelector('.workspace-screen', { timeout: 30_000 }).catch(() => undefined),
  ]);
  if (await password.isVisible()) await login(page);
  await page.waitForSelector('.workspace-screen');
}

interface ReportItem { tabId: string; commandLine: string; result: string }

test.describe('세션 이어하기 (재시작 사이)', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, isMobile: false });

  test('재시작하면 저장한 AI 세션을 저장된 id 로 그 탭에서 이어한다', async ({ page, request }, testInfo) => {
    test.skip(!RESTART, 'RESTORE_RESTART_CMD is required');
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop project only');
    test.setTimeout(300_000);
    const ownerId = `session-restore/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`;
    const stamp = Date.now();
    const optionCommand = `e2e-recovery-claude-${stamp}`;
    const sessionId = randomUUID();
    const recordFile = path.join(CLAUDE_SESSIONS, `${process.pid}.json`);
    let savedId: string | null = null;

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
      const standIn = writeStandInAgent(optionCommand);
      await sendVisibleTerminalCommand(page, `${standIn} --continue`);
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
        // FR-AITUI-007 AC-1: the save resolves the id exactly; FR-AITUI-017 AC-1: it joins the list.
        const saved = await request.post(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token), data: { tabIds: [tabId] } });
        expect(saved.status()).toBe(200);
        const savedBody = await saved.json() as { snapshot: { id: string }; results: Array<Record<string, unknown>> };
        expect(savedBody.results).toEqual([expect.objectContaining({ tabId, status: 'found', confidence: 'exact' })]);
        savedId = savedBody.snapshot.id;
      } finally {
        rmSync(recordFile, { force: true });
      }

      // FR-AITUI-018 AC-1: the restart restores the newest save on its own.
      await restartServer(request, page);
      await openAfterRestart(page);
      token = await readToken(page);
      const status = await (await request.get(`${ORIGIN}/api/session-snapshot`, { headers: authHeaders(token) })).json() as {
        reportSource: { origin: string; id: string } | null;
        report: ReportItem[];
      };
      expect(status.reportSource).toMatchObject({ origin: 'manual', id: savedId });
      // FR-AITUI-014 AC-2/AC-4: the resume command was typed; no real agent runs, so it is not confirmed.
      const item = status.report.find((entry) => entry.tabId === tabId);
      // FR-AITUI-011 AC-4: the command the agent was actually launched with is resumed -- here the
      // stand-in script by its path -- with the saved id.
      expect(item?.commandLine).toBe(`${standIn} --resume ${sessionId}`);
      expect(['waiting', 'unconfirmed']).toContain(item?.result);

      // The command reached that tab's shell: read its buffer (WebGL leaves no text in the DOM).
      await page.locator('.sidebar [role="option"]', { hasText: workspaceName }).first().click();
      await waitForTerminal(page);
      const tabSessionId = await page.locator(`[data-tab-id="${tabId}"]`).first().getAttribute('data-session-id');
      if (!tabSessionId) throw new Error(`no session id on tab ${tabId}`);
      await expect.poll(() => page.evaluate((id) => {
        const hook = (window as unknown as { __buildergateTerminalDebug?: { captureTerminalText?: (sessionId: string) => string } })
          .__buildergateTerminalDebug;
        // The shell quotes each argument (PowerShell: '--resume' '<id>') and the line wraps at the
        // terminal width, so line breaks and quotes are taken out before comparing.
        return (hook?.captureTerminalText?.(id) ?? '').replace(/[\r\n]+/g, '').replace(/['"]/g, '');
      }, tabSessionId), { timeout: 30000 }).toContain(`--resume ${sessionId}`);
      await page.screenshot({ path: '../.playwright-mcp/session-restore-resumed.png' });
    } finally {
      const cleanupToken = await page.evaluate(() => localStorage.getItem('cws_auth_token')).catch(() => null);
      if (savedId && cleanupToken) {
        await request.delete(`${ORIGIN}/api/session-snapshot/list/${savedId}`, { headers: authHeaders(cleanupToken) });
      }
      rmSync(path.join(AGENT_BIN, `${optionCommand}.cmd`), { force: true });
      await clearAgentAliasesForE2E(page);
      const cleanup = await cleanupOwnedWorkspaces({ ...registryOptions(), ownerId });
      if (cleanup.failed.length) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(cleanup.failed)}`);
    }
  });
});
