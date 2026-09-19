import { expect, type Page } from '@playwright/test';
import { test, deleteOwnedWorkspaceForContext } from './workspaceOwnershipFixture';
import { login, openTerminalContextMenu, waitForTerminal, waitForTerminalInputReady } from './helpers';

/**
 * FR-BGSTAB-029 (GitHub issue #16) selection-eviction regressions.
 *
 * AC-3 ("fully evicted selection is invalidated") was previously checked only on a
 * hand-run live-browser measurement (VE-2/VE-5) with no re-runnable artifact -- an
 * independent review correctly called that CRITICAL and reverted it to unchecked.
 * The test below is the Playwright spec VE-5 named as the closing bar: a real
 * mouse drag selects a line, output floods past it, and the copy path must become
 * unavailable -- with a live-selection control so a spec that always reports
 * "disabled" cannot pass vacuously.
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
 * Two more things measured 2026-09-19, once `captureTerminalSelection` (the debug hook
 * this file's earlier draft was blocked on) went live, both found by distrusting a
 * conclusion drawn from the DOM and re-checking it against xterm's own model -- the earlier
 * "the drag creates no selection" conclusion in this file's history was drawn before this
 * hook existed and could not be trusted either way, and turned out to be true, just not for
 * a reason the DOM could ever have shown:
 *
 *   1. A `page.mouse.move(x, y, { steps: N })` drag does not add real wall-clock delay
 *      between the events it dispatches, and left `term.hasSelection()` false every time.
 *      Moving in a loop with a small `waitForTimeout` between steps (`dragAcrossRow`) fixed
 *      it.
 *   2. `focusTerminalHost`'s and `sendVisibleTerminalCommand`'s `screen.click()` clears
 *      whatever selection currently exists as a side effect (an unrelated mousedown+mouseup
 *      reads as "place the cursor here" to xterm's `SelectionService`), which made every
 *      later flood command in this file destroy the selection it was supposed to be testing
 *      the eviction of, for a reason that had nothing to do with the flood's OUTPUT. Both
 *      are fixed here to skip the click when the terminal is already correctly focused.
 *
 * A second AC (a selection trimmed at the top but surviving at the bottom, from reading
 * xterm's own `SelectionModel.handleTrim`) was proposed, attempted, and withdrawn the same
 * day -- see FR-BGSTAB-029's change note. `handleTrim`'s partial-clamp path is real in
 * xterm, but a selection here does not survive long enough to reach it: it was measured
 * gone after a single bare Enter keypress at an empty prompt (no scroll, no scrollback
 * pressure at all), so the precondition the AC needed never occurs in this app. That is a
 * wrong criterion, not a gap in the product -- withdrawn rather than parked.
 */

interface EvictionWorkspaceContext {
  workspaceId: string;
  tabId: string;
  sessionId: string;
}

const RED_SIGNATURES = {
  fullEviction: 'FR-BGSTAB-029 AC-3: a fully evicted selection must disable the copy menu item',
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
async function dragAcrossRow(page: Page, position: MarkerPosition): Promise<void> {
  const x1 = position.x + 1;
  const x2 = position.x + position.width - 4;
  const steps = 20;
  await page.mouse.move(x1, position.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / steps, position.y);
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
