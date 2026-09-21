import { test, expect } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

/**
 * MIG-BGSTAB-004 AC-1 in a real browser.
 *
 * Every other test of the binary data plane stops short of the renderer: the
 * server tests drive a raw socket, and the unit tests decode frames without one.
 * The last step — a real browser negotiating, receiving binary frames, and
 * painting them into xterm — was the only part of this feature that had never
 * been measured, so this is the test that closes it.
 *
 * It asserts both halves. A binary frame arriving proves the codec is live; text
 * on screen proves the decode reached the renderer. Either alone would pass
 * while the feature was broken: frames with an empty terminal is a decode that
 * goes nowhere, and a painted terminal with zero binary frames is the JSON
 * fallback quietly doing the work.
 */

test.describe('binary data plane', () => {
  test('the browser negotiates binary and renders frames it decoded itself', async ({ page }) => {
    const binaryFrames: number[] = [];
    let textFrames = 0;
    let negotiated = false;
    let jsonOutputs = 0;

    // Registered before navigation: the socket opens during load, and a listener
    // attached afterwards would miss the handshake it is here to observe.
    page.on('websocket', ws => {
      ws.on('framereceived', frame => {
        const payload = frame.payload;
        if (typeof payload !== 'string') {
          binaryFrames.push(payload.length);
          return;
        }
        textFrames += 1;
        try {
          const message = JSON.parse(payload) as { type?: string };
          if (message.type === 'terminal-binary:capability') negotiated = true;
          if (message.type === 'output') jsonOutputs += 1;
        } catch {
          // Not every text frame is JSON we care about.
        }
      });
    });

    await page.goto('/');
    await login(page);
    await waitForTerminal(page);

    // The shell prints its own prompt; give the delivery path a moment to run
    // rather than racing the first paint.
    await expect.poll(
      () => binaryFrames.length,
      {
        message: `no binary frame reached the browser (text frames: ${textFrames}, json outputs: ${jsonOutputs}, negotiated: ${negotiated})`,
        timeout: 30_000,
      },
    ).toBeGreaterThan(0);

    expect(negotiated, 'the server must have answered the capability offer').toBe(true);

    const rendered = await page.evaluate(
      () => document.querySelector('.xterm-screen')?.textContent?.trim() ?? '',
    );
    expect(
      rendered.length,
      'the terminal painted nothing, so the decoded frames never reached the renderer',
    ).toBeGreaterThan(0);

    // Control: with binary live, terminal output must not also be arriving as
    // JSON `output` messages. A non-zero count here means the fallback is
    // carrying traffic the binary path was supposed to take.
    expect(
      jsonOutputs,
      `terminal output still arrived as JSON ${jsonOutputs} time(s) while binary was negotiated`,
    ).toBe(0);
  });
});
