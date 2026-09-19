import { expect, type Page } from '@playwright/test';
import { test, deleteOwnedWorkspaceForContext } from './workspaceOwnershipFixture';
import { login, openTerminalContextMenu, waitForTerminal, waitForTerminalInputReady } from './helpers';

/**
 * FR-BGSTAB-029 (GitHub issue #16) selection-eviction regressions.
 *
 * AC-3 ("fully evicted selection is invalidated") was previously checked only on a
 * hand-run live-browser measurement (VE-2/VE-5) with no re-runnable artifact -- an
 * independent review correctly called that CRITICAL and reverted it to unchecked.
 * The first test below is the Playwright spec VE-5 named as the closing bar: a real
 * mouse drag selects a line, output floods past it, and the copy path must become
 * unavailable -- with a live-selection control so a spec that always reports
 * "disabled" cannot pass vacuously.
 *
 * The second test covers a DIFFERENT, newly discovered defect in the same family,
 * found by reading xterm's own `SelectionModel.handleTrim` directly: when only the
 * TOP of a multi-line selection scrolls off (selectionStart clamped to 0) while the
 * BOTTOM survives (selectionEnd stays >= 0), xterm does not clear the selection at
 * all -- it silently keeps reporting a "selection" whose start no longer means what
 * it did when the user made it. The discriminating assertion is not "is copy
 * disabled" (it copies happily) but "does the copied text still start at the line
 * the user actually selected" -- a selection clamped to buffer row 0 copies content
 * that never included the marker the user dragged from.
 *
 * Every terminal interaction below is scoped to this test's own session id
 * (`[data-session-id]`, set by TerminalRuntimeLayer.tsx). Row text is read through
 * `window.__buildergateTerminalDebug.captureTerminalText(sessionId)` rather than a
 * `.xterm-rows` DOM locator -- since #15 attached `@xterm/addon-webgl`, the terminal
 * draws to canvas and `.xterm-rows` matches nothing at all (`busy-agent-workspace-
 * bounce.spec.ts`'s `readVisibleTerminalText` documents the same fact). The debug
 * hook returns exactly `term.rows` lines mapped to the current viewport
 * (`buffer.viewportY + row` per line, `TerminalView.tsx`'s text-capture handler), so
 * a marker's array index doubles as its on-screen row index for computing the pixel
 * position a real mouse drag needs -- renderer-agnostic, and it exercises the actual
 * WebGL path production uses rather than forcing a different renderer for the test.
 *
 * A 2026-09-19 run of an earlier draft that used `.xterm-rows` also surfaced a second,
 * independent bug worth keeping in mind: `sendVisibleTerminalCommand` used to resolve
 * "the first visible terminal" by DOM order, which during a workspace switch could
 * transiently be an outgoing session's terminal rather than the one this spec just
 * created. That helper now takes `{ sessionId }` and every call below passes it.
 *
 * Three more things measured 2026-09-19, unparking this spec once `captureTerminalSelection`
 * (the debug hook this file's earlier draft was blocked on) went live, all found by
 * distrusting a conclusion drawn from the DOM and re-checking it against xterm's own model:
 *
 *   1. A `page.mouse.move(x, y, { steps: N })` drag does not add real wall-clock delay
 *      between the events it dispatches, and left `term.hasSelection()` false every time --
 *      not "no visible DOM trace of a selection" (which the WebGL renderer would produce
 *      either way), a real absence confirmed by the hook. Moving in a loop with a small
 *      `waitForTimeout` between steps (`dragAcrossRow`) fixed it; see also `focusTerminalHost`
 *      -- the earlier "no selection" conclusion in this file's history was drawn before this
 *      hook existed and cannot be trusted either way.
 *   2. `focusTerminalHost`'s and `sendVisibleTerminalCommand`'s `screen.click()` clears
 *      whatever selection currently exists as a side effect (an unrelated mousedown+mouseup
 *      reads as "place the cursor here" to xterm's `SelectionService`), which made every
 *      later flood command in this file destroy the selection it was supposed to be testing
 *      the eviction of, for a reason that had nothing to do with the flood's OUTPUT. Both
 *      are fixed here to skip the click when the terminal is already correctly focused.
 *   3. A selection anchored to a row is cleared once that row scrolls off the CURRENTLY
 *      VISIBLE viewport, independent of how much scrollback capacity remains --
 *      `resourceLimits.terminal.scrollbackLines` (10000) does not govern this. A diagnostic
 *      script lost a single-row selection after as few as 50 lines of new output. The second
 *      test below no longer tries to put its two markers scrollback-distances apart with a
 *      flood in between (that killed the selection before it could ever become two-ended);
 *      it drags across both markers in one motion while both are on screen, then floods by
 *      an amount bounded strictly between their two row indices so the drag's start scrolls
 *      off while its end does not.
 */

interface EvictionWorkspaceContext {
  workspaceId: string;
  tabId: string;
  sessionId: string;
}

const RED_SIGNATURES = {
  fullEviction: 'FR-BGSTAB-029 AC-3: a fully evicted selection must disable the copy menu item',
  partialTrim:
    'FR-BGSTAB-029 new AC: a selection trimmed at the top but surviving at the bottom must not '
    + 'silently copy content that no longer includes the originally selected top line',
} as const;

test.describe('FR-BGSTAB-029 terminal selection eviction', () => {
  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop selection contract');
  });

  test('AC-3: full eviction disables copy; a live selection still copies (control)', async ({ page }) => {
    test.setTimeout(120_000);
    await installMemoryClipboard(page);
    await login(page);
    await waitForTerminal(page);
    const workspace = await activateEvictionWorkspace(page);
    const sid = workspace.sessionId;

    try {
      const marker = `MARKER-LINE-${Date.now()}`;
      await createSingleLineSelection(page, sid, marker);

      await floodLines(page, sid, 2_000, 'FLOOD');

      await openTerminalContextMenu(page);
      await expect(copyMenuItem(page), RED_SIGNATURES.fullEviction).toHaveClass(/disabled/);
      await page.keyboard.press('Escape');

      // Control: a fresh selection on a still-live line must re-enable copy. Without
      // this, a coordinator bug that always reports "disabled" would pass vacuously.
      const controlMarker = `MARKER-CONTROL-${Date.now()}`;
      await createSingleLineSelection(page, sid, controlMarker);
      await openTerminalContextMenu(page);
      await expect(
        copyMenuItem(page),
        'control: a fresh selection on a surviving line must leave copy enabled',
      ).not.toHaveClass(/disabled/);
      await page.keyboard.press('Escape');
    } finally {
      await cleanupEvictionWorkspace(page, workspace);
    }
  });

  // #16 item 2, second half -- PARKED, not proven reachable. Measured 2026-09-19, after this
  // test's own precondition steps (drag-select spanning both markers, confirmed via
  // captureTerminalSelection) started passing: the theorized bug -- xterm's
  // SelectionModel.handleTrim clamping selectionStart to buffer row 0 while selectionEnd
  // stays live, reported by hasSelection()/getSelection() as a silently-wrong selection --
  // is not reachable in this app as it stands, because something clears the selection
  // OUTRIGHT (hasSelection() false, not "shifted") on essentially any subsequent output, well
  // before any scrollback-position nuance could matter. Isolated with three measurements, in
  // increasing order of how little it takes: (1) a precisely bounded flood sized strictly
  // between the two markers' row indices (this test's own approach, tuned twice) still
  // produced a full clear every time; (2) a single-row selection was lost after as few as 50
  // lines of unrelated output, nowhere near the configured 10000-line browser scrollback;
  // (3) a selection was cleared by one bare Enter keypress producing a single new prompt
  // line, with no scrolling and no scrollback pressure of any kind. This traces to something
  // in this app clearing the selection on essentially any output, not to xterm's own
  // scrollback-trim logic, which this test's setup could never reach as a result. Left as
  // `fixme` rather than deleted or forced green: the setup (real drag, multi-row, verified via
  // the debug hook before asserting anything about eviction) is sound and worth keeping if the
  // premise turns out to be reachable some other way; the assertions below encode what the
  // ORIGINAL theorized bug predicts, not what was measured.
  test.fixme(
    'new AC: a selection trimmed at the top but surviving at the bottom must not silently point at the wrong lines',
    async ({ page }) => {
      test.setTimeout(180_000);
      await installMemoryClipboard(page);
      await login(page);
      await waitForTerminal(page);
      const workspace = await activateEvictionWorkspace(page);
      const sid = workspace.sessionId;

      try {
        const topMarker = `TOP-MARKER-${Date.now()}`;
        const bottomMarker = `BOTTOM-MARKER-${Date.now()}`;

        // Measured 2026-09-19: a selection anchored to a row is cleared as soon as that row
        // scrolls off the CURRENTLY VISIBLE screen -- a diagnostic script found a single-row
        // selection gone after as little as 50 lines of new output, regardless of the
        // configured browser scrollback (resourceLimits.terminal.scrollbackLines = 10000,
        // server/config.json5, is not what governs this). So the two markers cannot be
        // established thousands of lines apart with a flood in between; they must both be
        // on screen AT ONCE when the selection is made, one drag spanning both rows, and the
        // later flood must be small and precisely bounded: enough to push topMarker's row
        // past the top of the viewport, but not enough to also push bottomMarker's row past
        // it.
        await sendCommandAndWaitForMarker(page, sid, `echo ${topMarker}`, topMarker);
        // A small filler gap so the later flood has room to land strictly between the two
        // rows -- back-to-back echoes leave only 2-3 rows of natural separation (the command
        // echo plus its output), too narrow a window once the flood command's own echo line
        // is accounted for.
        await floodLines(page, sid, 15, 'GAP');
        await sendCommandAndWaitForMarker(page, sid, `echo ${bottomMarker}`, bottomMarker);

        // Both row indices read from the SAME viewport snapshot, so they are directly
        // comparable -- reading them separately (one snapshot per marker) would let an
        // intervening scroll shift one relative to the other.
        const lines = await captureTerminalLines(page, sid);
        if (lines === null) {
          throw new Error('E2E precondition failed: captureTerminalText debug hook is unavailable');
        }
        const topRowIndex = lines.findIndex(line => line.trim() === topMarker);
        const bottomRowIndex = lines.findIndex(line => line.trim() === bottomMarker);
        if (topRowIndex === -1 || bottomRowIndex === -1) {
          throw new Error(
            `E2E precondition failed: markers not both found in one viewport snapshot `
            + `(topRowIndex=${topRowIndex}, bottomRowIndex=${bottomRowIndex}, lines=${JSON.stringify(lines)})`,
          );
        }
        expect(
          bottomRowIndex,
          'E2E precondition failed: bottomMarker must be strictly below topMarker in the same '
          + `viewport snapshot (topRowIndex=${topRowIndex}, bottomRowIndex=${bottomRowIndex})`,
        ).toBeGreaterThan(topRowIndex);

        // One drag spanning both rows -- both markers are simultaneously visible right now,
        // so this does not need the separate shift+click extension a scrollback-spanning
        // selection would.
        const screen = terminalScope(page, sid).locator('.xterm-screen');
        const box = await screen.boundingBox();
        if (!box) throw new Error('E2E precondition failed: terminal screen has no bounding box');
        const rowHeight = box.height / lines.length;
        const topPosition: MarkerPosition = { x: box.x, y: box.y + (topRowIndex + 0.5) * rowHeight, width: box.width };
        const bottomPosition: MarkerPosition = { x: box.x, y: box.y + (bottomRowIndex + 0.5) * rowHeight, width: box.width };
        await dragAcrossRow(page, { x: topPosition.x, y: topPosition.y, width: topPosition.width }, bottomPosition.y);
        await focusTerminalHost(page, sid);

        // Assert the selection exists and spans both markers -- via xterm's own model,
        // before the flood that is about to trim it -- rather than assuming the drag worked.
        // This is the "before" half of the discriminating comparison: what the user actually
        // selected, captured with the one instrument that can see it under WebGL, kept for
        // comparison against what Ctrl+C actually produces below.
        const beforeTrim = await captureSelection(page, sid);
        expect(
          beforeTrim?.hasSelection,
          'E2E precondition failed: the drag across both markers did not leave a selection '
          + `according to xterm's own model. Captured: ${JSON.stringify(beforeTrim)}`,
        ).toBe(true);
        expect(
          beforeTrim?.text,
          'E2E precondition failed: the selection does not span both markers -- '
          + `expected it to contain both "${topMarker}" and "${bottomMarker}". Captured: `
          + `${JSON.stringify(beforeTrim?.text)}`,
        ).toEqual(expect.stringContaining(topMarker));
        expect(beforeTrim?.text).toEqual(expect.stringContaining(bottomMarker));
        const originallySelectedText = beforeTrim!.text;

        // Push topMarker's row past the top of the viewport while keeping bottomMarker's row
        // on screen -- strictly greater than topRowIndex, less than bottomRowIndex. Biased
        // toward topRowIndex (a third of the way into the gap, not the midpoint) rather than
        // split evenly: floodLines' own command sends `node -e "..."` as one line before its
        // output starts, and that extra line (plus normal prompt overhead) eats into the
        // margin on the bottom side, not the top.
        const floodAmount = topRowIndex + Math.max(2, Math.floor((bottomRowIndex - topRowIndex) / 3));
        await floodLines(page, sid, floodAmount, 'FLOOD');

        await focusTerminalHost(page, sid);
        await page.keyboard.press('Control+C');

        await expect.poll(() => readClipboardWriteCallCount(page), {
          message:
            'E2E precondition failed: no clipboard write occurred after Control+C -- the selection was '
            + 'likely fully cleared (flood size too large for this environment\'s scrollback) rather than '
            + 'partially trimmed. If this keeps failing, raise the gap and re-tune the flood size.',
          timeout: 10_000,
        }).toBeGreaterThan(0);

        const copied = (await readClipboardWriteCalls(page)).at(-1) ?? '';
        // The discriminating assertion: compare what was actually copied against what was
        // originally selected (captured above, before the flood), not just "is copy
        // disabled" -- xterm's SelectionModel.handleTrim clamps selectionStart to buffer row
        // 0 instead of clearing the selection when only the top scrolls off, so hasSelection
        // stays true and copy stays enabled throughout. A copy that silently diverged from
        // what the user dragged over is the injury this AC exists to catch.
        expect(
          copied,
          `${RED_SIGNATURES.partialTrim}\noriginally selected: ${JSON.stringify(originallySelectedText)}\n`
          + `actually copied: ${JSON.stringify(copied)}`,
        ).not.toEqual(originallySelectedText);
        expect(copied, RED_SIGNATURES.partialTrim).not.toContain(topMarker);
      } finally {
        await cleanupEvictionWorkspace(page, workspace);
      }
    },
  );
});

function terminalScope(page: Page, sessionId: string) {
  return page.locator(`[data-session-id="${sessionId}"]`);
}

function copyMenuItem(page: Page) {
  return page.locator('.context-menu-item').filter({ hasText: '복사' }).first();
}

/**
 * Reads exactly `term.rows` lines mapped 1:1 to the current viewport (index 0 = top row)
 * through the test-host-gated debug hook, since `.xterm-rows` does not exist under the
 * WebGL renderer. Returns `null` if the hook itself is unavailable (host not
 * `isLocalTestHost()`, or the handler was never registered) so callers can tell that
 * apart from "no rows matched".
 */
async function captureTerminalLines(page: Page, sessionId: string): Promise<string[] | null> {
  const text = await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? null,
    sessionId,
  );
  return text === null ? null : text.split('\n');
}

/**
 * Reads xterm's own selection model directly (`term.hasSelection()` / `term.getSelection()`,
 * via `TerminalView.tsx`'s `registerTerminalSelectionCaptureHandler`) instead of the DOM.
 *
 * Under the WebGL renderer a selection is painted on canvas with no DOM trace at all -- no
 * `.xterm-selection` element, and the browser's Selection API never reflects it either. Before
 * this hook existed, "no `.xterm-selection` in the DOM" and "empty clipboard after Ctrl+C" were
 * the only signals this spec had, and both are equally consistent with "no selection was made"
 * and "a selection exists but this instrument cannot see it" -- there was no way to tell which.
 * That ambiguity is why an earlier draft's "the drag creates no selection" conclusion could not
 * be trusted and is not assumed true here; this hook is what actually answers the question.
 */
async function captureSelection(
  page: Page,
  sessionId: string,
): Promise<{ hasSelection: boolean; text: string } | null> {
  return page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureTerminalSelection?.(id) ?? null,
    sessionId,
  );
}

/**
 * Waits for a line that is EXACTLY `marker` (after trailing-whitespace trim), not merely a
 * line that contains it as a substring.
 *
 * `echo ${marker}` puts the marker substring on screen the moment it is typed -- on the
 * prompt line itself, as `<prompt> echo ${marker}` -- well before Enter is processed. A
 * substring check is satisfied by that unexecuted command line just as readily as by the
 * real output line, so it cannot tell "typed" from "ran". Measured 2026-09-19: this produced
 * a false-positive "marker found" against a row that was still raw unsubmitted input, and a
 * mouse drag over that row selected editable prompt text rather than output, which is why
 * the control step's Ctrl+C landed nothing. An exact match only matches `echo`'s own output
 * line (nothing else contains just the marker with nothing else on the line), so it is only
 * satisfied once the command has actually run.
 */
async function markerVisible(page: Page, sessionId: string, marker: string, timeout: number): Promise<boolean> {
  try {
    await expect.poll(async () => {
      const lines = await captureTerminalLines(page, sessionId);
      return lines?.some(line => line.trim() === marker) ?? false;
    }, { timeout }).toBe(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Types a command into the terminal like `sendVisibleTerminalCommand` (`helpers.ts`), but
 * skips the initial click if the terminal's helper textarea is already focused.
 *
 * Measured 2026-09-19: `sendVisibleTerminalCommand`'s unconditional `screen.click()` clears
 * any active xterm selection as a side effect, the same way `focusTerminalHost`'s own click
 * used to (see that function's doc comment) -- a click that lands away from the drag's own
 * mouseup is an unrelated mousedown+mouseup, and xterm's `SelectionService` treats that as
 * "place the cursor here", ending the selection. This spec sends flood commands (via
 * `floodLines`) AFTER creating a selection specifically to test whether the FLOOD'S OUTPUT
 * evicts it -- if the command that STARTS the flood clears the selection by clicking, every
 * such test would show "selection gone" regardless of whether the flood's output ever
 * mattered, which is exactly the vacuous-pass shape this spec's own control tests exist to
 * catch elsewhere. A real user does not re-click a terminal they are already typing into.
 */
async function sendVisibleTerminalCommandPreservingSelection(
  page: Page,
  sessionId: string,
  command: string,
): Promise<void> {
  await focusTerminalHost(page, sessionId);
  await waitForTerminalInputReady(page);
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/**
 * Types `command` and waits for `marker` to appear as its own output line, retrying the
 * whole type-and-wait cycle on failure rather than just waiting longer.
 *
 * `sendVisibleTerminalCommand`'s own doc comment already documents a case where the input
 * gate closes for a bounded TTL and silently discards whatever was typed during that window
 * (measured on a freshly attached session). A large flood (this spec sends up to 15,000
 * lines) can plausibly retrigger a similar transient gate close on the server side after the
 * burst. Retyping is the same recovery a human at the keyboard would do without needing to
 * characterise the gate's exact timing here -- but only after clearing whatever might already
 * be sitting unsubmitted on the current line (Ctrl+U): retyping onto a line that silently did
 * receive the previous attempt's keystrokes but never got its Enter processed would otherwise
 * concatenate two attempts onto one unsubmitted line instead of recovering.
 */
async function sendCommandAndWaitForMarker(
  page: Page,
  sessionId: string,
  command: string,
  marker: string,
  options: { attempts?: number; perAttemptTimeoutMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 3;
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? 8_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await focusTerminalHost(page, sessionId);
      await page.keyboard.press('Control+U');
    }
    await sendVisibleTerminalCommandPreservingSelection(page, sessionId, command);
    if (await markerVisible(page, sessionId, marker, perAttemptTimeoutMs)) {
      return;
    }
  }
  const lines = await captureTerminalLines(page, sessionId);
  throw new Error(
    `E2E precondition failed: marker "${marker}" never appeared in session "${sessionId}"'s viewport `
    + `after ${attempts} attempt(s). Last observed viewport: ${JSON.stringify(lines)}`,
  );
}

interface MarkerPosition {
  x: number;
  y: number;
  width: number;
}

/** Buffer-row index -> pixel Y, using the terminal screen's own bounding box divided by row count. */
async function locateMarker(page: Page, sessionId: string, marker: string): Promise<MarkerPosition> {
  const lines = await captureTerminalLines(page, sessionId);
  if (lines === null) {
    throw new Error(
      `E2E precondition failed: captureTerminalText debug hook is unavailable for session "${sessionId}" `
      + '-- is the host isLocalTestHost()-gated?',
    );
  }
  // Exact match, not substring -- see markerVisible's doc comment for why a substring check
  // can resolve to the unexecuted `<prompt> echo ${marker}` command line instead of the
  // actual output line.
  const rowIndex = lines.findIndex(line => line.trim() === marker);
  if (rowIndex === -1) {
    throw new Error(`E2E precondition failed: marker "${marker}" not found in current viewport (${lines.length} rows)`);
  }
  const screen = terminalScope(page, sessionId).locator('.xterm-screen');
  const box = await screen.boundingBox();
  if (!box) {
    throw new Error(`E2E precondition failed: terminal screen for session "${sessionId}" has no bounding box`);
  }
  const rowHeight = box.height / lines.length;
  return { x: box.x, y: box.y + (rowIndex + 0.5) * rowHeight, width: box.width };
}

/**
 * Focuses the terminal's helper textarea, but only by clicking if it is not already
 * focused. Measured 2026-09-19: calling this unconditionally right after a real mouse drag
 * (as `createSingleLineSelection` used to) cleared the selection the drag had just made --
 * `.click()` clicks the CENTER of the terminal, a second, unrelated mousedown+mouseup that
 * xterm's `SelectionService` correctly treats as "place the cursor here, ending any prior
 * selection", the same way a normal click in the middle of previously-selected text does.
 * A drag already leaves the helper textarea focused (confirmed via `document.activeElement`
 * immediately before and after a drag in a standalone check), so the safe behavior is to
 * skip the click entirely when focus is already correct, and only click to (re-)acquire
 * focus from elsewhere -- which has no selection to protect.
 */
async function focusTerminalHost(page: Page, sessionId: string): Promise<void> {
  const alreadyFocused = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
  });
  if (alreadyFocused) return;
  const screen = terminalScope(page, sessionId).locator('.xterm-screen');
  await screen.click();
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
  }, undefined, { timeout: 10_000 });
}

/**
 * Drags the mouse across one row, slowly enough for xterm's `SelectionService` to register
 * a drag rather than a click.
 *
 * Measured 2026-09-19: `page.mouse.move(x, y, { steps: N })` interpolates position but does
 * not add real wall-clock delay between the dispatched events -- CDP fires them back to back.
 * A drag built that way left `term.hasSelection()` false via `captureTerminalSelection` every
 * time, with no visible error; a diagnostic script that instead moved in a loop with a small
 * `waitForTimeout` between steps produced a real selection on the first try, with no other
 * change (same coordinates, same buttons, no modifier key). Holding Shift during the drag
 * (`terminal-clipboard.spec.ts`'s `createVisibleTerminalSelection` does this) was tried first
 * and made no difference on its own -- the pacing was the actual fix.
 *
 * Starts 1px inside the row's left edge rather than 4px: at 4px the mousedown landed in the
 * right half of the first character's cell, which xterm's coordinate-to-column mapping
 * resolves to the SECOND column, silently dropping the row's first character from the
 * selection (measured: selecting "DIAGMARK" copied "IAGMARK"). 1px reliably lands in the left
 * half of column 0's cell for this terminal's font metrics.
 */
async function dragAcrossRow(page: Page, position: MarkerPosition, endY: number = position.y): Promise<void> {
  const x1 = position.x + 1;
  const x2 = position.x + position.width - 4;
  const steps = 20;
  await page.mouse.move(x1, position.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      x1 + ((x2 - x1) * i) / steps,
      position.y + ((endY - position.y) * i) / steps,
    );
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
}

/**
 * Real mouse drag across a freshly emitted marker line -- sets selectionStart AND
 * selectionEnd there. Asserts, via xterm's own model rather than the DOM, that the drag
 * actually produced a selection covering the marker before returning -- a caller that skips
 * straight to an eviction assertion cannot tell "eviction cleared it" from "there was never
 * a selection to clear" (`captureSelection`'s doc comment explains why the DOM cannot answer
 * this question under the WebGL renderer).
 */
async function createSingleLineSelection(page: Page, sessionId: string, marker: string): Promise<void> {
  await sendCommandAndWaitForMarker(page, sessionId, `echo ${marker}`, marker);
  const position = await locateMarker(page, sessionId, marker);
  await dragAcrossRow(page, position);
  await focusTerminalHost(page, sessionId);

  await expect.poll(
    async () => (await captureSelection(page, sessionId))?.hasSelection ?? false,
    {
      message: `E2E precondition failed: the drag across marker "${marker}" produced no selection `
        + 'according to xterm\'s own model (term.hasSelection()) -- not merely no visible DOM trace.',
      timeout: 5_000,
    },
  ).toBe(true);
  const selection = await captureSelection(page, sessionId);
  expect(
    selection?.text.trim(),
    `E2E precondition failed: the drag's selection text was "${selection?.text}", expected it to `
    + `contain marker "${marker}"`,
  ).toContain(marker);
}

/** Emits `count` lines via a portable `node -e` one-liner and waits for the last one to render. */
async function floodLines(page: Page, sessionId: string, count: number, label: string): Promise<void> {
  await sendCommandAndWaitForMarker(
    page,
    sessionId,
    `node -e "for(let i=1;i<=${count};i++)console.log('${label}-'+i)"`,
    `${label}-${count}`,
    { perAttemptTimeoutMs: 60_000 },
  );
}

async function installMemoryClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      __e2eClipboardText?: string;
      __e2eClipboardWriteCalls?: string[];
    };
    state.__e2eClipboardText = '';
    state.__e2eClipboardWriteCalls = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => state.__e2eClipboardText ?? '',
        writeText: async (text: string) => {
          state.__e2eClipboardWriteCalls!.push(text);
          state.__e2eClipboardText = text;
        },
      },
    });
  });
}

async function readClipboardWriteCallCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window as typeof window & { __e2eClipboardWriteCalls?: string[] };
    return state.__e2eClipboardWriteCalls?.length ?? 0;
  });
}

async function readClipboardWriteCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = window as typeof window & { __e2eClipboardWriteCalls?: string[] };
    return [...(state.__e2eClipboardWriteCalls ?? [])];
  });
}

/**
 * Reads which session the UI is actually showing right now. A reload does not switch to the
 * just-created workspace synchronously -- `activateClipboardWorkspace` in terminal-clipboard.spec.ts
 * polls this same way for the same reason. Without it, a caller proceeds against whatever tab
 * happens to be on screen, which is exactly the vacuous-test hazard this lane keeps finding: the
 * spec passes or fails for a reason unrelated to what it claims to test, and worse, it can type
 * into a tab it does not own.
 */
async function getSelectedUiSessionId(page: Page): Promise<string | null> {
  const controls = await page.locator('.workspace-tabbar [role="tab"][aria-selected="true"]')
    .getAttribute('aria-controls');
  return controls?.startsWith('terminal-') ? controls.slice('terminal-'.length) : null;
}

async function activateEvictionWorkspace(page: Page): Promise<EvictionWorkspaceContext> {
  const context = await page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E precondition failed: missing auth token');
    const headers = { Authorization: `Bearer ${token}` };
    // WorkspaceService.createWorkspace rejects names over 32 characters
    // (server/src/services/WorkspaceService.ts:463) -- short prefix + uuid8, the pattern
    // FR-BGSTAB-026 VE-8 already worked out for this exact ceiling.
    const name = `e2e-sev-${crypto.randomUUID().slice(0, 8)}`;
    const workspaceResponse = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name }),
    });
    if (!workspaceResponse.ok) {
      const bodyText = await workspaceResponse.text().catch(() => '<unreadable body>');
      throw new Error(`selection-eviction workspace create failed: ${workspaceResponse.status} ${bodyText}`);
    }
    const workspace = await workspaceResponse.json();
    const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'E2E Selection Eviction' }),
    });
    if (!tabResponse.ok) throw new Error(`selection-eviction tab create failed: ${tabResponse.status}`);
    const tab = await tabResponse.json();
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspaceId: workspace.id, tabId: tab.id, sessionId: tab.sessionId };
  });
  try {
    await page.reload();
    await waitForTerminal(page);
    // Assert the switch happened; do not just wait and hope. This is the fix for the bug this
    // spec found in itself: a missing assertion here let an earlier run type into Workspace-1.
    await expect.poll(() => getSelectedUiSessionId(page), {
      message: 'E2E precondition failed: UI did not switch to the newly created workspace/session',
      timeout: 15_000,
    }).toBe(context.sessionId);
    await focusTerminalHost(page, context.sessionId);
    return context;
  } catch (error) {
    try {
      await cleanupEvictionWorkspace(page, context);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Selection-eviction setup and cleanup failed');
    }
    throw error;
  }
}

async function cleanupEvictionWorkspace(page: Page, context: EvictionWorkspaceContext): Promise<void> {
  await deleteOwnedWorkspaceForContext(page.context(), context.workspaceId);
  await page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const verification = await fetch('/api/workspaces', { headers });
    if (!verification.ok) throw new Error(`E2E cleanup verification failed: ${verification.status}`);
    const state = await verification.json();
    if (state.workspaces.some((workspace: { id?: string }) => workspace.id === input.workspaceId)) {
      throw new Error('E2E cleanup failed: selection-eviction workspace still exists');
    }
  }, context);
}
