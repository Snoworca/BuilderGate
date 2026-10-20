// REL-BGSTAB-049 (#155), on 2222, phone: after a tab switch whose first frames have no size (the
// layout still settling, as when Android closes the keyboard on the tap), the revealed terminal is
// actually painted. Measured on the screen: the bright text the terminal printed is counted in a
// screenshot of the terminal area, so a blank canvas fails whatever the DOM says.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const require = createRequire(import.meta.url);
const { PNG } = require('playwright-core/lib/utilsBundle') as { PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } } };

const tab = (page: Page, name: string) => page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first();

/** Bright pixels in the stage: printed text shows as light glyphs on the dark terminal. */
async function brightPixels(page: Page): Promise<number> {
  const box = await page.locator('.terminal-workspace-stage').first().boundingBox();
  const shot = await page.screenshot({ clip: { x: box!.x, y: box!.y, width: box!.width, height: Math.min(box!.height, 300) } });
  const png = PNG.sync.read(shot);
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 450) count += 1;
  }
  return count;
}

test.describe('revealed terminal is painted', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.use.isMobile !== true, 'phone layout');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(180000);
    record = newOwnedFolder(`mobile-tab-reveal-paint/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-paint', { 'x.txt': 'x\n' });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  test('a tab revealed while the layout has no size is painted once it settles', async ({ page }) => {
    // Bright text in the work tab's terminal.
    const stage = page.locator('.terminal-workspace-stage').first();
    const sbox = await stage.boundingBox();
    await page.touchscreen.tap(sbox!.x + 40, sbox!.y + 40);
    await page.keyboard.type('echo ' + 'W'.repeat(40));
    await page.keyboard.press('Enter');
    await expect.poll(() => brightPixels(page), { timeout: 15000 }).toBeGreaterThan(400);
    const baseline = await brightPixels(page);

    const results: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      // Output keeps arriving while the tab is hidden, so its reveal starts hidden-output recovery
      // at the same moment as the fit.
      await page.keyboard.type('ping -n 4 127.0.0.1');
      await page.keyboard.press('Enter');
      await tab(page, 'e2e-paint-base').tap();
      await expect(tab(page, 'e2e-paint-base')).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(2500);
      // The tap back: the stage has no height for the first frames, as when the keyboard closes.
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.id = 'e2e-zero-stage';
        style.textContent = '.terminal-workspace-stage { height: 0 !important; min-height: 0 !important; flex: 0 0 0 !important; overflow: hidden !important; }';
        document.head.appendChild(style);
        setTimeout(() => style.remove(), 90);
      });
      await tab(page, 'e2e-paint-work').tap();
      await expect(tab(page, 'e2e-paint-work')).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(1500);
      results.push(await brightPixels(page));
      // Focus the work terminal again for the next round's command.
      const again = await page.locator('.terminal-workspace-stage').first().boundingBox();
      await page.touchscreen.tap(again!.x + 40, again!.y + 40);
    }
    console.log(`baseline=${baseline} after reveals=${results.join(',')}`);
    await page.screenshot({ path: '../.playwright-mcp/e2e-tab-reveal-paint.png' });
    for (const value of results) expect(value, `bright pixels after a reveal (baseline ${baseline})`).toBeGreaterThan(baseline * 0.5);
  });

  // A terminal hidden longer than hiddenRuntimeTtlMs is evicted and rebuilt on return, as the
  // user's long-hidden tabs are. The TTL is set to its 1 s minimum for the run and restored.
  test('a tab evicted while hidden is painted when it returns', async ({ page }) => {
    const token = await page.evaluate(() => localStorage.getItem('cws_auth_token'));
    const patch = (ms: number) => page.request.patch(`${ORIGIN}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { resourceLimits: { workspaceRuntime: { hiddenRuntimeTtlMs: ms } } },
    });
    expect((await patch(1000)).status(), 'ttl lowered').toBe(200);
    try {
      await page.reload();
      await expect(tab(page, 'e2e-paint-work')).toBeVisible({ timeout: 20000 });
      await tab(page, 'e2e-paint-work').tap();
      await expect(tab(page, 'e2e-paint-work')).toHaveAttribute('aria-selected', 'true');
      const stageBox = await page.locator('.terminal-workspace-stage').first().boundingBox();
      await page.touchscreen.tap(stageBox!.x + 40, stageBox!.y + 40);
      await page.keyboard.type('echo ' + 'W'.repeat(40));
      await page.keyboard.press('Enter');
      await expect.poll(() => brightPixels(page), { timeout: 15000 }).toBeGreaterThan(400);
      const results: number[] = [];
      for (let round = 0; round < 4; round += 1) {
        await tab(page, 'e2e-paint-base').tap();
        await expect(tab(page, 'e2e-paint-base')).toHaveAttribute('aria-selected', 'true');
        await page.waitForTimeout(4000);
        await tab(page, 'e2e-paint-work').tap();
        await expect(tab(page, 'e2e-paint-work')).toHaveAttribute('aria-selected', 'true');
        await page.waitForTimeout(2000);
        results.push(await brightPixels(page));
      }
      console.log(`evicted reveals=${results.join(',')}`);
      await page.screenshot({ path: '../.playwright-mcp/e2e-tab-reveal-evicted.png' });
      for (const value of results) expect(value, 'bright pixels after an evicted tab returns').toBeGreaterThan(400);
    } finally {
      expect((await patch(600000)).status(), 'ttl restored').toBe(200);
    }
  });

  // Android may reclaim a WebGL context as soon as a revealed terminal takes one. While the tab is
  // hidden, the next WebGL context created is lost right after creation; the terminal must still
  // show its text once revealed (through the fallback renderer).
  test('a tab whose WebGL context is lost on reveal is painted', async ({ page }) => {
    const stageBox = await page.locator('.terminal-workspace-stage').first().boundingBox();
    await page.touchscreen.tap(stageBox!.x + 40, stageBox!.y + 40);
    await page.keyboard.type('echo ' + 'W'.repeat(40));
    await page.keyboard.press('Enter');
    await expect.poll(() => brightPixels(page), { timeout: 15000 }).toBeGreaterThan(400);
    const results: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      await tab(page, 'e2e-paint-base').tap();
      await expect(tab(page, 'e2e-paint-base')).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        (HTMLCanvasElement.prototype as unknown as { getContext: (...args: unknown[]) => unknown }).getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
          const context = (original as (...a: unknown[]) => unknown).apply(this, args) as WebGL2RenderingContext | null;
          if (args[0] === 'webgl2' && context !== null) {
            HTMLCanvasElement.prototype.getContext = original;
            setTimeout(() => context.getExtension('WEBGL_lose_context')?.loseContext(), 30);
          }
          return context;
        };
      });
      await tab(page, 'e2e-paint-work').tap();
      await expect(tab(page, 'e2e-paint-work')).toHaveAttribute('aria-selected', 'true');
      await page.waitForTimeout(2000);
      results.push(await brightPixels(page));
    }
    console.log(`context-lost reveals=${results.join(',')}`);
    await page.screenshot({ path: '../.playwright-mcp/e2e-tab-reveal-context-lost.png' });
    for (const value of results) expect(value, 'bright pixels after a reveal whose WebGL context was lost').toBeGreaterThan(400);
  });
});
