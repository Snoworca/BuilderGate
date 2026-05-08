import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
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
    const headerButtons = page.locator('.header-right > button');
    await expect(headerButtons).toHaveCount(4);
    await expect(headerButtons.nth(0)).toHaveAttribute('title', /Switch to (Grid|Tabs)/);
    await expect(headerButtons.nth(1)).toHaveAttribute('title', 'Tools');
    await expect(headerButtons.nth(2)).toHaveAttribute('title', 'Settings');
    await expect(headerButtons.nth(3)).toHaveText('Logout');

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
    const e2eCommandItems = page.locator('.command-preset-item-command h3').filter({ hasText: 'e2e-dialog-command' });
    await expect(e2eCommandItems.first()).toHaveText(secondCommandLabel);

    await page.getByLabel(`${secondCommandLabel} 수정`).click();
    await expect(page.getByLabel(`${secondCommandLabel} 라벨 수정`)).toBeVisible();
    await expect(page.locator('.command-preset-form input').first()).toHaveValue('');
    await page.getByLabel(`${secondCommandLabel} 라벨 수정`).fill(`${secondCommandLabel}-edited`);
    await page.getByLabel(`${secondCommandLabel} 내용 수정`).fill('echo second edited');
    await page.getByLabel(`${secondCommandLabel} 저장`).click();
    await expect(page.getByText(`${secondCommandLabel}-edited`)).toBeVisible();
    await expect(
      page.locator('.command-preset-item-command')
        .filter({ hasText: `${secondCommandLabel}-edited` })
        .locator('input'),
    ).toHaveValue('echo second edited');

    await page.getByLabel(`${commandLabel} 복사`).click();
    await expect(page.getByText('복사되었습니다.')).toBeVisible();

    await page.getByLabel(`${commandLabel} 실행`).click();
    await expect(page.locator('.xterm-screen:visible').first()).toContainText(commandMarker, { timeout: 15000 });

    await createCommandPreset(page, 'directory', directoryLabel, '.');
    await page.getByLabel(`${directoryLabel} 실행`).click();
    await expect(page.locator('.xterm-screen:visible').first()).toContainText('cd "."', { timeout: 15000 });

    await createCommandPreset(page, 'prompt', promptLabel, `${promptMarker}\nsecond line`);
    await page.getByLabel(`${promptLabel} 수정`).click();
    await expect(page.getByLabel(`${promptLabel} 라벨 수정`)).toBeVisible();
    await page.getByLabel(`${promptLabel} 프롬프트 수정`).fill(`${promptMarker}-edited\nsecond line`);
    await page.getByLabel(`${promptLabel} 저장`).click();
    await expect(page.getByText('수정되었습니다.')).toBeVisible();
    await expect(page.getByLabel(`${promptLabel} 실행`)).toHaveCount(0);
    await page.getByLabel(`${promptLabel} 복사`).click();
    await expect(page.getByText('복사되었습니다.')).toBeVisible();

    await page.locator('.window-dialog-close').click();
    await openCommandPresetDialog(page);
    await expect(page.getByRole('tab', { name: '프롬프트' })).toHaveAttribute('aria-selected', 'true');

    let deleteRequestCount = 0;
    await page.route('**/api/command-presets/**', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteRequestCount += 1;
      }
      await route.continue();
    });

    await page.getByRole('tab', { name: '커맨드 라인' }).click();
    await page.getByLabel(`${commandLabel} 삭제`).click();
    const cancelMessageBoxId = await expectDeleteMessageBox(page, commandLabel);
    await expectMessageBoxDialogContract(page);
    await expectTopmostMessageBoxFocusTrap(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog', { name: '삭제 확인' })).toBeVisible();
    await page.mouse.click(20, 20);
    await expect(page.getByRole('alertdialog', { name: '삭제 확인' })).toBeVisible();

    const lowerCloseBox = await page.locator('.window-dialog-close').boundingBox();
    expect(lowerCloseBox).not.toBeNull();
    await page.mouse.click(
      lowerCloseBox!.x + lowerCloseBox!.width / 2,
      lowerCloseBox!.y + lowerCloseBox!.height / 2,
    );
    await expect(page.getByRole('alertdialog', { name: '삭제 확인' })).toBeVisible();
    await expect(page.getByTestId('command-preset-dialog')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(commandLabel)).toBeVisible();
    expect(await readDialogGeometryStorage(page, cancelMessageBoxId)).toBeNull();
    expect(deleteRequestCount).toBe(0);

    await page.getByLabel(`${commandLabel} 삭제`).click();
    await expectDeleteMessageBox(page, commandLabel);
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText(commandLabel)).toHaveCount(0);
    await expect(page.getByText('삭제되었습니다.')).toBeVisible();
    expect(deleteRequestCount).toBe(1);

    await page.getByRole('tab', { name: '디렉토리' }).click();
    await page.getByLabel(`${directoryLabel} 삭제`).click();
    await expectDeleteMessageBox(page, directoryLabel);
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText(directoryLabel)).toHaveCount(0);

    await page.getByRole('tab', { name: '프롬프트' }).click();
    await page.getByLabel(`${promptLabel} 삭제`).click();
    await expectDeleteMessageBox(page, promptLabel);
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText(promptLabel)).toHaveCount(0);
    await page.unroute('**/api/command-presets/**');
  });

  test('keeps delete confirmation open when the server rejects deletion', async ({ page }) => {
    const stamp = Date.now();
    const commandLabel = `e2e-dialog-delete-failure-${stamp}`;
    const failDelete = async (route: Route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'delete failed' }),
        });
        return;
      }
      await route.continue();
    };

    await openCommandPresetDialog(page);
    await createCommandPreset(page, 'command', commandLabel, 'echo delete failure');
    await page.route('**/api/command-presets/**', failDelete);

    try {
      await page.getByLabel(`${commandLabel} 삭제`).click();
      await expectDeleteMessageBox(page, commandLabel);
      await page.getByRole('button', { name: 'OK' }).click();
      const messageBox = page.getByRole('alertdialog', { name: '삭제 확인' });
      await expect(messageBox).toBeVisible();
      await expect(messageBox.getByRole('alert')).toContainText(/Request failed|delete failed|삭제/);
      await expect(page.locator('.command-preset-item-command h3', { hasText: commandLabel })).toBeVisible();
    } finally {
      await page.unroute('**/api/command-presets/**', failDelete);
    }

    await page.getByRole('button', { name: 'Cancel' }).click();
  });
});

async function expectDeleteMessageBox(page: Page, label: string): Promise<string> {
  const messageBox = page.getByRole('alertdialog', { name: '삭제 확인' });
  await expect(messageBox).toBeVisible();
  const labelledBy = await messageBox.getAttribute('aria-labelledby');
  expect(labelledBy).toBeTruthy();
  const descriptionId = await messageBox.getAttribute('aria-describedby');
  expect(descriptionId).toBeTruthy();
  await expect(page.locator(`[id="${descriptionId}"]`)).toContainText(label);
  await expect(page.locator(`[id="${descriptionId}"]`)).toContainText('삭제');
  await expect(messageBox.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(messageBox.getByRole('button', { name: 'OK' })).toBeVisible();
  return labelledBy!.replace(/-title$/, '');
}

async function expectMessageBoxDialogContract(page: Page): Promise<void> {
  const messageBox = page.getByRole('alertdialog', { name: '삭제 확인' });
  const messageWindow = page.locator('.window-dialog').filter({ has: messageBox });
  await expect(messageBox.locator('.window-dialog-close')).toHaveCount(0);

  const before = await messageWindow.boundingBox();
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width - 2, before!.y + before!.height - 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width + 80, before!.y + before!.height + 60, { steps: 6 });
  await page.mouse.up();
  const after = await messageWindow.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.width - before!.width)).toBeLessThan(3);
  expect(Math.abs(after!.height - before!.height)).toBeLessThan(3);
}

async function expectTopmostMessageBoxFocusTrap(page: Page): Promise<void> {
  const messageBox = page.getByRole('alertdialog', { name: '삭제 확인' });
  await messageBox.getByRole('button', { name: 'Cancel' }).focus();

  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('Tab');
    await expect.poll(async () => {
      return page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null);
    }).toBe(true);
  }

  await page.evaluate(() => {
    const outsideButton = document.createElement('button');
    outsideButton.id = 'e2e-outside-focus-target';
    outsideButton.textContent = 'outside focus target';
    document.body.appendChild(outsideButton);
    outsideButton.focus();
  });
  await expect.poll(async () => {
    return page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') !== null);
  }).toBe(true);
  await page.locator('#e2e-outside-focus-target').evaluate(element => element.remove());
}

async function readDialogGeometryStorage(page: Page, dialogId: string): Promise<string | null> {
  return page.evaluate((id) => {
    return localStorage.getItem(`buildergate.dialog.${id}.geometry`);
  }, dialogId);
}
