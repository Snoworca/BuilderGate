import { expect, type Page } from '@playwright/test';
import { test, deleteOwnedWorkspaceForContext } from './workspaceOwnershipFixture';
import { login, openTerminalContextMenu, sendVisibleTerminalCommand, waitForTerminal } from './helpers';

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

  test(
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

        // Anchor the selection at topMarker's row while it is still on screen. A real
        // drag (not a bare click) matches how a user actually starts a selection and
        // establishes both selectionStart and selectionEnd at this row.
        await createSingleLineSelection(page, sid, topMarker);

        // Push topMarker far above the viewport before bottomMarker appears, so the
        // two can never be simultaneously visible -- this is the same situation a
        // real user hits with a large scrollback, and it rules out a drag that
        // happens to stay within one screenful.
        await floodLines(page, sid, 3_000, 'GAP');
        await sendCommandAndWaitForMarker(page, sid, `echo ${bottomMarker}`, bottomMarker);

        // Shift+click extends selectionEnd to bottomMarker while leaving
        // selectionStart exactly where the initial drag put it (xterm's own
        // SelectionService._handleIncrementalClick only touches selectionEnd).
        await shiftClickMarker(page, sid, bottomMarker);

        // Calibrated against this server's configured browser scrollback
        // (resourceLimits.terminal.scrollbackLines = 10000, server/config.json5)
        // plus viewport rows, so that topMarker's row (written before the 3000-line
        // gap) crosses below buffer row 0 while bottomMarker's row (written after
        // the gap) does not. The 3000-line gap gives a wide margin against any
        // error in that estimate.
        await floodLines(page, sid, 9_700, 'FLOOD');

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
    await sendVisibleTerminalCommand(page, command, { sessionId });
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

async function focusTerminalHost(page: Page, sessionId: string): Promise<void> {
  const screen = terminalScope(page, sessionId).locator('.xterm-screen');
  await screen.click();
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
  }, undefined, { timeout: 10_000 });
}

/** Real mouse drag across a freshly emitted marker line -- sets selectionStart AND selectionEnd there. */
async function createSingleLineSelection(page: Page, sessionId: string, marker: string): Promise<void> {
  await sendCommandAndWaitForMarker(page, sessionId, `echo ${marker}`, marker);
  const position = await locateMarker(page, sessionId, marker);
  await page.mouse.move(position.x + 4, position.y);
  await page.mouse.down();
  await page.mouse.move(position.x + position.width - 4, position.y, { steps: 8 });
  await page.mouse.up();
  await focusTerminalHost(page, sessionId);
}

/** Shift+click extends the existing selection's end to this row without touching its start. */
async function shiftClickMarker(page: Page, sessionId: string, marker: string): Promise<void> {
  const position = await locateMarker(page, sessionId, marker);
  await page.keyboard.down('Shift');
  try {
    await page.mouse.click(position.x + position.width - 4, position.y);
  } finally {
    await page.keyboard.up('Shift');
  }
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
