import { test, expect } from '@playwright/test';
import {
  clearCommandPresets,
  createCommandPreset,
  login,
  openCommandPresetDialog,
  waitForTerminal,
} from './helpers';

test.describe('Command Management Dialog', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only dialog coverage');
    await login(page);
    await waitForTerminal(page);
    await clearCommandPresets(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome') return;
    await clearCommandPresets(page);
  });

  test('opens from tools menu, blocks background, ignores overlay and Escape, and restores geometry', async ({ page }) => {
    await openCommandPresetDialog(page);

    const dialog = page.locator('.window-dialog');
    await expect(page.getByTestId('command-preset-dialog')).toBeVisible();

    await page.mouse.click(12, 12);
    await expect(page.getByTestId('command-preset-dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-preset-dialog')).toBeVisible();

    const settingsButton = page.locator('button[title="Settings"]');
    const settingsBox = await settingsButton.boundingBox();
    if (settingsBox) {
      await page.mouse.click(settingsBox.x + settingsBox.width / 2, settingsBox.y + settingsBox.height / 2);
      await expect(page.locator('.settings-page')).toHaveCount(0);
    }

    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      await expect.poll(async () => {
        return page.evaluate(() => Boolean(document.activeElement?.closest('.window-dialog')));
      }).toBe(true);
    }

    const before = await dialog.boundingBox();
    expect(before).not.toBeNull();
    const titlebar = page.locator('.window-dialog-titlebar');
    const titlebarBox = await titlebar.boundingBox();
    expect(titlebarBox).not.toBeNull();

    await page.mouse.move(titlebarBox!.x + 80, titlebarBox!.y + 18);
    await page.mouse.down();
    await page.mouse.move(titlebarBox!.x + 180, titlebarBox!.y + 78, { steps: 8 });
    await page.mouse.up();

    const dragged = await dialog.boundingBox();
    expect(dragged).not.toBeNull();
    await page.mouse.move(dragged!.x + dragged!.width - 3, dragged!.y + dragged!.height - 3);
    await page.mouse.down();
    await page.mouse.move(dragged!.x + dragged!.width + 70, dragged!.y + dragged!.height + 40, { steps: 8 });
    await page.mouse.up();

    const changed = await dialog.boundingBox();
    expect(changed).not.toBeNull();
    expect(Math.abs(changed!.x - before!.x)).toBeGreaterThan(20);
    expect(changed!.width).toBeGreaterThan(before!.width);

    await page.locator('.window-dialog-close').click();
    await expect(page.getByTestId('command-preset-dialog')).toHaveCount(0);

    await openCommandPresetDialog(page);
    const restored = await page.locator('.window-dialog').boundingBox();
    expect(restored).not.toBeNull();
    expect(Math.abs(restored!.x - changed!.x)).toBeLessThan(8);
    expect(Math.abs(restored!.width - changed!.width)).toBeLessThan(8);
  });

  test('supports CRUD, copy toast, tab persistence, and terminal execute rules', async ({ page }) => {
    const stamp = Date.now();
    const commandLabel = `e2e-dialog-command-${stamp}`;
    const secondCommandLabel = `e2e-dialog-command-second-${stamp}`;
    const directoryLabel = `e2e-dialog-directory-${stamp}`;
    const promptLabel = `e2e-dialog-prompt-${stamp}`;
    const commandMarker = `e2e-command-${stamp}`;
    const promptMarker = `e2e-prompt-${stamp}`;

    await openCommandPresetDialog(page);
    await createCommandPreset(page, 'command', commandLabel, `echo ${commandMarker}`);
    await createCommandPreset(page, 'command', secondCommandLabel, 'echo second');

    await page.getByLabel(`${secondCommandLabel} 위로`).click();
    const commandItems = page.locator('.command-preset-item-command h3');
    await expect(commandItems.first()).toHaveText(secondCommandLabel);

    await page.getByLabel(`${secondCommandLabel} 수정`).click();
    await page.locator('.command-preset-form input').first().fill(`${secondCommandLabel}-edited`);
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText(`${secondCommandLabel}-edited`)).toBeVisible();

    await page.getByLabel(`${commandLabel} 복사`).click();
    await expect(page.getByText('복사되었습니다.')).toBeVisible();

    await page.getByLabel(`${commandLabel} 실행`).click();
    await expect(page.locator('.xterm-screen:visible').first()).toContainText(commandMarker, { timeout: 15000 });

    await createCommandPreset(page, 'directory', directoryLabel, '.');
    await page.getByLabel(`${directoryLabel} 실행`).click();
    await expect(page.locator('.xterm-screen:visible').first()).toContainText('cd "."', { timeout: 15000 });

    await createCommandPreset(page, 'prompt', promptLabel, `${promptMarker}\nsecond line`);
    await page.getByLabel(`${promptLabel} 실행`).click();
    await expect(page.locator('.xterm-screen:visible').first()).toContainText(promptMarker, { timeout: 15000 });

    await page.locator('.window-dialog-close').click();
    await openCommandPresetDialog(page);
    await expect(page.getByRole('tab', { name: '프롬프트' })).toHaveAttribute('aria-selected', 'true');

    await page.getByLabel(`${promptLabel} 삭제`).click();
    await expect(page.getByText(promptLabel)).toHaveCount(0);
  });
});
