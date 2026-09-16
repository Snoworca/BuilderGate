// Issue #34 ratification (FR-BGSTAB-026 AC-3~7): the UI workspace/tab capacity
// must follow the server's configured limits rather than a hardcoded 10/8.
// Requires an externally owned https://localhost:2222 whose config.json5 sets
// workspace.maxWorkspaces = 4 and workspace.maxTabsPerWorkspace = 3 — values
// deliberately different from both the old hardcoded pair and the shipped
// defaults, so a passing assertion cannot be satisfied by a constant.
import { randomUUID } from 'node:crypto';
import { expect, test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

const origin = 'https://localhost:2222';
// Supplied by the harness from the server config actually in force, so the same
// spec run against two different configured pairs proves the UI tracks the value
// instead of coinciding with one constant.
const CONFIGURED_MAX_WORKSPACES = Number(process.env.ISSUE34_MAX_WORKSPACES ?? '0');
const CONFIGURED_MAX_TABS = Number(process.env.ISSUE34_MAX_TABS ?? '0');

// This spec only means anything against a server whose config.json5 sets the two
// limits to values different from the old hardcoded 10/8, and the runner must be
// told which pair is in force. Without both variables there is nothing to assert,
// so it skips rather than passing vacuously or failing the default suite.
test.skip(!Number.isInteger(CONFIGURED_MAX_WORKSPACES) || CONFIGURED_MAX_WORKSPACES < 1
  || !Number.isInteger(CONFIGURED_MAX_TABS) || CONFIGURED_MAX_TABS < 1,
  'set ISSUE34_MAX_WORKSPACES and ISSUE34_MAX_TABS to the limits the target server has configured');

test('issue34 AC-3: the workspace create control reports the configured maxWorkspaces', async ({ page, request }, info) => {
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const owner = `issue34-workspaces/${info.testId}/${info.retry}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  expect(typeof token).toBe('string');
  const headers = { Authorization: `Bearer ${token}` };

  const state = await (await request.get(origin + '/api/workspaces', { headers })).json();
  expect(state.limits).toEqual({ maxWorkspaces: CONFIGURED_MAX_WORKSPACES, maxTabsPerWorkspace: CONFIGURED_MAX_TABS });

  // Before the quota is full the control is enabled and carries no limit text.
  await expect(page.getByTitle('New Workspace', { exact: true })).toBeEnabled();

  const deficit = CONFIGURED_MAX_WORKSPACES - state.workspaces.length;
  expect(deficit).toBeGreaterThan(0);
  try {
    for (let i = 0; i < deficit; i += 1) {
      await createOwnedWorkspaceViaApi(request, registry, owner, { headers, data: { name: `issue34-ws-${Date.now()}-${i}` } });
    }

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 10000 });
    const limited = page.getByTitle(`Maximum ${CONFIGURED_MAX_WORKSPACES} workspaces`, { exact: true });
    await expect(limited).toBeVisible();
    await expect(limited).toBeDisabled();
    await page.screenshot({ path: `../.playwright-mcp/issue34-max-workspaces-${CONFIGURED_MAX_WORKSPACES}.png`, fullPage: true });
  } finally {
    // Release only the workspaces this owner registered. Never the pre-existing ones.
    const released = await cleanupOwnedWorkspaces({ ...registry, ownerId: owner });
    expect(released.failed).toEqual([]);
  }
});

test('issue34 AC-7: the add-terminal control reports the configured maxTabsPerWorkspace', async ({ page, request }, info) => {
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const owner = `issue34-tabs/${info.testId}/${info.retry}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  const headers = { Authorization: `Bearer ${token}` };

  const label = `issue34-tabs-${Date.now()}`;
  try {
  const ws = await createOwnedWorkspaceViaApi(request, registry, owner, { headers, data: { name: label } });
  for (let i = 0; i < CONFIGURED_MAX_TABS; i += 1) {
    const res = await request.post(`${origin}/api/workspaces/${ws.id}/tabs`, { headers, data: {} });
    expect(res.status(), `tab ${i + 1} is within the configured limit`).toBeLessThan(400);
  }
  // The server enforces the same configured number, one past it.
  const overflow = await request.post(`${origin}/api/workspaces/${ws.id}/tabs`, { headers, data: {} });
  expect(overflow.status(), 'server rejects one past the configured tab limit').toBeGreaterThanOrEqual(400);

  await page.reload();
  await page.waitForSelector('.workspace-screen', { timeout: 10000 });
  await page.getByText(label, { exact: false }).first().click();
  const limited = page.getByTitle(`Maximum ${CONFIGURED_MAX_TABS} tabs`, { exact: true });
  await expect(limited).toBeVisible();
  await expect(limited).toBeDisabled();
  await page.screenshot({ path: `../.playwright-mcp/issue34-max-tabs-${CONFIGURED_MAX_TABS}.png`, fullPage: true });
  } finally {
    const released = await cleanupOwnedWorkspaces({ ...registry, ownerId: owner });
    expect(released.failed).toEqual([]);
  }
});
