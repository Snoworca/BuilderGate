import { expect, type Page } from '@playwright/test';
import { test } from './workspaceOwnershipFixture';
import { login, waitForTerminal } from './helpers';
import {
  activateSelectionWorkspace,
  captureSelection,
  captureTerminalLines,
  cleanupSelectionWorkspace,
  createSingleLineSelection,
  dragAcrossRow,
  locateMarker,
  loseWebglContext,
  rendererCounts,
  selectUiTab,
  sendCommandPreservingSelection,
  sendCommandAndWaitForMarker,
} from './terminalSelectionFixture';

/**
 * FR-BGSTAB-029 (issue #16) item 5 — the browser half.
 *
 * Item 5 asks for regressions over the five situations in which a selection can
 * break: reset/reflow, user-scroll during output, WebGL context loss, DOM
 * fallback, and hide/reveal. reset/reflow is answered headless in
 * tests/unit/terminalSelectionLifecycleCharacterization.test.ts, which found
 * that a reflowing column resize silently repoints the selection. The other four
 * are here because none of them can be answered without a real browser:
 *
 *   - WebGL context loss and DOM fallback need a GPU context to take away.
 *   - hide/reveal is what drives the WebGL attach/release cycle (#15), so it is
 *     a renderer swap in both directions.
 *   - user-scroll needs a real layout. MEASURED 2026-09-19: under jsdom,
 *     `scrollLines(-10)` on a 41-row buffer with baseY 36 leaves viewportY at
 *     36, and so do scrollToTop() and scrollToBottom() — xterm's viewport
 *     service needs real element dimensions. A unit test calling them would be
 *     asserting over a call that did nothing.
 *
 * RESULT, measured 2026-09-19 against a live https://localhost:2222: all four
 * are sound. That is worth stating plainly, because the headless half of item 5
 * found three defects and it would be easy to assume the renderer half is broken
 * too. It is not: a selection survives a real GPU context loss, the DOM fallback
 * that follows it, a hide/reveal renderer swap in both directions, and output
 * continuing to arrive under a scrolled-back viewport.
 *
 * Every test here carries a control that makes its "survived" reading mean
 * something. A selection that survives a renderer swap proves nothing if the
 * renderer never swapped, so each test asserts the swap happened BY CONSTRUCTION
 * — canvases versus per-row divs — before it asserts anything about the
 * selection.
 *
 * Two things this spec must not be read as claiming. It does not claim a
 * selection is safe in general: the unit half's reflow finding stands, and a
 * column resize here would break it just as it does there. And it does not claim
 * that keyboard input preserves a selection — MEASURED, and used as a
 * precondition below: typing into the terminal CLEARS the selection, which is
 * why the scroll test makes its selection by dragging after the producer has
 * already been started rather than before.
 */

const MARKER_PREFIX = {
  hideReveal: 'HRMARK',
  contextLoss: 'GLMARK',
} as const;

test.describe('FR-BGSTAB-029 item 5 — selection across renderer lifecycle and user scroll', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop selection contract');
  });

  /**
   * hide/reveal AND DOM fallback in one measurement, because in this app they
   * are the same event: #15 attaches the WebGL addon only while a terminal is
   * visible, so hiding a tab releases the context and drops that view to the DOM
   * renderer, and revealing it re-attaches. The renderer readings below are the
   * evidence that both directions actually happened.
   */
  test('a selection survives hide/reveal, which is a renderer swap in both directions', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateSelectionWorkspace(page, 2);
    const [selected, other] = workspace.sessionIds;
    try {
      const marker = `${MARKER_PREFIX.hideReveal}-${Date.now()}`;
      await createSingleLineSelection(page, selected, marker);

      const visibleBefore = await rendererCounts(page, selected);
      expect(visibleBefore.canvases, 'the visible terminal must be on the WebGL renderer, or the '
        + 'swap this test measures never happens').toBeGreaterThan(0);
      expect(visibleBefore.domRows, 'the DOM renderer must not be drawing while WebGL is attached').toBe(0);

      await selectUiTab(page, other);
      // The release is asynchronous; poll for the swap rather than assuming it
      // completed by the time the tab click resolved.
      await expect.poll(async () => (await rendererCounts(page, selected)).domRows, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const hidden = await rendererCounts(page, selected);
      expect(hidden.canvases, 'a hidden view must hold no GPU context (#15 AC-1)').toBe(0);

      const whileHidden = await captureSelection(page, selected);
      expect(whileHidden?.hasSelection, 'the selection must survive being hidden').toBe(true);
      expect(whileHidden?.text.trim()).toBe(marker);

      await selectUiTab(page, selected);
      await expect.poll(async () => (await rendererCounts(page, selected)).canvases, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const revealed = await rendererCounts(page, selected);
      expect(revealed.domRows, 'revealing must put the view back on WebGL, not leave it on the DOM')
        .toBe(0);

      const afterReveal = await captureSelection(page, selected);
      expect(afterReveal?.hasSelection, 'the selection must survive the reveal').toBe(true);
      expect(
        afterReveal?.text.trim(),
        'the selection must still hold the SAME text after two renderer swaps -- surviving as a '
        + 'non-empty selection pointing at something else is the failure mode this epic is about',
      ).toBe(marker);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });

  /**
   * A real GPU context loss, not a simulated one: WEBGL_lose_context takes the
   * context away the way a driver restart or a context-budget eviction does. An
   * assertion-shaped test that checked a handler was registered would go green
   * over a fallback nobody had ever exercised.
   */
  test('a selection survives a real WebGL context loss and the DOM fallback that follows', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateSelectionWorkspace(page, 1);
    const [session] = workspace.sessionIds;
    try {
      const marker = `${MARKER_PREFIX.contextLoss}-${Date.now()}`;
      await createSingleLineSelection(page, session, marker);

      const before = await rendererCounts(page, session);
      expect(before.canvases, 'WebGL must be attached, or killing a context proves nothing')
        .toBeGreaterThan(0);
      expect(before.domRows).toBe(0);

      const killed = await loseWebglContext(page, session);
      expect(killed, 'the test must actually take a context away').toBeGreaterThan(0);

      await expect.poll(async () => (await rendererCounts(page, session)).domRows, { timeout: 20_000 })
        .toBeGreaterThan(0);
      const after = await rendererCounts(page, session);
      expect(after.canvases, 'the dead addon must be disposed, not left attached').toBe(0);

      const selection = await captureSelection(page, session);
      expect(selection?.hasSelection, 'the selection must survive the context loss').toBe(true);
      expect(selection?.text.trim()).toBe(marker);

      // The fallback must be a repaint, not a blank viewport: while WebGL was
      // attached the text was not in the DOM at all, so the marker's presence
      // now is part of the evidence rather than a leftover.
      const lines = await captureTerminalLines(page, session);
      expect(
        lines?.some(line => line.trim() === marker),
        'the DOM fallback must repaint the content, not leave an empty screen',
      ).toBe(true);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });

  /**
   * The scenario item 5 calls "output 중 user-scroll".
   *
   * Getting this to measure the right thing took two attempts, and the first one
   * is worth recording because it looked like a defect. MEASURED 2026-09-19: if
   * you scroll up and THEN type the command that produces output, the view snaps
   * back to the bottom — but that is xterm's `scrollOnUserInput` doing exactly
   * what it should, not output overriding the user's scroll. The question item 5
   * actually asks is what happens to a scroll performed WHILE output arrives,
   * with no further typing, so the producer is started first and nothing is
   * typed afterwards.
   */
  test('a scrolled-back viewport stays parked while output arrives, and a selection made there survives', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateSelectionWorkspace(page, 1);
    const [session] = workspace.sessionIds;
    const topRow = async (): Promise<string | undefined> =>
      (await captureTerminalLines(page, session))?.[0]?.trim();
    try {
      await sendCommandAndWaitForMarker(
        page, session,
        `node -e "for(let i=1;i<=200;i++)console.log('SEED-'+i)"`,
        'SEED-200',
        { perAttemptTimeoutMs: 30_000 },
      );

      // ~120 lines over ~12 seconds, so output is still arriving for the whole
      // parked measurement and the shell is back at an idle prompt in time for
      // the bare-Enter measurement at the end. This is the last thing typed
      // until that Enter.
      await sendCommandPreservingSelection(
        page, session,
        `node -e "let i=0;const t=setInterval(()=>{console.log('SLOW-'+(++i));if(i>=120)clearInterval(t)},100)"`,
      );
      await expect.poll(topRow, {
        message: 'E2E precondition failed: the slow producer never reached the viewport',
        timeout: 30_000,
      }).toMatch(/^SLOW-\d+$/);

      await scrollTerminalUp(page, session, 10);

      const parked = await topRow();
      // The control that makes "still parked" mean something: the view must have
      // actually moved, out of the SLOW region and back into the SEED region. If
      // the scroll had done nothing, every assertion below would pass trivially.
      expect(
        parked,
        'the wheel scroll must move the viewport back into the pre-producer output; if it does not, '
        + '"still parked" below is vacuous',
      ).toMatch(/^SEED-\d+$/);

      // Select a line in the parked view. By dragging, not typing: MEASURED that
      // typing into the terminal clears the selection, so a selection made
      // before the producer was started would already be gone by now.
      await dragAcrossRow(page, await locateMarker(page, session, parked!));
      const selected = await captureSelection(page, session);
      expect(
        selected?.hasSelection,
        'E2E precondition failed: the drag in the parked view produced no selection',
      ).toBe(true);
      expect(selected?.text.trim()).toBe(parked);

      // Output keeps arriving for all of this.
      for (const waitMs of [1500, 3000, 5000]) {
        await page.waitForTimeout(waitMs);
        expect(
          await topRow(),
          `after ${waitMs}ms of further output the viewport left the row the user scrolled to; `
          + 'arriving output must not override a user scroll',
        ).toBe(parked);
        const held = await captureSelection(page, session);
        expect(held?.hasSelection, `the selection must survive ${waitMs}ms of arriving output`).toBe(true);
        expect(held?.text.trim(), 'the selection must still hold the same line').toBe(parked);
      }

      // ── The bare-Enter case ───────────────────────────────────────────────
      //
      // FR-BGSTAB-029's 2026-09-19 change note withdrew a proposed partial-trim
      // AC on the ground that "a selection here does not survive a single bare
      // Enter keypress at an empty prompt", so xterm's SelectionModel.handleTrim
      // partial-clamp path is unreachable in this app. That observation was made
      // before `captureTerminalSelection` existed, and the same day two helper
      // defects were found that destroy a selection for reasons unrelated to
      // what is being tested -- an unconditional click, and a drag that never
      // registers. So the withdrawal rests on an observation whose instrument
      // could not distinguish its own side effects from the product's behaviour.
      //
      // This settles it, with no click anywhere in the path. Everything above
      // establishes the preconditions the original observation lacked: the
      // selection is real (asserted through xterm's own model), output alone
      // does not clear it (three waits), and a wheel scroll does not clear it.
      // What is left is the Enter.
      await expect.poll(async () => {
        const first = await topRow();
        await page.waitForTimeout(1200);
        return (await topRow()) === first;
      }, {
        message: 'E2E precondition failed: the viewport never settled, so the shell cannot be '
          + 'assumed idle and this would measure an Enter sent to a running program',
        timeout: 45_000,
      }).toBe(true);

      const beforeEnter = await captureSelection(page, session);
      expect(
        beforeEnter?.hasSelection,
        'E2E precondition failed: the selection was already gone before the Enter, so this '
        + 'measurement would attribute to Enter something that had already happened',
      ).toBe(true);

      // Load-bearing: a click here would clear the selection by itself and the
      // reading would be worthless. The drag left the helper textarea focused,
      // so no click is needed -- asserted rather than assumed.
      const focusedWithoutClicking = await page.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
      });
      expect(
        focusedWithoutClicking,
        'E2E precondition failed: the terminal is not focused, so pressing Enter would need a '
        + 'click, and a click clears the selection on its own',
      ).toBe(true);

      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);

      // MEASURED 2026-09-19: a bare Enter DOES clear the selection, so the
      // change note's withdrawal reason holds and was not an artifact of the two
      // helper defects found the same day. Recorded as the measured value rather
      // than asserted as desirable -- if a future selection anchor model makes a
      // selection survive input, this is where that shows up, and the withdrawn
      // AC becomes reachable again.
      const afterEnter = await captureSelection(page, session);
      expect(
        afterEnter?.hasSelection,
        'a bare Enter at an idle prompt no longer clears the selection. That reopens the '
        + 'partial-trim AC withdrawn in FR-BGSTAB-029\'s 2026-09-19 change note, whose stated '
        + 'reason was that a selection never survives long enough to reach handleTrim\'s '
        + 'partial-clamp path.',
      ).toBe(false);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });
});

/** A real wheel scroll over the terminal, paced so xterm's viewport keeps up. */
async function scrollTerminalUp(page: Page, sessionId: string, notches: number): Promise<void> {
  const box = await page.locator(`[data-session-id="${sessionId}"] .xterm-screen`).boundingBox();
  if (!box) throw new Error(`E2E precondition failed: no screen box for session ${sessionId}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < notches; i += 1) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(30);
  }
}
