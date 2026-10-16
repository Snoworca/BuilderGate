// Mobile touch regressions, end to end on the phone layout:
//   #127 the title bar close button of the file explorer and the editor window closes them;
//   #128 (FR-FEX-020) holding an explorer row for 1.5 s opens it, a 0.8 s hold only opens the menu,
//        and a press that moves opens nothing;
//   #129 (FR-ARCH-009) a terminal scrolled up with one finger stays there while a program keeps
//        redrawing the screen in writes larger than 10 KB, as Claude Code does.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD, in
// a phone project (Mobile Safari, or Mobile Chromium in playwright.mobile-editor.config.ts). Touches are synthetic TouchEvents dispatched on the element, as in
// terminal-mobile-scroll.spec.ts, so they run the same in every engine.
//
// Weak assertions avoided:
//   * "the long press dispatched" -- a hold that opened the context menu, not the file, would pass
//     a check that something appeared. The editor tab with the file's name is required, and the
//     0.8 s hold must leave no tab.
//   * "the scroll events were applied" -- #129 was exactly that: the scroll applied and was undone
//     by the next write. The scrollbar position is read 2.5 s after the swipe, while redraws run.
import { randomUUID } from 'node:crypto';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

declare global {
  interface Window { __bgFallThrough?: string[] }
}

// The phone projects: Mobile Safari, or Mobile Chromium in playwright.mobile-editor.config.ts.
const isPhoneProject = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;
const FILES: Record<string, Buffer | string> = {
  'notes.md': '# Mobile notes\n\nnotes-body\n',
  'app.ts': 'export const answer = 42;\n',
};

/** Dispatches a one-finger press on the first visible element matching `selector`. */
async function touchPress(page: Page, selector: string, options: { holdMs: number; moveAtMs?: number; moveBy?: number; endDy?: number; steps?: number }) {
  await page.evaluate(async ({ targetSelector, holdMs, moveAtMs, moveBy, endDy, steps }) => {
    const element = Array.from(document.querySelectorAll(targetSelector)).find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!(element instanceof HTMLElement)) throw new Error(`target not found: ${targetSelector}`);
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.min(60, rect.width / 2);
    const y0 = endDy === undefined ? rect.top + rect.height / 2 : rect.top + rect.height * 0.3;
    const touch = (y: number) => ({
      identifier: 1, target: element, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
      radiusX: 1, radiusY: 1, rotationAngle: 0, force: 0.5,
    }) as unknown as Touch;
    const dispatch = (type: string, touches: Touch[], changed: Touch[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches, configurable: true });
      Object.defineProperty(event, 'targetTouches', { value: touches, configurable: true });
      Object.defineProperty(event, 'changedTouches', { value: changed, configurable: true });
      element.dispatchEvent(event);
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    let current = touch(y0);
    dispatch('touchstart', [current], [current]);
    if (endDy !== undefined) {
      const count = steps ?? 16;
      for (let step = 1; step <= count; step += 1) {
        current = touch(y0 + (endDy * step) / count);
        dispatch('touchmove', [current], [current]);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } else if (moveAtMs !== undefined) {
      await sleep(moveAtMs);
      current = touch(y0 + (moveBy ?? 30));
      dispatch('touchmove', [current], [current]);
      await sleep(holdMs - moveAtMs);
    } else {
      await sleep(holdMs);
    }
    dispatch('touchend', [], [current]);
  }, { targetSelector: selector, ...options });
}

async function openExplorer(page: Page): Promise<void> {
  await page.locator('button[aria-label="파일 탐색기"]').first().tap();
  await expect(explorerDialog(page)).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.window-dialog [data-path$="notes.md"]').first()).toBeVisible({ timeout: 15000 });
}

function explorerDialog(page: Page) {
  return page.locator('.window-dialog').filter({ has: page.locator('.window-dialog-title', { hasText: '파일 탐색기' }) });
}

function editorTab(page: Page, name: string) {
  return page.locator('.editor-tab-label', { hasText: name });
}

test.describe('mobile touch regressions', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    test.skip(!isPhoneProject(testInfo.project), 'Phone projects only');
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(150000);
    record = newOwnedFolder(`mobile-touch-regressions/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-mtouch', FILES);
    await page.waitForSelector('.terminal-view:visible', { timeout: 30000 });
  });

  test.afterEach(async ({ request }, testInfo) => {
    if (!isPhoneProject(testInfo.project) || !record) return;
    await tearDownOwnedFolder(request, record);
  });

  // #127, FR-FEX-020 AC-1..AC-3
  test('a 1.5 s hold opens a row, a 0.8 s hold keeps the menu, a moved press opens nothing, and the close buttons close', async ({ page }) => {
    await openExplorer(page);

    // FR-FEX-020 AC-2: 0.8 s opens the menu only; releasing keeps it.
    await touchPress(page, '.window-dialog [data-path$="notes.md"]', { holdMs: 800 });
    await expect(page.locator('.context-menu-dialog')).toBeVisible();
    // A browser follows the release of a long press with compatibility mousedown and click events
    // at the finger's point, which is now over the menu's backdrop (observed in Chromium); synthetic
    // touches do not, so they are sent here.
    await page.evaluate(() => {
      const backdrop = document.querySelector('.context-menu-dialog-backdrop');
      if (!backdrop) throw new Error('no menu backdrop');
      for (const type of ['mousedown', 'mouseup', 'click']) {
        backdrop.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      }
    });
    await page.waitForTimeout(600);
    await expect(page.locator('.context-menu-dialog'), 'the release did not close the menu').toBeVisible();
    await expect(editorTab(page, 'notes.md')).toHaveCount(0);
    // A real tap on the backdrop, above the sheet, still closes it -- and does not fall through as
    // a click on what is under the menu.
    const sheet = await page.locator('.context-menu-dialog').boundingBox();
    if (!sheet) throw new Error('menu sheet has no box');
    await page.evaluate(() => {
      window.__bgFallThrough = [];
      document.addEventListener('click', (event) => {
        const target = event.target as Element | null;
        if (!target?.closest('.context-menu-dialog-backdrop')) window.__bgFallThrough?.push(target?.className?.toString() ?? '');
      }, { capture: true });
    });
    await page.locator('.context-menu-dialog-backdrop').tap({ position: { x: Math.round(sheet.x + sheet.width / 2), y: Math.round(sheet.y / 2) } });
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__bgFallThrough), 'the closing tap clicked nothing under the menu').toEqual([]);

    // AC-3: a press that moves 30 px is a scroll and opens nothing, even held past 1.5 s.
    await touchPress(page, '.window-dialog [data-path$="app.ts"]', { holdMs: 1800, moveAtMs: 200, moveBy: 30 });
    await page.waitForTimeout(1200);
    await expect(editorTab(page, 'app.ts')).toHaveCount(0);

    // AC-1: 1.7 s opens the file in the editor, and the menu the 0.5 s mark raised is gone.
    await touchPress(page, '.window-dialog [data-path$="notes.md"]', { holdMs: 1700 });
    await expect(editorTab(page, 'notes.md')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.context-menu-dialog')).toHaveCount(0);
    await page.screenshot({ path: '../.playwright-mcp/e2e-mobile-long-press-open.png' });

    // #127: each window's own close button closes it.
    const editorDialog = page.locator('.window-dialog').filter({ has: page.locator('.editor-tab-label', { hasText: 'notes.md' }) });
    await editorDialog.locator('.window-dialog-close').tap();
    await expect(editorTab(page, 'notes.md')).toHaveCount(0, { timeout: 10000 });
    await expect(explorerDialog(page)).toBeVisible();
    await explorerDialog(page).locator('.window-dialog-close').tap();
    await expect(explorerDialog(page)).toHaveCount(0, { timeout: 10000 });
  });

  // #129, FR-ARCH-009 AC-3
  test('a terminal scrolled up with one finger stays up while a program keeps redrawing', async ({ page }) => {
    const terminal = page.locator('.terminal-view:visible').first();
    await terminal.tap({ position: { x: 36, y: 36 } });
    await page.keyboard.type('1..200 | ForEach-Object { "BG-REDRAW-$_" }', { delay: 0 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    // A redraw over 10 KB every 0.4 s: 25 rows of 80 coloured cells, colours shifting each frame
    // so the terminal host has to send every cell again.
    await page.keyboard.type(
      '$e=[char]27; $i=0; while ($true) { $i++; $r=-join (1..80 | ForEach-Object { "$e[3$((($_+$i) % 6) + 1)m#" }); '
      + '[Console]::Write("$e[H" + ((1..25 | ForEach-Object { $r }) -join "`r`n") + "$e[0m"); Start-Sleep -Milliseconds 400 }',
      { delay: 0 },
    );
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    const sliderGap = () => page.evaluate(() => {
      const view = Array.from(document.querySelectorAll('.terminal-view')).find((node) => {
        const rect = (node as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const bar = view?.querySelector('.xterm-scrollable-element > .scrollbar.vertical') as HTMLElement | null;
      const slider = bar?.querySelector('.slider') as HTMLElement | null;
      if (!bar || !slider) return null;
      // Distance between the slider's bottom and the track's bottom, in px: 0 means at the bottom.
      return Math.round(bar.getBoundingClientRect().bottom - slider.getBoundingClientRect().bottom);
    });
    expect(await sliderGap(), 'the terminal starts at the bottom').toBeLessThanOrEqual(2);

    // Finger moving down reads earlier output.
    await touchPress(page, '.terminal-view .xterm-screen', { holdMs: 0, endDy: 400, steps: 20 });
    await touchPress(page, '.terminal-view .xterm-screen', { holdMs: 0, endDy: 400, steps: 20 });
    await page.waitForTimeout(300);
    const rightAfter = await sliderGap();
    await page.waitForTimeout(2500);
    const later = await sliderGap();
    await page.screenshot({ path: '../.playwright-mcp/e2e-mobile-scroll-during-redraw.png' });
    expect(rightAfter, 'the swipe scrolled up').toBeGreaterThan(20);
    expect(later, `still scrolled up 2.5 s later while redraws run (right after ${rightAfter}px)`).toBeGreaterThan(20);

    await page.keyboard.press('Control+C');
  });
});
