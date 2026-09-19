import { expect } from '@playwright/test';
import { test } from './workspaceOwnershipFixture';
import { login, waitForTerminal } from './helpers';
import {
  activateSelectionWorkspace,
  cleanupSelectionWorkspace,
  sendCommandAndWaitForMarker,
} from './terminalSelectionFixture';

/**
 * REL-BGSTAB-007 AC-3 — "retained range restored across refresh without loss".
 *
 * THIS FILE RECORDS A DEFECT. IT IS NOT A CONTRACT.
 *
 * Measured 2026-09-19 against a live https://localhost:2222, 8 of 8 reloads:
 * after producing 700 lines the browser's normal buffer holds ~709 rows, and
 * after a reload it holds exactly 28 — the viewport. The scrollback is gone
 * every time, INCLUDING in the four runs that received an authoritative screen
 * snapshot, applied it and acked it. The full measurement is in
 * docs/analysis/2026-09-19.item6-buffer-bimodality.md.
 *
 * WHY test.fail() RATHER THAN A PLAIN RED. A red test in the suite is an orphan
 * red: it blocks, and the next person mid-feature reads it as obsolete and
 * deletes it. Marked `test.fail()`, the assertion below states the behaviour AC-3
 * REQUIRES, currently does not hold, and so the test "passes" today. The moment
 * someone implements AC-3 the assertion starts holding, Playwright reports
 * "expected to fail but passed", and the suite goes red — which is the signal we
 * actually want, because it means progress rather than breakage. Same pattern as
 * OBS-BGSTAB-009 and TC-7004.
 *
 * WHEN AC-3 IS IMPLEMENTED: replace this with the real contract test, and SCOPE
 * this record rather than deleting it — narrow it to whatever remains uncovered,
 * or retire it with a change note saying what replaced it. A deleted
 * characterization leaves no trace that the behaviour was ever measured, and the
 * next person re-derives it. That lesson came from TC-7004 today.
 *
 * AC-3 IS NOT CHECKED BY THIS FILE. A test recording a violation is not evidence
 * of satisfaction, and it must never be cited as AC-3 coverage.
 *
 * ── The structural hazard this file has to work around ──────────────────────
 *
 * Under `test.fail()` EVERY failure counts as the expected one, including a
 * broken precondition. A setup that silently stopped producing output would make
 * the characterization "pass" for entirely the wrong reason, and nothing would
 * say so. So the setup is asserted in a SEPARATE, ORDINARY test below: if the
 * producer or the fixture breaks, that test goes red and names the cause, while
 * this one cannot absorb it.
 */

const LINES = 700;
/**
 * A terminal that holds only its viewport reports `rows` rows. 200 is far above
 * any plausible viewport and far below the ~709 a full retained range gives, so
 * it separates the two without pinning either.
 */
const RETAINED_RANGE_FLOOR = 200;

async function readNormalLength(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<number> {
  const snapshot = await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureTerminalBufferLengths?.(id) ?? null,
    sessionId,
  );
  if (snapshot === null) {
    // Never fold an absent instrument into a number: a confident value for a
    // state that could not be observed is worse than no value.
    throw new Error(
      'captureTerminalBufferLengths is unavailable for this session — the instrument is absent, '
      + 'which is not the same as a short buffer',
    );
  }
  return snapshot.normalLength;
}

/** Samples until the reading stops moving, so nothing is read mid-change. */
async function settledNormalLength(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<number> {
  const seen: number[] = [];
  let stableFor = 0;
  for (let attempt = 0; attempt < 200 && stableFor < 6; attempt += 1) {
    const current = await readNormalLength(page, sessionId);
    seen.push(current);
    stableFor = seen.at(-2) === current ? stableFor + 1 : 0;
    await page.waitForTimeout(200);
  }
  return seen.at(-1) ?? -1;
}

test.describe('REL-BGSTAB-007 AC-3 retained range across refresh', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop refresh contract');
  });

  /**
   * The setup control. Ordinary test, not `test.fail()`, precisely so a broken
   * fixture cannot hide inside the characterization below.
   */
  test('setup control: the producer fills the retained range before any reload', async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateSelectionWorkspace(page, 1);
    const [session] = workspace.sessionIds;
    try {
      await sendCommandAndWaitForMarker(
        page, session,
        `node -e "for(let i=1;i<=${LINES};i++)console.log('RETAINED-'+i)"`,
        `RETAINED-${LINES}`,
        { perAttemptTimeoutMs: 60_000 },
      );
      expect(
        await settledNormalLength(page, session),
        'the producer must fill the retained range before a reload, or the characterization '
        + 'below would record a loss that never had anything to lose',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });

  test('AC-3: the retained range survives a refresh', async ({ page }) => {
    // Expected to fail TODAY. Going green here means AC-3 was implemented; see
    // the header for what to do then.
    test.fail();
    test.setTimeout(180_000);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateSelectionWorkspace(page, 1);
    const [session] = workspace.sessionIds;
    try {
      await sendCommandAndWaitForMarker(
        page, session,
        `node -e "for(let i=1;i<=${LINES};i++)console.log('RETAINED-'+i)"`,
        `RETAINED-${LINES}`,
        { perAttemptTimeoutMs: 60_000 },
      );
      const beforeReload = await settledNormalLength(page, session);

      await page.reload();
      await waitForTerminal(page);
      const afterReload = await settledNormalLength(page, session);

      // The assertion states what AC-3 REQUIRES, not what happens. Measured
      // 2026-09-19: afterReload is 28 on 8 of 8, so this fails and `test.fail()`
      // turns that into a pass. When it stops failing, the suite says so.
      expect(
        afterReload,
        `REL-BGSTAB-007 AC-3 requires the retained range to survive a refresh without loss. `
        + `Measured before=${beforeReload} after=${afterReload}. A value equal to the viewport `
        + 'height means the scrollback was not restored by any path.',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });
});
