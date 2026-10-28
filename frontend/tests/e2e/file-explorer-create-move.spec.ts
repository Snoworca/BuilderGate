// FR-FEX-028 (#152), FR-FEX-029 / FR-FOP-008 (#153), FR-FEX-030 (#154), end to end on 2222:
// the explorer fills the stage on a phone, makes a new file from its context menu, and moves or
// copies entries dropped onto a folder.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

const explorer = (page: Page) => page.locator('.window-dialog').filter({ has: page.locator('.fx-window-body') }).first();
const row = (page: Page, name: string) => explorer(page).locator(`[data-path$="${name}"]`).first();

async function openExplorer(page: Page, phone: boolean, firstName: string): Promise<void> {
  const button = page.locator('button[aria-label="파일 탐색기"]').first();
  if (phone) await button.tap(); else await button.click();
  await expect(row(page, firstName)).toBeVisible({ timeout: 15000 });
}

// FR-FEX-032 on a phone: one synthetic finger, dispatched on the element it went down on, as
// a phone does (mobile-touch-regressions.spec.ts does the same).
async function finger(page: Page, type: 'touchstart' | 'touchmove' | 'touchend', x: number, y: number): Promise<void> {
  await page.evaluate(({ type, x, y }) => {
    const w = window as unknown as { __bgFinger?: Element };
    if (type === 'touchstart') w.__bgFinger = document.elementFromPoint(x, y) ?? undefined;
    const target = w.__bgFinger;
    if (!target) throw new Error('no element under the finger');
    const touch = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 0.5 };
    const event = new Event(type, { bubbles: true, cancelable: true });
    const touches = type === 'touchend' ? [] : [touch];
    Object.defineProperty(event, 'touches', { value: touches });
    Object.defineProperty(event, 'targetTouches', { value: touches });
    Object.defineProperty(event, 'changedTouches', { value: [touch] });
    target.dispatchEvent(event);
  }, { type, x, y });
}

test.describe('file explorer: stage on a phone, new file, drag and drop', () => {
  let record: OwnedFolder;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(120000);
    record = newOwnedFolder(`file-explorer-create-move/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-fxcm', {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'target/keep.txt': 'keep\n',
      'other/inner/deep.txt': 'deep\n',
    });
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-FEX-028 AC-1, AC-3
  test('the window fills the stage on a phone and floats on a desktop', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    // FR-UIDS-014: on a phone the box is the whole app (header and tab bar included).
    const stage = await page.locator(phone ? '.app' : '.terminal-workspace-stage').first().boundingBox();
    const win = await explorer(page).boundingBox();
    expect(stage, 'stage measured').not.toBeNull();
    expect(win, 'window measured').not.toBeNull();
    // Measured, not assumed: a floating window is the 760x520 default, far below any stage.
    const fillsStage = Math.abs(win!.x - stage!.x) <= 2 && Math.abs(win!.y - stage!.y) <= 2
      && Math.abs(win!.width - stage!.width) <= 2 && Math.abs(win!.height - stage!.height) <= 2;
    console.log(`stage=${JSON.stringify(stage)} window=${JSON.stringify(win)} phone=${phone}`);
    expect(fillsStage).toBe(phone);
    const maximize = explorer(page).locator('button[aria-label="최대화"]');
    await expect(maximize).toHaveCount(phone ? 0 : 1);
    await page.screenshot({ path: `../.playwright-mcp/e2e-fx-stage-${phone ? 'phone' : 'desktop'}.png` });
  });

  // FR-UIDS-014 AC-1: the editor opened on a phone covers the whole app too.
  test('the editor covers the whole app on a phone', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project), 'phone layout');
    await openExplorer(page, true, 'a.txt');
    const target = row(page, 'a.txt');
    const box = await target.boundingBox();
    // FR-FEX-032 AC-6: a double tap opens the file.
    await page.touchscreen.tap(box!.x + 30, box!.y + box!.height / 2);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(box!.x + 30, box!.y + box!.height / 2);
    const editor = page.locator('.window-dialog').filter({ has: page.locator('.editor-window-host') }).first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    const app = await page.locator('.app').first().boundingBox();
    await expect.poll(async () => {
      const win = await editor.boundingBox();
      return win !== null && Math.abs(win.x - app!.x) <= 2 && Math.abs(win.y - app!.y) <= 2
        && Math.abs(win.width - app!.width) <= 2 && Math.abs(win.height - app!.height) <= 2;
    }, { timeout: 5000 }).toBe(true);
    await page.screenshot({ path: '../.playwright-mcp/e2e-editor-fullscreen-phone.png' });
  });

  // FR-FEX-029 AC-1~AC-6, FR-FOP-008 AC-1/AC-2
  test('새 파일 makes an empty file and refuses a taken name', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    const dialog = explorer(page).locator('.fx-new-file-box');
    const input = dialog.locator('input');
    const create = dialog.locator('button', { hasText: '만들기' });
    const open = async () => {
      if (phone) {
        await explorer(page).locator('.fx-mobile-button', { hasText: '더보기' }).tap();
        const sheet = explorer(page).locator('.fx-sheet');
        const labels = (await sheet.locator('.fx-sheet-item .fx-sheet-label').allTextContents()).map(text => text.trim());
        expect(labels.indexOf('새 폴더'), `sheet: ${labels.join(', ')}`).toBe(labels.indexOf('새 파일') + 1);
        await sheet.locator('.fx-sheet-item', { hasText: '새 파일' }).tap();
      } else {
        // Empty space below the last row: the shown folder (a file row disables it, as for 새 폴더).
        const rows = explorer(page).locator('.fx-rows').first();
        const box = await rows.boundingBox();
        await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 4, { button: 'right' });
        const labels = (await page.locator('.context-menu .context-menu-item').allTextContents()).map(text => text.trim());
        const at = labels.findIndex(text => text.startsWith('새 파일'));
        expect(at, `menu: ${labels.join(', ')}`).toBeGreaterThanOrEqual(0);
        expect(labels[at + 1]).toMatch(/^새 폴더/);
        await page.locator('.context-menu .context-menu-item', { hasText: '새 파일' }).click();
      }
      await expect(dialog).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('');
      await expect(create).toBeDisabled();
    };

    // AC-4: a name the folder already lists, file or folder.
    await open();
    await input.fill('a.txt');
    await expect(dialog.locator('.fx-new-file-message')).toHaveText("이 폴더에 이미 'a.txt' 파일이 있습니다.");
    await expect(create).toBeDisabled();
    await input.fill('target');
    await expect(dialog.locator('.fx-new-file-message')).toHaveText("이 폴더에 이미 'target' 폴더가 있습니다.");
    // AC-3
    await input.fill('x/y.txt');
    await expect(create).toBeDisabled();
    // AC-5: taken on disk since the listing; the server refuses and nothing is overwritten.
    writeFileSync(joinPath(record.folder!, 'race.txt'), 'race\n');
    await input.fill('race.txt');
    await expect(create).toBeEnabled();
    await create.click();
    await expect(dialog.locator('.fx-new-file-message')).toContainText('그 사이에 같은 이름의 항목이 생겼습니다: race.txt');
    await expect(dialog).toBeVisible();
    expect(readFileSync(joinPath(record.folder!, 'race.txt'), 'utf8')).toBe('race\n');
    // AC-2: Escape cancels.
    await input.press('Escape');
    await expect(dialog).toBeHidden();

    // AC-6: Enter creates, the window closes, the file is selected.
    await open();
    await input.fill('new-note.md');
    if (phone) await create.tap(); else await input.press('Enter');
    await expect(dialog).toBeHidden();
    const made = joinPath(record.folder!, 'new-note.md');
    await expect.poll(() => existsSync(made)).toBe(true);
    expect(statSync(made).size).toBe(0);
    await expect(row(page, 'new-note.md')).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
    await expect(page.locator('.editor-window-host')).toHaveCount(0);
    await page.screenshot({ path: `../.playwright-mcp/e2e-fx-newfile-${phone ? 'phone' : 'desktop'}.png` });
  });

  // FR-FEX-030 AC-1~AC-3, AC-6
  test('rows dragged onto a folder move, copy with Ctrl, and refuse a drop onto themselves', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    if (phone) {
      // AC-6: no drag on a touch screen.
      await expect(row(page, 'a.txt')).toHaveAttribute('draggable', 'false');
      return;
    }
    await expect(row(page, 'a.txt')).toHaveAttribute('draggable', 'true');
    const folder = record.folder!;
    const chip = explorer(page).locator('.fx-drop-chip');
    const centre = async (name: string) => {
      const box = await row(page, name).boundingBox();
      return { x: box!.x + box!.width / 3, y: box!.y + box!.height / 2 };
    };
    const drag = async (from: string, to: string, copy: boolean, inspect?: () => Promise<void>) => {
      const a = await centre(from);
      const b = await centre(to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(a.x + 8, a.y + 8, { steps: 4 });
      if (copy) await page.keyboard.down('Control');
      await page.mouse.move(b.x, b.y, { steps: 8 });
      await page.mouse.move(b.x + 2, b.y, { steps: 2 });
      if (inspect) await inspect();
      await page.mouse.up();
      if (copy) await page.keyboard.up('Control');
    };

    // AC-2: Ctrl copies a.txt into other/, the original stays.
    await row(page, 'a.txt').click();
    await drag('a.txt', 'other', true, async () => {
      await expect(chip).toContainText('복사 → other');
    });
    await expect.poll(() => existsSync(joinPath(folder, 'other', 'a.txt')), { timeout: 15000 }).toBe(true);
    expect(existsSync(joinPath(folder, 'a.txt')), 'the copy left the original').toBe(true);

    // AC-1, AC-2: a two-row selection moves together into target/.
    await row(page, 'a.txt').click();
    await row(page, 'b.txt').click({ modifiers: ['Control'] });
    await drag('b.txt', 'target', false, async () => {
      await expect(chip).toContainText('이동 → target');
      await expect(row(page, 'target')).toHaveClass(/fx-drop-target/);
    });
    await expect.poll(() => existsSync(joinPath(folder, 'target', 'a.txt')) && existsSync(joinPath(folder, 'target', 'b.txt')), { timeout: 15000 }).toBe(true);
    await expect.poll(() => existsSync(joinPath(folder, 'a.txt')) || existsSync(joinPath(folder, 'b.txt'))).toBe(false);
    expect(readFileSync(joinPath(folder, 'target', 'b.txt'), 'utf8')).toBe('b\n');
    await expect(row(page, 'a.txt')).toHaveCount(0);

    // AC-3: a folder onto itself is refused, and nothing moves.
    await row(page, 'other').click();
    await drag('other', 'other', false, async () => {
      await expect(chip).toContainText('자기 자신에는 놓을 수 없습니다');
      await expect(row(page, 'other')).toHaveClass(/fx-drop-deny/);
      await page.screenshot({ path: '../.playwright-mcp/e2e-fx-drag-deny.png' });
    });
    await page.waitForTimeout(1000);
    expect(existsSync(joinPath(folder, 'other', 'inner', 'deep.txt'))).toBe(true);
    expect(existsSync(joinPath(folder, 'other', 'other'))).toBe(false);
    await expect(chip).not.toHaveClass(/is-shown/);
  });

  // FR-FEX-032 AC-1~AC-5
  test('a held row is picked up, leaves the list, follows the pointer and drops on a folder', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    const folder = record.folder!;
    const chip = explorer(page).locator('.fx-drop-chip');
    const ghost = page.locator('.fx-pick-ghost');
    const centre = async (name: string) => {
      const box = await row(page, name).boundingBox();
      return { x: box!.x + box!.width / 3, y: box!.y + box!.height / 2 };
    };
    const down = async (p: { x: number; y: number }) => {
      if (phone) await finger(page, 'touchstart', p.x, p.y);
      else { await page.mouse.move(p.x, p.y); await page.mouse.down(); }
    };
    const moveTo = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      for (let i = 1; i <= 8; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / 8;
        const y = from.y + ((to.y - from.y) * i) / 8;
        if (phone) await finger(page, 'touchmove', x, y); else await page.mouse.move(x, y);
      }
    };
    const up = async (p: { x: number; y: number }) => {
      if (phone) await finger(page, 'touchend', p.x, p.y); else await page.mouse.up();
    };

    // AC-1: held still for 0.45 s, a.txt leaves the list and a card with its name appears.
    const a = await centre('a.txt');
    await down(a);
    await page.waitForTimeout(700);
    await expect(row(page, 'a.txt')).toBeHidden();
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveText('a.txt');
    // AC-2: over a folder the chip says what a drop does and the folder lights up.
    const t = await centre('target');
    await moveTo(a, t);
    await expect(chip).toContainText('이동 → target');
    await expect(row(page, 'target')).toHaveClass(/fx-drop-target/);
    const card = await ghost.boundingBox();
    expect(card, 'the card is drawn').not.toBeNull();
    expect(Math.hypot(card!.x - t.x, card!.y - t.y), 'the card follows the pointer').toBeLessThan(80);
    await page.screenshot({ path: `../.playwright-mcp/e2e-fx-pick-${phone ? 'phone' : 'desktop'}.png` });
    // AC-3: the release moves it.
    await up(t);
    await expect(ghost).toHaveCount(0);
    await expect.poll(() => existsSync(joinPath(folder, 'target', 'a.txt')), { timeout: 15000 }).toBe(true);
    await expect.poll(() => existsSync(joinPath(folder, 'a.txt'))).toBe(false);

    // AC-3: Escape (desktop) or a release outside the explorer (phone) puts b.txt back.
    const b = await centre('b.txt');
    await down(b);
    await page.waitForTimeout(700);
    await expect(row(page, 'b.txt')).toBeHidden();
    const o = await centre('other');
    await moveTo(b, o);
    await expect(chip).toContainText('이동 → other');
    if (phone) {
      const title = await explorer(page).locator('.window-dialog-title').first().boundingBox();
      const away = { x: title!.x + 10, y: title!.y + title!.height / 2 };
      await moveTo(o, away);
      await up(away);
    } else {
      await page.keyboard.press('Escape');
      await page.mouse.up();
    }
    await expect(ghost).toHaveCount(0);
    await expect(row(page, 'b.txt')).toBeVisible();
    await page.waitForTimeout(800);
    expect(existsSync(joinPath(folder, 'b.txt')), 'b.txt stayed').toBe(true);
    expect(existsSync(joinPath(folder, 'other', 'b.txt'))).toBe(false);

    if (!phone) {
      // AC-3: with Ctrl held at the release it is a copy.
      const b2 = await centre('b.txt');
      await down(b2);
      await page.waitForTimeout(700);
      const o2 = await centre('other');
      await moveTo(b2, o2);
      await page.keyboard.down('Control');
      await page.mouse.move(o2.x + 2, o2.y);
      await expect(chip).toContainText('복사 → other');
      await page.mouse.up();
      await page.keyboard.up('Control');
      await expect.poll(() => existsSync(joinPath(folder, 'other', 'b.txt')), { timeout: 15000 }).toBe(true);
      expect(existsSync(joinPath(folder, 'b.txt')), 'the copy left the original').toBe(true);
      // AC-5: a mouse released in place puts the row back and opens no menu.
      const b3 = await centre('b.txt');
      await down(b3);
      await page.waitForTimeout(700);
      await expect(row(page, 'b.txt')).toBeHidden();
      await page.mouse.up();
      await expect(row(page, 'b.txt')).toBeVisible();
      await expect(page.locator('.context-menu')).toHaveCount(0);
    }
  });

  // FR-FEX-033 AC-1, AC-2
  test('a file row takes a drop for its folder, and the drop says it is running until the job ends', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo.project);
    await openExplorer(page, phone, 'a.txt');
    const folder = record.folder!;
    const chip = explorer(page).locator('.fx-drop-chip');
    const centre = async (name: string) => {
      const box = await row(page, name).boundingBox();
      return { x: box!.x + box!.width / 3, y: box!.y + box!.height / 2 };
    };
    // Opening other/ opens its single-child chain to inner/ (FR-FEX-015), showing deep.txt.
    const expander = row(page, 'other').locator('.fx-expander');
    if (phone) await expander.tap(); else await expander.click();
    await expect(row(page, 'deep.txt')).toBeVisible();
    // Watch for the pending pill: a fast job may show it only briefly.
    await page.evaluate(() => {
      const w = window as unknown as { __bgPendingSeen?: string };
      w.__bgPendingSeen = '';
      new MutationObserver(() => {
        const pill = document.querySelector('.fx-drop-pending');
        if (pill && !w.__bgPendingSeen) w.__bgPendingSeen = pill.textContent ?? '';
      }).observe(document.body, { childList: true, subtree: true });
    });
    const d = await centre('deep.txt');
    if (phone) await finger(page, 'touchstart', d.x, d.y); else { await page.mouse.move(d.x, d.y); await page.mouse.down(); }
    await page.waitForTimeout(700);
    await expect(row(page, 'deep.txt')).toBeHidden();
    const a = await centre('a.txt');
    for (let i = 1; i <= 8; i += 1) {
      const x = d.x + ((a.x - d.x) * i) / 8;
      const y = d.y + ((a.y - d.y) * i) / 8;
      if (phone) await finger(page, 'touchmove', x, y); else await page.mouse.move(x, y);
    }
    // AC-1: over a root-level file the drop goes to the root folder.
    const rootName = folder.split(/[\\/]/).filter(Boolean).pop()!;
    await expect(chip).toContainText(`이동 → ${rootName}`);
    if (phone) await finger(page, 'touchend', a.x, a.y); else await page.mouse.up();
    await expect.poll(() => existsSync(joinPath(folder, 'deep.txt')), { timeout: 15000 }).toBe(true);
    expect(existsSync(joinPath(folder, 'other', 'inner', 'deep.txt'))).toBe(false);
    // AC-2: the pill named the move as soon as it was dropped, and is gone once the job ended.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __bgPendingSeen?: string }).__bgPendingSeen)).toContain('1개 항목 이동 중');
    await expect(explorer(page).locator('.fx-drop-pending')).toHaveCount(0, { timeout: 15000 });
  });
});
