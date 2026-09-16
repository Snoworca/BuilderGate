// Issue #34, the RAISE direction (FR-BGSTAB-026 AC-3, AC-4).
//
// The sibling issue34-capacity-ratify.spec.ts pins the UI to configured pairs
// BELOW the shipped defaults, which demonstrates the "lower it and the UI
// permits what the server rejects" half of the issue. It cannot demonstrate the
// other half. The issue's first symptom is "raise the limit and the UI blocks
// first, so the setting looks ignored", and a UI still hardcoded to 10 / 8 would
// reproduce it while every below-default assertion kept passing.
//
// So this spec asserts at exactly the removed constants. With the server
// configured ABOVE them, it fills to 10 workspaces and to 8 tabs and requires
// the creation controls to be STILL ENABLED there — the precise point at which
// the old hardcoded UI blocked — before checking they finally disable at the
// configured number.
//
// MANUAL-PROCEDURE GUARD, NOT CI COVERAGE, for the same reason as the sibling:
// the limits are read once at server startup and are not RuntimeConfigStore
// keys. An operator must set workspace.maxWorkspaces > 10 and
// workspace.maxTabsPerWorkspace > 8 in server/config.json5 (the server schema
// caps them at 50 and 16), restart, and pass the same pair:
//
//   cd frontend && ISSUE34_MAX_WORKSPACES=14 ISSUE34_MAX_TABS=12 \
//     npm run test:e2e:issue34-raise
//
// Left alone it skips.
import { randomUUID } from 'node:crypto';
import { expect, test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

const origin = 'https://localhost:2222';

// The constants da0e347 removed from App.tsx. This spec's whole purpose is to
// assert at them, so they are named rather than inlined.
const REMOVED_MAX_WORKSPACES = 10;
const REMOVED_MAX_TABS = 8;

// Workspace names must stay within 32 characters: WorkspaceService.ts:459 rejects
// anything longer with INVALID_NAME, and that rejection is indistinguishable from a
// quota rejection at the ownership helper, which only sees 'status !== 201'. An
// earlier draft of this spec used `issue34-raise-ws-${Date.now()}-${i}`, which is 32
// characters while i is one digit and 33 once i reaches 10 — so it created nine
// workspaces and then failed on the tenth, which reads exactly like the capacity
// defect this spec exists to detect. Keep these names short.
const RAW_MAX_WORKSPACES = process.env.ISSUE34_MAX_WORKSPACES;
const RAW_MAX_TABS = process.env.ISSUE34_MAX_TABS;
const UNCONFIGURED = RAW_MAX_WORKSPACES === undefined && RAW_MAX_TABS === undefined;

function readLimit(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer matching the server's configured limit, got ${JSON.stringify(raw)}`);
  }
  return value;
}

// Per-test, never at module load: a throw during file load fails collection for
// every spec under the base config's testDir, not just this one.
function resolveLimits(): { maxWorkspaces: number; maxTabsPerWorkspace: number } {
  const maxWorkspaces = readLimit('ISSUE34_MAX_WORKSPACES', RAW_MAX_WORKSPACES);
  const maxTabsPerWorkspace = readLimit('ISSUE34_MAX_TABS', RAW_MAX_TABS);
  // Below or at the removed constants this spec proves nothing: the old
  // hardcoded UI would disable the control at 10 / 8 too, so "still enabled at
  // 10 / 8" would be unreachable or vacuous. Refuse rather than skip, because a
  // skip reads as "not configured" while this is a configuration that cannot
  // express the claim.
  if (maxWorkspaces <= REMOVED_MAX_WORKSPACES || maxTabsPerWorkspace <= REMOVED_MAX_TABS) {
    throw new Error(
      'The raise direction needs limits ABOVE the removed hardcoded pair: maxWorkspaces must exceed'
      + ` ${REMOVED_MAX_WORKSPACES} and maxTabsPerWorkspace must exceed ${REMOVED_MAX_TABS}`
      + ` (got ${maxWorkspaces} / ${maxTabsPerWorkspace}). At or below them the assertion is vacuous.`,
    );
  }
  return { maxWorkspaces, maxTabsPerWorkspace };
}

test.skip(UNCONFIGURED,
  'set ISSUE34_MAX_WORKSPACES (>10) and ISSUE34_MAX_TABS (>8) to the limits the target server has configured');

test('issue34 raise AC-4: the workspace create control is still enabled at the removed constant 10', async ({ page, request }, info) => {
  const { maxWorkspaces } = resolveLimits();
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const owner = `issue34-raise-workspaces/${info.testId}/${info.retry}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  expect(typeof token).toBe('string');
  const headers = { Authorization: `Bearer ${token}` };

  const state = await (await request.get(origin + '/api/workspaces', { headers })).json();
  expect(state.limits.maxWorkspaces, 'the server must actually be configured to the asserted limit').toBe(maxWorkspaces);

  const failures: unknown[] = [];
  try {
    // Fill to exactly the removed constant.
    const toTen = REMOVED_MAX_WORKSPACES - state.workspaces.length;
    expect(toTen, 'the server must start below the removed constant for this to be meaningful').toBeGreaterThan(0);
    for (let i = 0; i < toTen; i += 1) {
      await createOwnedWorkspaceViaApi(request, registry, owner, { headers, data: { name: `i34r-ws-${i}-${randomUUID().slice(0, 8)}` } });
    }
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 10000 });

    const atTen = await (await request.get(origin + '/api/workspaces', { headers })).json();
    expect(atTen.workspaces.length).toBe(REMOVED_MAX_WORKSPACES);

    // THE ASSERTION. A UI hardcoded to 10 disables here and the configured
    // limit looks ignored. It must still be enabled.
    await expect(page.getByTitle('New Workspace', { exact: true }),
      'at the removed constant the configured higher limit must still permit creation').toBeEnabled();
    await expect(page.getByTitle(`Maximum ${REMOVED_MAX_WORKSPACES} workspaces`, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `../.playwright-mcp/issue34-raise-enabled-at-10-of-${maxWorkspaces}.png`, fullPage: true });

    // And it does stop at the configured number. Each creation is preceded by a
    // count read so a rejection reports the numbers rather than the ownership
    // helper's opaque "Invalid workspace creation response proof".
    for (let i = REMOVED_MAX_WORKSPACES; i < maxWorkspaces; i += 1) {
      const before = await (await request.get(origin + '/api/workspaces', { headers })).json();
      try {
        await createOwnedWorkspaceViaApi(request, registry, owner, { headers, data: { name: `i34r-ws-${i}-${randomUUID().slice(0, 8)}` } });
      } catch (error) {
        const after = await (await request.get(origin + '/api/workspaces', { headers })).json();
        throw new Error(
          `creation ${i + 1} of ${maxWorkspaces} was rejected while the server's configured limit is `
          + `${JSON.stringify(after.limits)}: count before ${before.workspaces.length}, after `
          + `${after.workspaces.length}. Underlying: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 10000 });
    const limited = page.getByTitle(`Maximum ${maxWorkspaces} workspaces`, { exact: true });
    await expect(limited).toBeVisible();
    await expect(limited).toBeDisabled();
    await page.screenshot({ path: `../.playwright-mcp/issue34-raise-disabled-at-${maxWorkspaces}.png`, fullPage: true });
  } catch (error) { failures.push(error); }

  try {
    const released = await cleanupOwnedWorkspaces({ ...registry, ownerId: owner });
    if (released.failed.length) throw new Error(`Owned workspace cleanup failed: ${JSON.stringify(released.failed)}`);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Capacity assertion and workspace cleanup both failed');
});

test('issue34 raise AC-4: the add-terminal control is still enabled at the removed constant 8', async ({ page, request }, info) => {
  const { maxTabsPerWorkspace } = resolveLimits();
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const owner = `issue34-raise-tabs/${info.testId}/${info.retry}/${randomUUID()}`;
  await login(page);
  const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
  expect(typeof token).toBe('string');
  const headers = { Authorization: `Bearer ${token}` };

  const state = await (await request.get(origin + '/api/workspaces', { headers })).json();
  expect(state.limits.maxTabsPerWorkspace, 'the server must actually be configured to the asserted limit').toBe(maxTabsPerWorkspace);

  const label = `i34r-tabs-${randomUUID().slice(0, 8)}`;
  const failures: unknown[] = [];
  try {
    const ws = await createOwnedWorkspaceViaApi(request, registry, owner, { headers, data: { name: label } });
    for (let i = 0; i < REMOVED_MAX_TABS; i += 1) {
      const res = await request.post(`${origin}/api/workspaces/${ws.id}/tabs`, { headers, data: {} });
      expect(res.status(), `tab ${i + 1} is below the configured limit`).toBeLessThan(400);
    }
    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 10000 });
    await page.getByText(label, { exact: false }).first().click();

    // THE ASSERTION. A UI hardcoded to 8 disables here.
    await expect(page.getByTitle('Add Terminal', { exact: true }).first(),
      'at the removed constant the configured higher tab limit must still permit creation').toBeEnabled();
    await expect(page.getByTitle(`Maximum ${REMOVED_MAX_TABS} tabs`, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `../.playwright-mcp/issue34-raise-tabs-enabled-at-8-of-${maxTabsPerWorkspace}.png`, fullPage: true });

    // And it does stop at the configured number.
    for (let i = REMOVED_MAX_TABS; i < maxTabsPerWorkspace; i += 1) {
      const res = await request.post(`${origin}/api/workspaces/${ws.id}/tabs`, { headers, data: {} });
      expect(res.status(), `tab ${i + 1} is within the configured limit`).toBeLessThan(400);
    }
    const overflow = await request.post(`${origin}/api/workspaces/${ws.id}/tabs`, { headers, data: {} });
    expect(overflow.status(), 'server rejects one past the configured tab limit').toBeGreaterThanOrEqual(400);

    await page.reload();
    await page.waitForSelector('.workspace-screen', { timeout: 10000 });
    await page.getByText(label, { exact: false }).first().click();
    const limited = page.getByTitle(`Maximum ${maxTabsPerWorkspace} tabs`, { exact: true });
    await expect(limited).toBeVisible();
    await expect(limited).toBeDisabled();
    await page.screenshot({ path: `../.playwright-mcp/issue34-raise-tabs-disabled-at-${maxTabsPerWorkspace}.png`, fullPage: true });
  } catch (error) { failures.push(error); }

  try {
    const released = await cleanupOwnedWorkspaces({ ...registry, ownerId: owner });
    if (released.failed.length) throw new Error(`Owned workspace cleanup failed: ${JSON.stringify(released.failed)}`);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Capacity assertion and workspace cleanup both failed');
});
