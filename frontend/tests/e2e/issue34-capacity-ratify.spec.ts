// Issue #34 ratification (FR-BGSTAB-026 AC-4): the UI tab capacity must follow the
// server's configured maxTabsPerWorkspace rather than a hardcoded 8. (The Workspace-count
// cap this spec also covered was removed.)
//
// MANUAL-PROCEDURE GUARD, NOT CI COVERAGE. The limit is read once at server startup, so an
// operator must set `workspace.maxTabsPerWorkspace` (not 8) in `server/config.json5`,
// restart the server at https://localhost:2222, and pass the same value:
//
//      cd frontend && ISSUE34_MAX_TABS=3 npm run test:e2e:issue34-capacity
//
// Left alone it skips.
import { randomUUID } from 'node:crypto';
import { expect, test, createOwnedWorkspaceViaApi } from './workspaceOwnershipFixture';
import { cleanupOwnedWorkspaces, type RegistryOptions } from './workspaceLeakGuard';
import { login } from './helpers';

const origin = 'https://localhost:2222';

const RAW_MAX_TABS = process.env.ISSUE34_MAX_TABS;

// Skipping is reserved for "nobody asked for this run"; a malformed value is loud.
const UNCONFIGURED = RAW_MAX_TABS === undefined;

function readLimit(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer matching the server's configured limit, got ${JSON.stringify(raw)}`);
  }
  return value;
}

// Resolved per test, never at module load (a load-time throw fails collection for the whole
// testDir). 8 is the constant da0e347 removed from App.tsx and the hook's fallback, so a run
// at 8 would pass against a re-hardcoded client; refuse it rather than skip.
function resolveMaxTabs(): number {
  const maxTabsPerWorkspace = readLimit('ISSUE34_MAX_TABS', RAW_MAX_TABS);
  if (maxTabsPerWorkspace === 8) {
    throw new Error('Issue #34 ratification cannot use the removed hardcoded maxTabsPerWorkspace 8;'
      + ' at that value a passing assertion is satisfied by the constant the fix removed.');
  }
  return maxTabsPerWorkspace;
}

// Without the variable there is nothing to assert, so the default suite skips
// rather than passing vacuously or failing.
test.skip(UNCONFIGURED,
  'set ISSUE34_MAX_TABS to the tab limit the target server has configured');

test('issue34 AC-4: the add-terminal control reports the configured maxTabsPerWorkspace', async ({ page, request }, info) => {
  const registry: RegistryOptions = {
    registryPath: process.env.BUILDERGATE_E2E_RUN_DIR ?? '',
    runId: process.env.BUILDERGATE_E2E_RUN_ID ?? '', baseUrl: origin,
  };
  const CONFIGURED_MAX_TABS = resolveMaxTabs();
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
