import { test, expect } from '@playwright/test';
import { login, openTerminalContextMenu, waitForTerminal } from './helpers';

test.describe('Terminal right-click policy', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await waitForTerminal(page);
  });

  test('suppresses secondary down events before they reach the xterm screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop mouse coverage');

    const result = await page.evaluate(() => {
      const screen = Array.from(document.querySelectorAll<HTMLElement>('.xterm-screen'))
        .find((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        });

      if (!screen) {
        throw new Error('Visible xterm screen not found');
      }

      const received: string[] = [];
      const record = (event: Event) => {
        received.push(`${event.type}:${(event as MouseEvent).button}`);
      };
      screen.addEventListener('pointerdown', record);
      screen.addEventListener('mousedown', record);

      const rect = screen.getBoundingClientRect();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.max(1, rect.width / 2),
        clientY: rect.top + Math.max(1, rect.height / 2),
      };
      const rightPointer = new PointerEvent('pointerdown', {
        ...eventInit,
        button: 2,
        buttons: 2,
        pointerId: 1,
        pointerType: 'mouse',
      });
      const rightMouse = new MouseEvent('mousedown', {
        ...eventInit,
        button: 2,
        buttons: 2,
      });
      const leftPointer = new PointerEvent('pointerdown', {
        ...eventInit,
        button: 0,
        buttons: 1,
        pointerId: 2,
        pointerType: 'mouse',
      });
      const leftMouse = new MouseEvent('mousedown', {
        ...eventInit,
        button: 0,
        buttons: 1,
      });

      screen.dispatchEvent(rightPointer);
      screen.dispatchEvent(rightMouse);
      screen.dispatchEvent(leftPointer);
      screen.dispatchEvent(leftMouse);

      screen.removeEventListener('pointerdown', record);
      screen.removeEventListener('mousedown', record);

      return {
        received,
        rightPointerDefaultPrevented: rightPointer.defaultPrevented,
        rightMouseDefaultPrevented: rightMouse.defaultPrevented,
        leftPointerDefaultPrevented: leftPointer.defaultPrevented,
        leftMouseDefaultPrevented: leftMouse.defaultPrevented,
      };
    });

    expect(result.received).toEqual(['pointerdown:0', 'mousedown:0']);
    expect(result.rightPointerDefaultPrevented).toBe(true);
    expect(result.rightMouseDefaultPrevented).toBe(true);
    expect(result.leftPointerDefaultPrevented).toBe(false);
  });

  test('keeps the custom terminal context menu available on right click', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop mouse coverage');

    await openTerminalContextMenu(page);

    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.getByText('복사')).toBeVisible();
    await expect(page.getByText('붙여넣기', { exact: true })).toBeVisible();
  });
});
