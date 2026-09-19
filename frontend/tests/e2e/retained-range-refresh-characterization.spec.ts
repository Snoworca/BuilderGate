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
 *
 * SUPPORTING READING ONLY — never the claim. See the note on content identity
 * below for why a length cannot carry this test.
 */
const RETAINED_RANGE_FLOOR = 200;

/**
 * Reads xterm's own per-line fingerprints. `logicalLineHash` is an fnv1a64 over
 * `{ isWrapped, text }` (src/utils/terminalRetainedState.ts), so a line that
 * survives a reload keeps its hash and a different line does not.
 */
async function readLineFingerprints(
  page: import('@playwright/test').Page,
  sessionId: string,
): Promise<{ index: number; logicalLineHash: string }[]> {
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
  return evidence.lineFingerprints.map(({ index, logicalLineHash }) => ({ index, logicalLineHash }));
}

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
      const length = await settledNormalLength(page, session);
      const fingerprints = await readLineFingerprints(page, session);
      // Content, not length. A length alone is satisfied by a terminal that
      // merely accumulated output, which is a live path here: measured
      // 2026-09-19, writing 100 lines into a session holding nothing grew the
      // buffer 28 -> 129 with nothing restored at all.
      expect(
        fingerprints.length,
        'the producer must leave identifiable retained lines before a reload, or the '
        + 'characterization below would record a loss that never had anything to lose',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
      expect(
        new Set(fingerprints.map(line => line.logicalLineHash)).size,
        'the retained lines must be distinguishable from each other, or an identity check after '
        + 'the reload could be satisfied by any line at all',
      ).toBeGreaterThan(RETAINED_RANGE_FLOOR);
      // Supporting reading.
      expect(length).toBeGreaterThan(RETAINED_RANGE_FLOOR);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });

  test('AC-3: the retained range survives a refresh', async ({ page }) => {
    // Expected to fail TODAY. Going green here means AC-3 was implemented; see
    // the header for what to do then.
    // REL-BGSTAB-007 AC-3, 2026-09-20: `test.fail()` removed in the same commit as the fix.
    // It asserted the behaviour AC-3 requires while that behaviour was absent, so the mark
    // was what kept a true statement from being an orphan red somebody deleted. The reload
    // snapshot now carries the retained range (SessionManager.serializeRetainedRestoreSnapshot),
    // so the assertion below is an ordinary contract rather than a characterization.
    //
    // The server half is verified -- the monolithic suite's subscribe/resubscribe test was
    // flipped from asserting the oldest marker ABSENT to asserting it present, and passes.
    // This browser half is unverified until the routed run: it additionally requires xterm to
    // render the delivered scrollback into its buffer, which no server-side test can show.
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
      const before = await readLineFingerprints(page, session);
      // The OLDEST retained line. A partial restore drops the far end of the
      // scrollback first, so this is the line a length-based check is least
      // likely to miss the loss of.
      const oldest = before[0];
      expect(oldest, 'no retained lines to fingerprint before the reload').toBeTruthy();

      await page.reload();
      await waitForTerminal(page);
      const afterReload = await settledNormalLength(page, session);
      const after = await readLineFingerprints(page, session);
      const survivors = new Set(after.map(line => line.logicalLineHash));
      const overlap = before.filter(line => survivors.has(line.logicalLineHash)).length;

      // The assertion states what AC-3 REQUIRES, not what happens, and it states
      // it as CONTENT IDENTITY rather than length.
      //
      // Length cannot carry this claim. `normalLength > 200` is satisfied by
      // restoring the right 700 lines, by restoring 700 lines of something else,
      // and by a terminal that simply accumulated new output before the reading
      // settled. That is the same conflation this investigation spent four rounds
      // untangling: 28 meant both "restored the viewport" and "restored nothing",
      // because a fresh xterm has exactly `rows` rows either way.
      expect(
        survivors.has(oldest.logicalLineHash),
        `REL-BGSTAB-007 AC-3 requires the retained range to survive a refresh without loss. `
        + `The oldest pre-reload logical line is not present afterwards. `
        + `overlap=${overlap}/${before.length}, length before=${beforeReload} after=${afterReload}. `
        + 'Length is reported as a supporting reading only; the claim is that THIS line survived.',
      ).toBe(true);
    } finally {
      await cleanupSelectionWorkspace(page.context(), workspace);
    }
  });
});
