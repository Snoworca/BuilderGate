import { expect, test } from '@playwright/test';
import { login } from './helpers';

// FR-UIDS-011 (#148): every header button stays on screen at phone widths, with
// a sixth button (the editor tray, shown while documents are open) as well.
const ORIGIN = 'https://localhost:2222';
const isPhoneProject = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  Boolean(project.use.isMobile || project.use.hasTouch);

test.describe('mobile header fit', () => {
  test.use({ baseURL: ORIGIN, ignoreHTTPSErrors: true });

  test('FR-UIDS-011 AC-3: header buttons fit at 412, 375, 360 and 320 px', async ({ page }, testInfo) => {
    test.skip(!isPhoneProject(testInfo.project), 'Phone projects only');
    await login(page);
    await page.waitForSelector('.header-right button', { timeout: 20000 });
    for (const width of [412, 375, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(300);
      // A copy of a header button stands in for the editor tray button.
      const measured = await page.evaluate(() => {
        const right = document.querySelector('.header-right')!;
        const extra = right.querySelector('button')!.cloneNode(true) as HTMLElement;
        extra.setAttribute('data-e2e-extra', 'true');
        right.insertBefore(extra, right.firstChild);
        const edges = [...right.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().right));
        const sizes = [...right.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().width));
        extra.remove();
        return { vw: window.innerWidth, maxRight: Math.max(...edges), count: edges.length, sizes };
      });
      console.log(`width ${width}: ${JSON.stringify(measured)}`);
      expect(measured.count, 'six buttons measured').toBeGreaterThanOrEqual(6);
      expect(measured.maxRight, `buttons end inside ${width} px`).toBeLessThanOrEqual(measured.vw);
    }
  });
});
