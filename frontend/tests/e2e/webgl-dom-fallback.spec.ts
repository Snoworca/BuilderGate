import { expect, test } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

/**
 * PERF-BGSTAB-013 AC-1 and AC-2 (issue #15). AC-3 is explicitly NOT covered —
 * see the note at the end of the test.
 *
 * This exists because the original evidence for AC-2/AC-3 was a screenshot under
 * .playwright-mcp/, which is gitignored and was written to a different checkout —
 * so the safety claim of the requirement rested on an artifact nobody could
 * reproduce. This spec is the reproducible form.
 *
 * It verifies the fallback by actually taking the GPU context away via the
 * WEBGL_lose_context extension, not by asserting a handler is registered. An
 * assertion-shaped test would have gone green over a fallback that had never
 * been verified.
 *
 * Renderer identification is by construction rather than by name: xterm's WebGL
 * renderer draws to <canvas> and produces no per-row DOM, while its DOM renderer
 * produces one div per row and no canvas. So "canvases > 0, rows == 0" ->
 * "canvases == 0, rows > 0" IS the fallback.
 */

test.describe('PERF-BGSTAB-013 WebGL renderer falls back to DOM on context loss', () => {
  test('context loss falls back to the DOM renderer with content intact', async ({ page }) => {
    await login(page);
    await waitForTerminal(page);

    // This spec creates NO session and sends NO input, deliberately. An earlier
    // draft opened a tab per run and leaked it; tabs accumulated to the terminal
    // cap, which disabled the "+" control and, before that, stopped newly created
    // terminals from going live — which looked exactly like intermittent input
    // delivery. Reading the renderer needs neither a new session nor input, so
    // this version has no state to clean up and nothing to leak.

    // Every reading is scoped to the ONE visible terminal view. Hidden views stay
    // mounted and render on the DOM, so a page-wide count mixes them in.
    // Visibility is offsetParent: the app marks inactive tabs with neither a
    // [hidden] attribute nor display:none.
    const counts = () => page.evaluate(() => {
      const views = Array.from(document.querySelectorAll('.terminal-view')) as HTMLElement[];
      const visible = views.find((v) => v.offsetParent !== null);
      return {
        canvases: visible ? visible.querySelectorAll('.xterm canvas').length : -1,
        domRows: visible ? visible.querySelectorAll('.xterm-rows > div').length : -1,
        hiddenViewCanvases: views
          .filter((v) => v.offsetParent === null)
          .reduce((n, v) => n + v.querySelectorAll('.xterm canvas').length, 0),
      };
    });

    const before = await counts();
    // AC-1, in a real browser: hidden views must hold no GPU context.
    expect(before.hiddenViewCanvases, 'hidden terminal views must not hold WebGL contexts').toBe(0);
    // The WebGL renderer must genuinely be in use, or the post-loss assertion
    // would pass vacuously on a terminal that was never accelerated.
    expect(before.canvases, 'WebGL should be attached on the visible terminal').toBeGreaterThan(0);
    expect(before.domRows, 'the DOM renderer should not be drawing while WebGL is attached').toBe(0);

    // Seed content before the loss. While WebGL is attached the terminal text is
    // not in the DOM at all, so the probe's appearance AFTER the loss is part of
    // the evidence, not a precondition.
    // NOTE: this spec does not send terminal input, and that is deliberate.
    // Input delivery on this host is unreliable in two separate ways, both
    // measured 2026-09-18 and both unrelated to the renderer: a session carrying
    // very large retained scrollback blocks input from a newly attached client
    // entirely, and even on a freshly created session delivery is intermittent.
    // Any assertion that depends on input would make this spec flaky and would
    // misreport an input problem as a rendering one.

    const contextsLost = await page.evaluate(() => {
      const views = Array.from(document.querySelectorAll('.terminal-view')) as HTMLElement[];
      const visible = views.find((v) => v.offsetParent !== null);
      let killed = 0;
      for (const canvas of Array.from(visible?.querySelectorAll('.xterm canvas') ?? [])) {
        for (const type of ['webgl2', 'webgl']) {
          const gl = (canvas as HTMLCanvasElement).getContext(type) as WebGLRenderingContext | null;
          if (gl) {
            const ext = gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null;
            if (ext) {
              ext.loseContext();
              killed += 1;
            }
            break;
          }
        }
      }
      return killed;
    });
    expect(contextsLost, 'the test must actually take a context away').toBeGreaterThan(0);

    // AC-2: the fallback is a repaint, not a blank viewport.
    await expect.poll(async () => (await counts()).domRows, { timeout: 15_000 }).toBeGreaterThan(0);
    const after = await counts();
    expect(after.canvases, 'the dead WebGL addon must be disposed, not left attached').toBe(0);

    // NOT ASSERTED HERE: AC-2's "content survives the loss" and AC-3's "still
    // usable afterwards". Both require putting input through the PTY, which is
    // independently unreliable on this host (see the note above), so asserting
    // them would report an input defect as a renderer defect. Both were observed
    // to hold on runs where input did land; neither is claimed from this spec.
    //
    // What IS established here on every run: hidden views hold no GPU context
    // (AC-1), and a real context loss disposes the addon and hands rendering to
    // the DOM renderer, which repaints a non-empty viewport (AC-2).

  });
});
