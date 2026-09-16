// Issue #34 ratification (FR-BGSTAB-026 AC-3, AC-4): the UI workspace/tab capacity
// must follow the server's configured limits rather than a hardcoded 10/8.
//
// THIS SPEC IS A MANUAL-PROCEDURE GUARD, NOT CI COVERAGE. Nothing in the repo
// configures a server for it, and nothing runs it by default. The two limits are
// not `RuntimeConfigStore` keys — the server reads them once at startup — so
// exercising them genuinely requires an operator to:
//   1. set `workspace.maxWorkspaces` / `workspace.maxTabsPerWorkspace` in
//      `server/config.json5` to a pair OTHER than the shipped defaults 10 / 8,
//   2. restart the server so the new pair is in force at https://localhost:2222,
//   3. pass that same pair in the two env vars, e.g. for 4 / 3:
//
//      cd frontend && ISSUE34_MAX_WORKSPACES=4 ISSUE34_MAX_TABS=3 \
//        npm run test:e2e:issue34-capacity
//
// Left alone it skips. It guards nothing automatically; it only makes the manual
// procedure repeatable and its result falsifiable.
import { randomUUID } from 'node:crypto';
import { expect, test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

const origin = 'https://localhost:2222';

const RAW_MAX_WORKSPACES = process.env.ISSUE34_MAX_WORKSPACES;
const RAW_MAX_TABS = process.env.ISSUE34_MAX_TABS;

// Skipping is reserved for "nobody asked for this run". A half-configured or
// malformed pair is an operator mistake and must be loud: silently turning
// `ISSUE34_MAX_WORKSPACES=4x` into NaN would be indistinguishable from an
// unconfigured default-suite run, i.e. a green report for a spec that never ran.
const UNCONFIGURED = RAW_MAX_WORKSPACES === undefined && RAW_MAX_TABS === undefined;

function readLimit(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer matching the server's configured limit, got ${JSON.stringify(raw)}`);
  }
  return value;
}

// Supplied by the harness from the server config actually in force, so the same
// spec run against two different configured pairs proves the UI tracks the value
// instead of coinciding with one constant.
const CONFIGURED_MAX_WORKSPACES = UNCONFIGURED ? 0 : readLimit('ISSUE34_MAX_WORKSPACES', RAW_MAX_WORKSPACES);
const CONFIGURED_MAX_TABS = UNCONFIGURED ? 0 : readLimit('ISSUE34_MAX_TABS', RAW_MAX_TABS);

// ANTI-CONSTANT GUARD. 10 and 8 are the exact numbers `da0e347` removed from
// App.tsx, and they are also the pre-snapshot fallback in
// useWorkspaceManager.ts:175. Run at 10 / 8 this spec would pass against a
// re-hardcoded App.tsx and against a client that never received the server's
// limits at all — it would assert nothing. Refuse the run rather than skip it,
// because a skip reads as "not configured" while this is a configuration that
// destroys the evidence.
if (!UNCONFIGURED && (CONFIGURED_MAX_WORKSPACES === 10 || CONFIGURED_MAX_TABS === 8)) {
  throw new Error(
    'Issue #34 ratification cannot use the removed hardcoded pair: configure the server to a'
    + ` maxWorkspaces other than 10 and a maxTabsPerWorkspace other than 8 (got ${CONFIGURED_MAX_WORKSPACES} / ${CONFIGURED_MAX_TABS}).`
    + ' At those two values a passing assertion is satisfied by the constant the fix removed.',
  );
}

// Without either variable there is nothing to assert, so the default suite skips
// rather than passing vacuously or failing.
test.skip(UNCONFIGURED,
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

  // Cleanup runs unconditionally, but never from a `finally` that could throw
  // over the real capacity failure. Same shape as workspaceOwnershipFixture.ts.
  const failures: unknown[] = [];
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
  } catch (error) { failures.push(error); }
  try {
    // Release only the workspaces this owner registered. Never the pre-existing ones.
    const released = await cleanupOwnedWorkspaces({ ...registry, ownerId: owner });
    if (released.failed.length > 0) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(released.failed)}`);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Capacity assertion and workspace cleanup both failed');
});

test('issue34 AC-4: the add-terminal control reports the configured maxTabsPerWorkspace', async ({ page, request }, info) => {
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const owner = `issue34-tabs/${info.testId}/${info.retry}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  // Without this a null token would surface as a misleading "tab 1 is within the
  // configured limit" 401 instead of a login failure.
  expect(typeof token).toBe('string');
  const headers = { Authorization: `Bearer ${token}` };

  const label = `issue34-tabs-${Date.now()}`;
  const failures: unknown[] = [];
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
  } catch (error) { failures.push(error); }
  try {
    const released = await cleanupOwnedWorkspaces({ ...registry, ownerId: owner });
    if (released.failed.length > 0) throw new Error(`owned workspace cleanup failed: ${JSON.stringify(released.failed)}`);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Capacity assertion and workspace cleanup both failed');
});
