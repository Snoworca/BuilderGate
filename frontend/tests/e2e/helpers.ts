import { Page, expect } from '@playwright/test';

/** Login with password from env or default */
export async function login(page: Page) {
  const password = process.env.BUILDERGATE_PASSWORD || '1234';
  await page.goto('/');
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.workspace-screen', { timeout: 10000 });
}

/** Wait for xterm.js terminal to render */
export async function waitForTerminal(page: Page) {
  await page.waitForSelector('.xterm-screen:visible', { timeout: 15000 });
}

/** Open the command preset manager through the header tools menu */
export async function openCommandPresetDialog(page: Page): Promise<void> {
  await page.locator('button[title="Tools"]').click();
  await page.locator('.context-menu-item:has-text("명령줄 관리")').click();
  await expect(page.getByTestId('command-preset-dialog')).toBeVisible({ timeout: 10000 });
}

/** Remove command preset E2E data from the server and local browser preferences */
export async function clearCommandPresets(page: Page): Promise<void> {
  if (!page.url().startsWith('http')) {
    return;
  }

  await page.evaluate(async () => {
    if (!['http:', 'https:'].includes(location.protocol)) {
      return;
    }
    localStorage.removeItem('buildergate.commandPresetManager.activeTab');
    localStorage.removeItem('buildergate.dialog.command-preset-manager.geometry');
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/command-presets', { headers });
    if (!res.ok) return;
    const data = await res.json();
    const presets = Array.isArray(data.presets) ? data.presets : [];
    await Promise.all(presets
      .filter((preset: { label?: string }) => preset.label?.startsWith('e2e-dialog-'))
      .map((preset: { id: string }) => fetch(`/api/command-presets/${preset.id}`, {
        method: 'DELETE',
        headers,
      })));
  });
}

/** Create a command preset through the dialog UI */
export async function createCommandPreset(
  page: Page,
  kind: 'command' | 'directory' | 'prompt',
  label: string,
  value: string,
): Promise<void> {
  const tabLabel = kind === 'command' ? '커맨드 라인' : kind === 'directory' ? '디렉토리' : '프롬프트';
  const dialog = page.getByTestId('command-preset-dialog');
  await dialog.getByRole('tab', { name: tabLabel }).click();
  await dialog.locator('.command-preset-form input').first().fill(label);
  if (kind === 'prompt') {
    await dialog.locator('.command-preset-form textarea').fill(value);
  } else {
    await dialog.locator('.command-preset-form input').nth(1).fill(value);
  }
  await dialog.getByRole('button', { name: '등록' }).click();
  await expect(dialog.getByText(label)).toBeVisible({ timeout: 10000 });
}

/** Right-click on the nth pane (0-based) */
export async function rightClickPane(page: Page, index: number) {
  const pane = page.locator('.pane-leaf').nth(index);
  await pane.click({ button: 'right' });
  await page.waitForSelector('.context-menu', { timeout: 3000 });
}

/** Click a context menu item by label text */
export async function selectMenuItem(page: Page, label: string) {
  const item = page.locator(`.context-menu-item:has-text("${label}")`).first();
  await item.click();
}

/** Count visible pane leaves */
export async function getPaneCount(page: Page): Promise<number> {
  return page.locator('.pane-leaf').count();
}

/** Wait for a specific pane count */
export async function verifyPaneCount(page: Page, expected: number) {
  await expect(page.locator('.pane-leaf')).toHaveCount(expected, { timeout: 10000 });
}

/** Clear IndexedDB for clean test state */
export async function clearIndexedDB(page: Page) {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('buildergate');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  });
}

/** Simulate Ctrl+B prefix key */
export async function pressCtrlB(page: Page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
}

/** Simulate left swipe on mobile carousel */
export async function swipeLeft(page: Page, selector: string) {
  const el = page.locator(selector);
  const box = await el.boundingBox();
  if (!box) throw new Error('Element not found for swipe');
  const startX = box.x + box.width * 0.8;
  const endX = box.x + box.width * 0.2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(startX - ((startX - endX) * (i + 1)) / 10, y);
  }
  await page.mouse.up();
}

/** Drag a resizer element by a pixel offset */
export async function dragResizer(page: Page, offsetX: number, offsetY: number) {
  const resizer = page.locator('.pane-resizer').first();
  const box = await resizer.boundingBox();
  if (!box) throw new Error('Resizer not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + offsetX, cy + offsetY, { steps: 5 });
  await page.mouse.up();
}

/** Get server session count via API */
export async function getServerSessionCount(page: Page): Promise<number> {
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch('/api/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  });
  return result;
}
