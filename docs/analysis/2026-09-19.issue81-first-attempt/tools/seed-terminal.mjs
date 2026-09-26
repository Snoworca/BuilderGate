// Issue #81 lane seed. Supersedes the #5 lane's issue5-seed-terminal.mjs, which #81 named for
// two reasons, both confirmed by reading it:
//
//   * it did not verify that a tab was created. It clicked "+ Add Terminal" and then waited
//     for `.xterm-screen:visible` -- a selector an ALREADY PRESENT terminal satisfies. When one
//     existed, the wait returned on the old terminal and the seed reported success without the
//     new one being anywhere.
//   * it recorded no terminal age, which is the variable the issue's own hypothesis is about,
//     and it ended with `waitForTimeout(2000)` -- a fixed sleep standing in for readiness.
//
// This one counts before and after, requires the count to rise by exactly one, waits for the
// NEW terminal by index rather than for any terminal, and prints a JSON line with the clock
// readings a later analysis needs. It never deletes anything.
// Resolved from the frontend workspace: this file lives under docs/, which has no node_modules.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend');
const requireFromFrontend = createRequire(pathToFileURL(resolve(frontendRoot, 'package.json')));
const playwright = await import(pathToFileURL(requireFromFrontend.resolve('@playwright/test')).href);
// CommonJS interop: the package's named exports land on `default` under a file: import.
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) { console.error('could not resolve the chromium driver from the frontend workspace'); process.exit(2); }

const base = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';
const password = process.env.BUILDERGATE_PASSWORD;
if (!password) {
  // #57: no fallback literal. The old seed carried `|| '1234'`.
  console.error('BUILDERGATE_PASSWORD is not set; the seed cannot log in.');
  process.exit(2);
}

const started = Date.now();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
const page = await context.newPage();
const report = { baseUrl: base, startedAt: new Date(started).toISOString() };

try {
  await page.goto('/');
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.workspace-screen', { timeout: 15000 });
  report.loggedInAfterMs = Date.now() - started;

  const terminals = page.locator('.xterm-screen');
  const before = await terminals.count();
  report.terminalsBefore = before;

  // Two affordances, depending on whether the workspace already holds a terminal: the empty
  // state offers "+ Add Terminal", and the tab bar offers a "+" titled "Add Terminal". The old
  // seed only knew the first, so with a terminal already present it fell through to
  // "terminal already present" and created nothing while reporting success.
  const emptyStateAdd = page.getByRole('button', { name: '+ Add Terminal' });
  const tabBarAdd = page.locator('button[title="Add Terminal"]');
  const add = await emptyStateAdd.count() > 0 ? emptyStateAdd : tabBarAdd;
  if (await add.count() === 0) {
    report.action = 'no-add-control';
    // Not a silent success: a lane that cannot create its own terminal must say so, because the
    // spec it seeds for will then run against whatever happened to be there.
    throw new Error('no Add Terminal control is present; nothing was seeded');
  }
  const disabled = await add.first().isDisabled();
  if (disabled) {
    report.action = 'add-control-disabled';
    // At the tab or session cap the control is disabled by design. Clicking it would do
    // nothing and the count wait would then time out with a misleading message.
    throw new Error('the Add Terminal control is disabled (capacity reached); nothing was seeded');
  }

  const clickedAt = Date.now();
  await add.first().click();
  report.action = 'clicked-add-terminal';

  // The claim is "one MORE terminal exists", which the old wait could not express.
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.xterm-screen').length >= expected,
    before + 1,
    { timeout: 30000 },
  );
  const after = await terminals.count();
  report.terminalsAfter = after;
  if (after !== before + 1) {
    throw new Error(`expected exactly one new terminal, went from ${before} to ${after}`);
  }

  // Readiness of the NEW one, addressed by index rather than by ":visible" which the old
  // terminals also satisfy.
  await terminals.nth(after - 1).waitFor({ state: 'visible', timeout: 30000 });
  report.newTerminalVisibleAfterMs = Date.now() - clickedAt;
  report.createdAt = new Date(clickedAt).toISOString();
  report.readyAt = new Date().toISOString();
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  report.totalMs = Date.now() - started;
  await browser.close();
}

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
