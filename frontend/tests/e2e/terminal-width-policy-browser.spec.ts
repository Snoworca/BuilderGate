import { expect, test } from '@playwright/test';
import {
  getActiveSessionId,
  login,
  waitForTerminal,
  waitForTerminalInputReady,
} from './helpers';

/**
 * Issue #114, the criterion that says the change must be verified in a real
 * browser. FR-BGSTAB-029.
 *
 * What the unit guards already establish, and what they cannot:
 *
 *   tests/unit/terminalWidthPolicyParity.test.ts reads both source trees as
 *   text. It is a claim about two string literals.
 *
 *   tests/unit/terminalUnicodeWidthGolden.test.ts and
 *   tests/unit/terminalReflowParity.test.ts construct the real `@xterm/xterm`
 *   and `@xterm/headless` engines in bare Node and compare them. That is the
 *   decisive measurement of what the options DO.
 *
 * Neither can say whether the shipped browser bundle ends up with them. A
 * bundler can drop an addon; `Unicode11Addon.activate()` throws outright when
 * `allowProposedApi` is absent, which is how this very change was caught mid-
 * flight; and `term.options` is what the component actually passed, not what the
 * source says it passes. Only a terminal running in a browser answers that, and
 * that is the whole scope of this spec.
 *
 * It reads the LIVE terminal through the debug capture registered by
 * TerminalView, so it is renderer-independent: under the WebGL renderer since
 * #15 the text is not in the DOM at all.
 *
 * This spec creates NO session and sends NO input. It reads an already-running
 * terminal, so there is nothing to clean up and nothing to leak — the same
 * reason webgl-dom-fallback.spec.ts is built that way.
 */

interface WidthPolicyProbe {
  unicodeActiveVersion: string | null;
  unicodeVersions: string[];
  allowProposedApi: boolean | undefined;
  reflowCursorLine: boolean | undefined;
}

test.describe('FR-BGSTAB-029 width policy reaches the live browser terminal', () => {
  test('#114 the running terminal carries the unicode table and the resolved options', async ({ page }) => {
    await login(page);
    await waitForTerminal(page);

    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');
    // test.skip throws when its condition holds, which TypeScript cannot see.
    if (sessionId === null) throw new Error('unreachable: test.skip already bailed');

    const probe = await page.evaluate(
      (id): WidthPolicyProbe | null =>
        window.__buildergateTerminalDebug?.captureTerminalWidthPolicy?.(id) ?? null,
      sessionId,
    );

    // Log before asserting. A probe that came back null and an option that came
    // back wrong are different failures, and an assertion message that fires on
    // the first of them loses the rest of the reading.
    console.log('[#114] live terminal width policy:', JSON.stringify(probe));

    expect(
      probe,
      'the width-policy capture returned nothing. Either no terminal is registered for this '
        + 'session, or the debug surface is not installed on this host — in both cases this run '
        + 'measured nothing and must not be read as the options being absent.',
    ).not.toBeNull();

    // `allowProposedApi` first: without it the unicode read below is not merely
    // false, it is unavailable, and reporting "version is null" would describe
    // the symptom rather than the cause.
    expect(
      probe?.allowProposedApi,
      'the live terminal was built without allowProposedApi, so Unicode11Addon.activate() '
        + 'would have thrown and the terminal is on xterm\'s built-in Unicode 6 table while the '
        + 'server replica is on 11',
    ).toBe(true);

    expect(
      probe?.unicodeVersions,
      'the running terminal does not offer unicode version 11, so @xterm/addon-unicode11 did '
        + 'not register in this bundle. The source loads it; something between the source and '
        + 'the browser dropped it.',
    ).toContain('11');

    expect(
      probe?.unicodeActiveVersion,
      'the addon registered but the terminal is not using it. Registering a version and '
        + 'selecting it are two steps, and only the second one changes any width.',
    ).toBe('11');

    expect(
      probe?.reflowCursorLine,
      'the live terminal disagrees with the server replica about reflowCursorLine, so a resize '
        + 'makes the replica describe a screen the user is not looking at',
    ).toBe(false);
  });
});

/**
 * Issue #114, the measurement that decides the VALUE rather than the parity.
 *
 * `reflowCursorLine` only acts on a resize, and only on the logical line the
 * cursor is on. Measured in bare Node against both engines, narrowing while the
 * cursor sits on a wrapped line loses the overflow with the option off and keeps
 * it with the option on — the server's own snapshot-resize test has been pinning
 * exactly that for as long as the server had it on.
 *
 * That reading says nothing about what the USER ends up seeing, because a live
 * shell reprints its prompt line on SIGWINCH and the engine reading cannot
 * include that. Whether the typed command survives a narrow is a property of
 * xterm AND the shell together, and only a browser attached to a real PTY has
 * both. That is what this measures.
 *
 * It reads the buffer through the debug capture rather than the DOM, because
 * under the WebGL renderer the text is not in the DOM at all.
 */
test.describe('FR-BGSTAB-029 resize reflow with a live shell', () => {
  test('#114 a wrapped typed command survives narrowing the window', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await login(page);
    await waitForTerminal(page);
    await waitForTerminalInputReady(page);

    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');
    if (sessionId === null) throw new Error('unreachable: test.skip already bailed');

    // The capture joins buffer ROWS with newlines, and the whole point of this
    // measurement is a marker long enough to span rows. Comparing the raw text
    // would fail on the wrap rather than on the content, which is an instrument
    // defect dressed as a product one — it happened on the first run of this
    // spec. Strip whitespace on both sides so the question asked is "are these
    // characters still on screen", not "are they still on one row".
    const readFlat = async (): Promise<string | null> => {
      const text = await page.evaluate(
        (id) => window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? null,
        sessionId,
      );
      return text === null ? null : text.replace(/\s+/g, '');
    };
    const readPolicy = () => page.evaluate(
      (id) => window.__buildergateTerminalDebug?.captureTerminalWidthPolicy?.(id) ?? null,
      sessionId,
    );

    // A marker long enough to wrap at the wide width, so the cursor is on a
    // wrapped logical line — the only state the option can act on. No Enter: the
    // command must stay uncommitted, because a committed line is history and
    // reflowCursorLine does not touch history.
    const marker = `BGSTAB114-${'q'.repeat(180)}-END`;
    await page.locator('.xterm-screen:visible').first().click();
    await page.keyboard.type(marker, { delay: 0 });

    await expect.poll(readFlat, {
      message: 'the typed marker never reached the terminal buffer, so nothing was measured',
      timeout: 20_000,
    }).toContain(marker);

    const before = await readFlat();
    await page.setViewportSize({ width: 520, height: 900 });

    // Let the resize, the PTY SIGWINCH and any shell redraw all land. Polling for
    // a settled reading would not discriminate here: the pre-resize text already
    // contains the marker, so a poll that returns immediately would report the
    // state before the resize as if it were the state after.
    await page.waitForTimeout(3_000);

    const after = await readFlat();
    const policy = await readPolicy();

    // Log before asserting, so the reading survives whatever the assertion says.
    console.log('[#114] reflow narrow measurement:', JSON.stringify({
      reflowCursorLine: policy?.reflowCursorLine,
      markerBefore: before?.includes(marker) ?? null,
      markerAfter: after?.includes(marker) ?? null,
      markerHeadAfter: after?.includes('BGSTAB114-') ?? null,
      markerTailAfter: after?.includes('-END') ?? null,
    }));

    expect(
      after,
      'after narrowing the window the typed command is no longer on screen in full. Whatever '
        + 'reflowCursorLine is set to, the shell reprints its own prompt line on SIGWINCH, so '
        + 'this is the end state the user is given — and losing typed input to a window resize '
        + 'is a defect regardless of which side of the option produced it.',
    ).toContain(marker);

    await page.setViewportSize({ width: 1400, height: 900 });
  });
});
