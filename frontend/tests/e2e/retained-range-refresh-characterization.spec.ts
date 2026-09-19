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
 * THIS FILE IS A CONTRACT. It was a `test.fail()` characterization until
 * 2026-09-20; the history below is kept rather than rewritten, because the
 * measurement it records is real and only its INTERPRETATION was wrong.
 *
 * ── What was recorded here, and what it actually was ────────────────────────
 *
 * Measured 2026-09-19: 8 of 8 reloads left the browser's normal buffer at
 * exactly 28 rows after a 700-line producer, and that was read as "the
 * scrollback is gone every time". It was not. The reading was EARLY.
 *
 * `settledNormalLength` returns after ~1.4s of an unchanging reading, and it
 * starts the moment `waitForTerminal` resolves — and `waitForTerminal` only
 * waits for `.xterm-screen:visible` (helpers.ts), which says nothing about the
 * session being subscribed or restored. A fresh xterm holds exactly `rows`
 * rows, so six identical readings of 28 satisfy "settled" while the restore is
 * still in flight. The poll could not tell "finished" from "has not started".
 *
 * Measured 2026-09-20 on a7a15c9b, server and frontend both built from that
 * commit, 700 lines, retries=0:
 *   - the old spec: 3 of 4 reloads "lost" the range, overlap=1/707, after=28
 *   - a probe doing identical work but reading again 15s later: lateLength=707
 *     and overlap=707/707 on EVERY such run — the complete range, oldest line
 *     included, restored in full on exactly the runs called a loss
 *   - the same probe with a fixed 8s wait instead of the settle poll: 4/4
 * Changing only the wait strategy moved the outcome from 1/4 to 4/4. Nothing
 * was ever lost. The earlier docs/analysis/2026-09-19.item6-buffer-bimodality.md
 * measurement stands as data; its conclusion is superseded by this note.
 *
 * So the assertion below is now an ordinary contract, and the settling after a
 * reload waits for an observable end state (`waitForRestoredLine`) rather than
 * for a reading to stop moving. DO NOT put a stability poll back. This is the
 * second time this exact instrument failure has been recorded in this repo.
 *
 * ── Two structural hazards this file still works around ─────────────────────
 *
 * 1. The setup is asserted in a SEPARATE, ORDINARY test below. It predates the
 *    removal of `test.fail()` (under which every failure, including a broken
 *    precondition, counted as the expected one) and it is kept because it still
 *    earns its place: if the producer or fixture breaks, that test goes red and
 *    names the cause instead of this one absorbing it.
 * 2. The claim is CONTENT IDENTITY, not length. A length is satisfied by
 *    restoring the right 700 lines, by restoring 700 of something else, and by
 *    a terminal that merely accumulated new output.
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

/**
 * Samples until the reading stops moving, so nothing is read mid-change.
 *
 * ONLY SAFE BEFORE THE RELOAD. A stalled reading means "settled" only when
 * something has already started; see waitForRestoredLine for why that does not
 * hold after a reload.
 */
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

/**
 * Waits for the reload's restore to LAND, rather than for the buffer to stop
 * moving.
 *
 * WHY NOT settledNormalLength HERE. It returns after ~1.4s of an unchanging
 * reading and it starts the moment `waitForTerminal` resolves -- and
 * `waitForTerminal` only waits for `.xterm-screen:visible` (helpers.ts), which
 * says nothing about the session being subscribed or restored. So after a reload
 * the poll begins before the restore has been requested, finds a fresh xterm
 * sitting at exactly `rows`, and six identical readings of 28 satisfy "settled".
 * The poll cannot tell "finished" from "has not started" and reports 28 with full
 * confidence either way.
 *
 * Measured 2026-09-20 on a7a15c9b, 700 lines, server and frontend both built from
 * that commit: the characterization failed 3 of 4 reloads with overlap=1/707 and
 * after=28. A probe running the identical work but reading again 15s later found
 * lateLength=707 and overlap=707/707 on EVERY such run -- the complete range,
 * oldest line included. The same probe with a fixed 8s wait in place of this poll
 * passed 4/4. The reading was early; nothing was ever lost. On passing runs the
 * whole subscribe+restore lands ~60ms after mount; on the others it lands well
 * after the settle window -- measured restore times here are 6.2-9.0s.
 *
 * NOT CLAIMED: that this depends on producer size. 300 lines passing 4 times was
 * read as immunity, but if the true rate were ~1/3 then four consecutive passes
 * has probability (2/3)^4 = 0.20, which is unremarkable for a spec that is
 * equally exposed. Separating 33% from 0% needs a denominator nobody has run.
 * Size is UNEXCLUDED BUT UNSUPPORTED; do not repeat it as a finding.
 *
 * This is the same instrument failure the repository already recorded for this
 * measurement ("안정화 폴링이 '안정됨' 과 '시작도 안 함' 을 구별하지 못했다"). It came back
 * because the helper was rewritten, not because the lesson was wrong. Do not
 * replace this with a stability poll again.
 *
 * THIS CANNOT MANUFACTURE A PASS. It polls for exactly the identity the assertion
 * claims, and on timeout it returns anyway and lets that assertion fail with the
 * same message it always had. A restore that never arrives is still a failure.
 */
async function waitForRestoredLine(
  page: import('@playwright/test').Page,
  sessionId: string,
  oldestLogicalLineHash: string,
  timeoutMs = 60_000,
): Promise<{
  fingerprints: { index: number; logicalLineHash: string }[];
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  let fingerprints = await readLineFingerprints(page, sessionId);
  while (
    !fingerprints.some(line => line.logicalLineHash === oldestLogicalLineHash)
    && Date.now() - startedAt < timeoutMs
  ) {
    await page.waitForTimeout(200);
    fingerprints = await readLineFingerprints(page, sessionId);
  }
  return { fingerprints, elapsedMs: Date.now() - startedAt };
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
    // REL-BGSTAB-007 AC-3, 2026-09-20: `test.fail()` removed in the same commit as the fix.
    // It asserted the behaviour AC-3 requires while that behaviour was absent, so the mark
    // was what kept a true statement from being an orphan red somebody deleted. The reload
    // snapshot now carries the retained range (SessionManager.serializeRetainedRestoreSnapshot),
    // so the assertion below is an ordinary contract rather than a characterization.
    //
    // The server half is verified -- the monolithic suite's subscribe/resubscribe test was
    // flipped from asserting the oldest marker ABSENT to asserting it present, and passes.
    // The browser half is now verified too: with the settling fixed, this passes against a
    // live https://localhost:2222 and the restore is observed with every line present,
    // which is what shows xterm rendered the delivered scrollback into its buffer.
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
      const restored = await waitForRestoredLine(page, session, oldest.logicalLineHash);
      const after = restored.fingerprints;
      const afterReload = await readNormalLength(page, session);
      const survivors = new Set(after.map(line => line.logicalLineHash));
      // Diagnostic, never a gate. AC-3 has no latency clause, but the restore is
      // bimodal (~60ms or seconds) and a green test should not hide which mode
      // this run took.
      // eslint-disable-next-line no-console
      console.log(`[AC-3] restore observed after ${restored.elapsedMs}ms`);
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
