import { expect, test } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

/**
 * PERF-BGSTAB-013 AC-2, renderer-transition half only (issue #15).
 *
 * The title names exactly what the body asserts. An earlier draft was called
 * '...and leaves the terminal usable' while asserting no such thing — that is the
 * signature-versus-body inflation this epic keeps finding, so it was renamed
 * rather than left to read as broader coverage than it has.
 *
 * This exists because the original evidence for those two ACs was a screenshot
 * under .playwright-mcp/, which is gitignored — so the safety claim of the whole
 * requirement rested on an artifact nobody else could reproduce. This spec is
 * the reproducible form.
 *
 * It verifies the fallback by actually taking the GPU context away via the
 * WEBGL_lose_context extension, not by asserting that a handler is registered.
 * The distinction matters: an assertion-shaped test would have passed against an
 * unverified fallback.
 *
 * Renderer identification is by construction rather than by name: xterm's WebGL
 * renderer draws to <canvas> and produces no per-row DOM, while its DOM renderer
 * produces one div per row under .xterm-rows and no canvas. So the transition
 * "canvases > 0 and rows == 0" -> "canvases == 0 and rows > 0" IS the fallback.
 */

test.describe('PERF-BGSTAB-013 WebGL renderer falls back to DOM on context loss', () => {
  test('context loss disposes the WebGL addon and the DOM renderer takes over', async ({ page }) => {
    await login(page);
    await waitForTerminal(page);

    // The WebGL renderer must actually be in use before the loss, otherwise the
    // post-loss assertion would pass vacuously on a terminal that was never
    // accelerated.
    //
    // Note the probe CANNOT be confirmed in the DOM before the loss: while WebGL
    // is attached the terminal draws to canvas and its text is not in
    // document.body.innerText at all. Its appearance in the DOM *after* the loss
    // is therefore part of the evidence, not a precondition.
    const before = await page.evaluate(() => ({
      canvases: document.querySelectorAll('.xterm canvas').length,
      domRows: document.querySelectorAll('.xterm-rows > div').length,
    }));
    expect(before.canvases, 'WebGL renderer should be attached on a visible terminal').toBeGreaterThan(0);
    expect(before.domRows, 'the DOM renderer should not be drawing rows while WebGL is attached').toBe(0);


    const contextsLost = await page.evaluate(() => {
      let killed = 0;
      for (const canvas of Array.from(document.querySelectorAll('.xterm canvas'))) {
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
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('.xterm-rows > div').length), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    const after = await page.evaluate(() => ({
      canvases: document.querySelectorAll('.xterm canvas').length,
      domRows: document.querySelectorAll('.xterm-rows > div').length,
    }));
    expect(after.canvases, 'the dead WebGL addon must be disposed, not left attached').toBe(0);

    // WHAT THIS SPEC DOES NOT ESTABLISH.
    //
    // AC-2's "content is preserved" and AC-3's "still usable afterwards" are NOT
    // asserted here, deliberately. Both were observed by hand on 2026-09-18
    // against an established session with existing scrollback: 46 populated rows
    // after the loss, and a subsequent echo that reached the PTY and rendered.
    // Neither reproduces in this harness, which creates a FRESH workspace: after
    // the loss the rows are present but empty, and a typed echo does not arrive.
    //
    // Two explanations fit and this spec does not distinguish them: either the
    // fresh terminal simply had no content and this harness's input never reached
    // the PTY, or the fallback genuinely degrades on a session with no prior
    // output. Asserting either one here would be guessing, so the ACs stay
    // unchecked in the SRS until the two are told apart.
  });
});
