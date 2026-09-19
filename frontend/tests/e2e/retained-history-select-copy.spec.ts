import { expect, type Page } from '@playwright/test';
import { test } from './workspaceOwnershipFixture';
import { login, openTerminalContextMenu, waitForTerminal, waitForTerminalInputReady } from './helpers';
import {
  activateSelectionWorkspace,
  captureSelection,
  captureTerminalLines,
  cleanupSelectionWorkspace,
  dragAcrossRow,
  focusTerminalHost,
  locateMarker,
  sendCommandAndWaitForMarker,
  terminalScope,
  type SelectionWorkspaceContext,
} from './terminalSelectionFixture';

/**
 * GitHub issue #16 completion criterion 6 — after a hard reload, an OLD logical
 * line from the authoritative retained history must be scrollable, selectable
 * and copyable, and its content AND Unicode cell identity must match what was
 * there before the refresh.
 *
 * What is already covered elsewhere, and why that is not this:
 *
 *   - `retained-range-refresh-characterization.spec.ts` (REL-BGSTAB-007 AC-3)
 *     asserts that the oldest pre-reload line's `logicalLineHash` is present
 *     afterwards. That hash is fnv1a64 over `{ isWrapped, text }`
 *     (src/utils/terminalRetainedState.ts) — it is CONTENT identity only. Two
 *     terminals that agree on the text but disagree on how many cells a wide
 *     CJK character or a combining mark occupies produce the SAME
 *     `logicalLineHash`, which is precisely the divergence issue #16 symptom 1
 *     is about. This file therefore additionally pins
 *     `cellContentAttributeHash`, which is fnv1a64 over the per-cell
 *     `{ chars, code, width, ...attributes }` array, and it produces lines that
 *     actually contain a wide CJK run, a combining mark and an emoji so that
 *     the width field carries information rather than being 1 everywhere.
 *
 *   - `terminal-selection-eviction.spec.ts` AC-5 asserts the NEGATIVE half of
 *     the refresh boundary: a pre-refresh selection must be gone and must not
 *     copy. That is criterion 7. Criterion 6 is the positive half — the old
 *     line must still be REACHABLE for a fresh selection made after the reload.
 *     Neither implies the other: an app that restores nothing at all passes
 *     criterion 7 and fails this one.
 *
 * Structural note, the same one this lane keeps re-learning: the setup is
 * asserted in its own ORDINARY test below. If the producer or the fixture
 * breaks, that test goes red and names the cause, instead of the contract test
 * absorbing it and reporting a loss that never had anything to lose.
 *
 * MEASURED 2026-09-20 against a live https://localhost:2222 built from this
 * worktree: the retained range restore is INTERMITTENT. Running
 * `retained-range-refresh-characterization.spec.ts`'s AC-3 test four times gave
 * 3 pass / 1 fail, and the failing run reported `overlap=1/707, length
 * before=707 after=28` — the browser came back holding only its viewport. So a
 * red here may be that intermittency rather than a select/copy defect; the
 * assertion messages below separate the two by stating which step failed.
 */

/** Wide CJK + a combining mark + an emoji, so cell `width` is not uniformly 1. */
const UNICODE_RUN = '가나다-é-\u{1F642}';
const LINES = 300;
/** Far above any plausible viewport, far below the ~LINES a restored range gives. */
const RETAINED_RANGE_FLOOR = 100;

function markerFor(index: number): string {
  return `RH-${index}-${UNICODE_RUN}`;
}

function copyMenuItem(page: Page) {
  return page.locator('.context-menu-item').filter({ hasText: '복사' }).first();
}

async function installMemoryClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & { __e2eClipboardText?: string };
    state.__e2eClipboardText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => state.__e2eClipboardText ?? '',
        writeText: async (text: string) => { state.__e2eClipboardText = text; },
      },
    });
  });
}

interface LineFingerprint {
  index: number;
  logicalLineHash: string;
  cellContentAttributeHash: string;
}

/**
 * Both hashes, not just the logical one. `cellContentAttributeHash` is what
 * carries per-cell `width`, which is the Unicode cell identity criterion 6
 * names. Throws rather than returning a number when the instrument is absent:
 * a confident reading for a state that could not be observed is worse than
 * none.
 */
async function readLineFingerprints(page: Page, sessionId: string): Promise<LineFingerprint[]> {
  const evidence = await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureRetainedState?.(id) ?? null,
    sessionId,
  );
  if (evidence === null) {
    throw new Error(
      'captureRetainedState is unavailable for this session — the instrument is absent, which is '
      + 'not the same as an empty retained range',
    );
  }
  return evidence.lineFingerprints.map(({ index, logicalLineHash, cellContentAttributeHash }) => ({
    index, logicalLineHash, cellContentAttributeHash,
  }));
}

/**
 * Samples until the reading stops moving.
 *
 * ONLY SAFE BEFORE THE RELOAD. Its old docstring said "so nothing is read
 * mid-restore", and that was false: an unchanging reading means "settled" only
 * once something has started. See waitForRestoredFingerprints below.
 */
async function settledFingerprints(page: Page, sessionId: string): Promise<LineFingerprint[]> {
  let previous = -1;
  let stableFor = 0;
  let latest: LineFingerprint[] = [];
  for (let attempt = 0; attempt < 200 && stableFor < 6; attempt += 1) {
    latest = await readLineFingerprints(page, sessionId);
    stableFor = latest.length === previous ? stableFor + 1 : 0;
    previous = latest.length;
    await page.waitForTimeout(200);
  }
  return latest;
}

/**
 * Waits for the reload's restore to LAND, rather than for the row count to stop
 * moving.
 *
 * THIS SPEC WAS PASSING ON A ~100ms MARGIN. Measured 2026-09-20 on a7a15c9b
 * against a live https://localhost:2222, this spec's own restore (LINES = 300)
 * completes at 1536 / 1440 / 1533 ms. The `settledFingerprints` window it used
 * to depend on is ~1.4s — six unchanging 200ms samples. So the restore was
 * landing roughly a hundred milliseconds AFTER the window it was racing.
 *
 * That single number explains both observations at once: why criterion 6 was
 * observed passing (9/9 on 2026-09-20), and why it could not have kept passing.
 * "Latent" here does not mean "might fail someday under unspecified
 * conditions" — it means ANY change that adds ~100ms to the restore, or removes
 * ~100ms from the window, flips this spec red for a reason that has nothing to
 * do with criterion 6. Do not read the fix as speculative and revert it; the
 * margin is measured, on this spec, not inferred from another one.
 *
 * WHY THE OLD POLL COULD NOT SEE IT. `settledFingerprints` returns after ~1.4s
 * of an unchanging LENGTH and starts as soon as the terminal is readable. A
 * fresh xterm holds exactly `rows` rows, so six identical readings of `rows`
 * satisfy "settled" while the restore is still in flight — the poll cannot tell
 * "finished" from "has not started".
 *
 * The identical defect was measured and fixed in
 * retained-range-refresh-characterization.spec.ts (d3461466), where the same
 * poll produced confident wrong readings of exactly `rows`. That spec's
 * producer is larger and its restore takes 6524/9016/6161/6179 ms — far outside
 * the window rather than just past it, which is why it failed outright there and
 * merely sat on the margin here.
 *
 * NOT A SIZE CLAIM. The two specs differ in producer size AND content shape AND
 * assertions, n=3 against n=4, uninterleaved, so line count is not isolated. All
 * that is supported is that the restore latency is not a single constant and the
 * two measured populations do not overlap. Anyone chasing this should vary size
 * deliberately rather than read these two numbers as a trend.
 *
 * ITS EXPOSURE HERE IS A FALSE RED, NOT A FALSE GREEN. An early read yields a
 * viewport-sized buffer, `contentSurvivor` comes back undefined and the
 * assertion fails — so this was a live generator of red criterion-6 runs that
 * look like a product regression and are not. That is why this is worth fixing
 * rather than tolerating.
 *
 * THIS CANNOT MANUFACTURE A PASS. It polls for exactly the line the assertion is
 * about, and on timeout it returns the last reading anyway and lets the
 * assertion fail with the same message and the same overlap/row reporting it
 * always had. A restore that genuinely never arrives is still a failure.
 */
async function waitForRestoredFingerprints(
  page: Page,
  sessionId: string,
  oldestLogicalLineHash: string,
  timeoutMs = 60_000,
): Promise<LineFingerprint[]> {
  const startedAt = Date.now();
  let latest = await readLineFingerprints(page, sessionId);
  while (
    !latest.some(line => line.logicalLineHash === oldestLogicalLineHash)
    && Date.now() - startedAt < timeoutMs
  ) {
    await page.waitForTimeout(200);
    latest = await readLineFingerprints(page, sessionId);
  }
  // Diagnostic, never a gate. Criterion 6 has no latency clause, but the restore
  // is bimodal (~60ms or seconds) and a green run should not hide which it took.
  // eslint-disable-next-line no-console
  console.log(`[item 6] restore observed after ${Date.now() - startedAt}ms`);
  return latest;
}

/**
 * Scrolls the viewport up until `marker` is one of the visible rows. This is
 * the "scroll" half of criterion 6 — the line has to be REACHABLE, not merely
 * present in a buffer that nothing can navigate to.
 */
async function scrollUpToMarker(page: Page, sessionId: string, marker: string): Promise<void> {
  const screen = terminalScope(page, sessionId).locator('.xterm-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error(`terminal screen for session "${sessionId}" has no bounding box`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const lines = await captureTerminalLines(page, sessionId);
    if (lines === null) throw new Error('captureTerminalText is unavailable for this session');
    if (lines.some(line => line.trim() === marker)) return;
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(60);
  }
  throw new Error(
    `issue #16 item 6: "${marker}" was never reachable by scrolling after the reload — the old `
    + 'logical line is either absent from the restored history or cannot be scrolled to',
  );
}

async function produceHistory(page: Page, sessionId: string): Promise<void> {
  await sendCommandAndWaitForMarker(
    page, sessionId,
    `node -e "for(let i=1;i<=${LINES};i++)console.log('RH-'+i+'-${UNICODE_RUN}')"`,
    markerFor(LINES),
    { perAttemptTimeoutMs: 60_000 },
  );
}

test.describe('issue #16 item 6 — old retained lines stay selectable across a hard reload', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop refresh contract');
  });

  /**
   * ORDINARY test, deliberately separate: it is what keeps the contract test
   * below from passing or failing for a reason that has nothing to do with the
   * refresh boundary.
   */
  test('setup control: the producer leaves distinguishable Unicode-bearing lines before any reload', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    await waitForTerminal(page);
    const workspace: SelectionWorkspaceContext = await activateSelectionWorkspace(page, 1);
    const [session] = workspace.sessionIds;
    try {
      await produceHistory(page, session);
      const fingerprints = await settledFingerprints(page, session);

      expect(
        fingerprints.length,
        'the producer must leave retained lines before a reload, or the contract test below '
        + 'would record a loss that never had anything to lose',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
      expect(
        new Set(fingerprints.map(line => line.logicalLineHash)).size,
        'the retained lines must be distinguishable from each other, or an identity check after '
        + 'the reload could be satisfied by any line at all',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
      expect(
        new Set(fingerprints.map(line => line.cellContentAttributeHash)).size,
        'the CELL hashes must also be distinguishable — if they all collapse to one value the '
        + 'cell-identity assertion below is satisfied by any line and measures nothing',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);

      // The oldest line must be scrollable-to BEFORE any reload as well.
      // Without this, a post-reload scroll failure cannot be told apart from
      // "this app never lets you scroll back to that line at all".
      await scrollUpToMarker(page, session, markerFor(1));
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });

  test('item 6: an old logical line survives a hard reload with cell identity intact, and can be scrolled to, selected and copied', async ({ page }) => {
    test.setTimeout(240_000);
    await installMemoryClipboard(page);
    await login(page);
    await waitForTerminal(page);
    const workspace: SelectionWorkspaceContext = await activateSelectionWorkspace(page, 1);
    const [session] = workspace.sessionIds;
    const marker = markerFor(1);
    try {
      await produceHistory(page, session);
      const before = await settledFingerprints(page, session);
      // NON-VACUITY FLOOR, asserted HERE and not only in the 'setup control'
      // test above. That control runs on a different page and a different
      // workspace, so it cannot vouch for this run. Without this line the
      // cell-identity half below can silently degrade into a claim about a
      // single viewport line -- the cheapest thing that satisfies
      // "the oldest line survived" is a buffer that never grew past the
      // viewport at all, in which case nothing was retained and nothing was
      // tested. Measured: the repo has been bitten by this shape three times
      // (normalLength > floor satisfied by new output with nothing restored;
      // hasSelection() true while getSelection() was empty; overlap > 0
      // satisfied by one coincidentally identical blank line).
      expect(
        before.length,
        'issue #16 item 6: this contract test needs a genuinely RETAINED range of its own before '
        + 'the reload. Below the floor the surviving-line assertion could be satisfied by a '
        + 'viewport line, so it would pass while measuring nothing.',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
      // The oldest retained line. A partial restore drops the far end of the
      // scrollback first, so this is the one a length-based check is least
      // likely to miss the loss of.
      const oldest = before[0];
      expect(oldest, 'no retained lines to fingerprint before the reload').toBeTruthy();

      await page.reload();
      await waitForTerminal(page);
      await waitForTerminalInputReady(page);
      await expect
        .poll(async () => (await captureTerminalLines(page, session)) !== null, { timeout: 30_000 })
        .toBe(true);

      const after = await waitForRestoredFingerprints(page, session, oldest.logicalLineHash);
      const contentSurvivor = after.find(line => line.logicalLineHash === oldest.logicalLineHash);
      const overlap = before.filter(
        b => after.some(a => a.logicalLineHash === b.logicalLineHash),
      ).length;

      expect(
        contentSurvivor,
        'issue #16 item 6 requires the authoritative retained history to survive a hard reload. '
        + `The oldest pre-reload logical line is absent afterwards. overlap=${overlap}/${before.length}, `
        + `rows before=${before.length} after=${after.length}.`,
      ).toBeTruthy();

      // The discriminating claim. Content identity alone is satisfied by a
      // restore that agrees on the text and disagrees on the cells — exactly
      // the server/browser width divergence issue #16 symptom 1 describes.
      expect(
        contentSurvivor!.cellContentAttributeHash,
        'issue #16 item 6 requires Unicode CELL identity, not just text. The restored line has the '
        + 'same text but a different per-cell {chars, width, attributes} array than before the '
        + 'reload, which is what a width-table disagreement between the server and the browser '
        + 'looks like on a line carrying wide CJK, a combining mark and an emoji.',
      ).toBe(oldest.cellContentAttributeHash);

      // Scroll · select · copy, the three verbs criterion 6 names.
      await scrollUpToMarker(page, session, marker);
      await dragAcrossRow(page, await locateMarker(page, session, marker));
      await focusTerminalHost(page, session);
      await expect.poll(
        async () => (await captureSelection(page, session))?.hasSelection ?? false,
        {
          message: 'issue #16 item 6: dragging across the restored old line produced no selection '
            + "according to xterm's own model",
          timeout: 10_000,
        },
      ).toBe(true);

      await openTerminalContextMenu(page);
      await expect(
        copyMenuItem(page),
        'issue #16 item 6: a fresh selection on a restored old line must leave copy enabled',
      ).not.toHaveClass(/disabled/);
      await copyMenuItem(page).click();

      await expect
        .poll(async () => page.evaluate(() => (window as typeof window & {
          __e2eClipboardText?: string;
        }).__e2eClipboardText ?? ''), { timeout: 10_000 })
        .toContain(marker);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });
});
