import { expect, type BrowserContext, type Page } from '@playwright/test';
import { deleteOwnedWorkspaceForContext } from './workspaceOwnershipFixture';
import { waitForTerminal, waitForTerminalInputReady } from './helpers';

/**
 * Shared helpers for specs that make a real mouse selection in a terminal and
 * then do something to it.
 *
 * PROVENANCE. Everything from `captureTerminalLines` down to
 * `createSingleLineSelection` is lifted from
 * tests/e2e/terminal-selection-eviction.spec.ts, where these were file-local.
 * They are copied rather than imported-after-a-refactor on purpose: that spec is
 * FR-BGSTAB-029 VE-6's evidence, and evidence should not move because something
 * else wanted a helper. Each copied function keeps the measurement that produced
 * it, because every one of them encodes a way an earlier draft passed vacuously.
 * If you change one here, read the original before assuming the reason is stale.
 *
 * The three hazards these encode, restated so they are not re-discovered:
 *   1. `page.mouse.move(x, y, { steps: N })` does NOT add wall-clock delay, and
 *      a drag built that way leaves `term.hasSelection()` false every time. The
 *      loop with a per-step wait in `dragAcrossRow` is the fix; holding Shift is
 *      not.
 *   2. An unrelated `click()` — including the one `sendVisibleTerminalCommand`
 *      and a naive `focusTerminalHost` perform — reads to xterm's
 *      SelectionService as "place the cursor here" and CLEARS the selection. A
 *      spec that clicks after selecting destroys its own precondition and then
 *      "passes".
 *   3. `.xterm-rows` does not exist under the WebGL renderer (since #15), and a
 *      selection is painted to canvas with no DOM trace at all. Both text and
 *      selection must be read through the test-host-gated debug hooks.
 */

export interface SelectionWorkspaceContext {
  workspaceId: string;
  tabIds: string[];
  sessionIds: string[];
}

export function terminalScope(page: Page, sessionId: string) {
  return page.locator(`[data-session-id="${sessionId}"]`);
}

/**
 * Exactly `term.rows` lines mapped 1:1 to the CURRENT viewport (index 0 = top
 * row), through the debug hook rather than a DOM locator. Returns null when the
 * hook itself is unavailable, so callers can tell that apart from "no rows".
 */
export async function captureTerminalLines(page: Page, sessionId: string): Promise<string[] | null> {
  const text = await page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureTerminalText?.(id) ?? null,
    sessionId,
  );
  return text === null ? null : text.split('\n');
}

/** xterm's own selection model (`hasSelection()` / `getSelection()`), never the DOM's. */
export async function captureSelection(
  page: Page,
  sessionId: string,
): Promise<{ hasSelection: boolean; text: string } | null> {
  return page.evaluate(
    (id) => window.__buildergateTerminalDebug?.captureTerminalSelection?.(id) ?? null,
    sessionId,
  );
}

/**
 * Waits for a line that is EXACTLY `marker`, not one containing it. `echo X`
 * puts X on screen as part of the unsubmitted command line the moment it is
 * typed, so a substring check cannot tell "typed" from "ran" — and a drag over
 * the prompt line selects editable input rather than output.
 */
export async function markerVisible(
  page: Page,
  sessionId: string,
  marker: string,
  timeout: number,
): Promise<boolean> {
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
 * Focuses the terminal's helper textarea, clicking ONLY if focus is not already
 * there. An unconditional click clears any live selection (hazard 2 above); a
 * drag already leaves the textarea focused, so the click is never needed after
 * one.
 */
export async function focusTerminalHost(page: Page, sessionId: string): Promise<void> {
  const alreadyFocused = await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
  });
  if (alreadyFocused) return;
  await terminalScope(page, sessionId).locator('.xterm-screen').click();
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.classList.contains('xterm-helper-textarea');
  }, undefined, { timeout: 10_000 });
}

/** Types a command without the selection-clearing click that `sendVisibleTerminalCommand` performs. */
export async function sendCommandPreservingSelection(
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
 * Types `command` and waits for `marker` as its own output line, retrying the
 * whole cycle rather than just waiting longer — the input gate can close for a
 * bounded TTL and silently discard keystrokes. Ctrl+U first on a retry, so a
 * previous attempt that landed but never got its Enter processed does not
 * concatenate onto this one.
 */
export async function sendCommandAndWaitForMarker(
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
    await sendCommandPreservingSelection(page, sessionId, command);
    if (await markerVisible(page, sessionId, marker, perAttemptTimeoutMs)) return;
  }
  const lines = await captureTerminalLines(page, sessionId);
  throw new Error(
    `E2E precondition failed: marker "${marker}" never appeared in session "${sessionId}"'s viewport `
    + `after ${attempts} attempt(s). Last observed viewport: ${JSON.stringify(lines)}`,
  );
}

export interface MarkerPosition {
  x: number;
  y: number;
  width: number;
}

/** Buffer-row index -> pixel Y, from the terminal screen's bounding box over its row count. */
export async function locateMarker(page: Page, sessionId: string, marker: string): Promise<MarkerPosition> {
  const lines = await captureTerminalLines(page, sessionId);
  if (lines === null) {
    throw new Error(
      `E2E precondition failed: captureTerminalText is unavailable for session "${sessionId}" `
      + '-- is the host isLocalTestHost()-gated?',
    );
  }
  const rowIndex = lines.findIndex(line => line.trim() === marker);
  if (rowIndex === -1) {
    throw new Error(
      `E2E precondition failed: marker "${marker}" not found in current viewport (${lines.length} rows)`,
    );
  }
  const box = await terminalScope(page, sessionId).locator('.xterm-screen').boundingBox();
  if (!box) {
    throw new Error(`E2E precondition failed: terminal screen for session "${sessionId}" has no bounding box`);
  }
  const rowHeight = box.height / lines.length;
  return { x: box.x, y: box.y + (rowIndex + 0.5) * rowHeight, width: box.width };
}

/**
 * Drags across one row slowly enough for xterm to register a drag rather than a
 * click (hazard 1). Starts 1px inside the left edge: at 4px the mousedown lands
 * in the right half of column 0's cell and xterm resolves it to column 1,
 * silently dropping the row's first character.
 */
export async function dragAcrossRow(page: Page, position: MarkerPosition): Promise<void> {
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
 * Emits a marker line, drags across it, and ASSERTS a selection covering it
 * exists before returning. Without that assertion a later "the selection is
 * gone" reading cannot be told apart from "there was never a selection".
 */
export async function createSingleLineSelection(
  page: Page,
  sessionId: string,
  marker: string,
): Promise<void> {
  await sendCommandAndWaitForMarker(page, sessionId, `echo ${marker}`, marker);
  await dragAcrossRow(page, await locateMarker(page, sessionId, marker));
  await focusTerminalHost(page, sessionId);

  await expect.poll(
    async () => (await captureSelection(page, sessionId))?.hasSelection ?? false,
    {
      message: `E2E precondition failed: the drag across marker "${marker}" produced no selection `
        + "according to xterm's own model (term.hasSelection()).",
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

// ---------------------------------------------------------------------------
// Renderer identification, from tests/e2e/webgl-dom-fallback.spec.ts
// ---------------------------------------------------------------------------

export interface RendererCounts {
  canvases: number;
  domRows: number;
}

/**
 * Identifies the renderer BY CONSTRUCTION rather than by name: xterm's WebGL
 * renderer draws to <canvas> and emits no per-row DOM, its DOM renderer emits
 * one div per row and no canvas. Scoped to one session, because hidden views
 * stay mounted and render on the DOM — a page-wide count mixes them in.
 */
export async function rendererCounts(page: Page, sessionId: string): Promise<RendererCounts> {
  return page.evaluate((id) => {
    const view = document.querySelector(`[data-session-id="${id}"]`);
    return {
      canvases: view ? view.querySelectorAll('.xterm canvas').length : -1,
      domRows: view ? view.querySelectorAll('.xterm-rows > div').length : -1,
    };
  }, sessionId);
}

/** Takes the GPU context away for real, via WEBGL_lose_context. Returns how many it killed. */
export async function loseWebglContext(page: Page, sessionId: string): Promise<number> {
  return page.evaluate((id) => {
    const view = document.querySelector(`[data-session-id="${id}"]`);
    let killed = 0;
    for (const canvas of Array.from(view?.querySelectorAll('.xterm canvas') ?? [])) {
      for (const type of ['webgl2', 'webgl']) {
        const gl = (canvas as HTMLCanvasElement).getContext(type) as WebGLRenderingContext | null;
        if (gl) {
          const ext = gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null;
          if (ext) {
            ext.loseContext();
            killed += 1;
          }
          break;
        }
      }
    }
    return killed;
  }, sessionId);
}

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

/** Which session the UI is actually showing right now. */
export async function getSelectedUiSessionId(page: Page): Promise<string | null> {
  const controls = await page.locator('.workspace-tabbar [role="tab"][aria-selected="true"]')
    .getAttribute('aria-controls');
  return controls?.startsWith('terminal-') ? controls.slice('terminal-'.length) : null;
}

export async function selectUiTab(page: Page, sessionId: string): Promise<void> {
  await page.locator(`.workspace-tabbar [role="tab"][aria-controls="terminal-${sessionId}"]`).click();
  await expect.poll(() => getSelectedUiSessionId(page), {
    message: `E2E precondition failed: UI did not switch to session ${sessionId}`,
    timeout: 15_000,
  }).toBe(sessionId);
}

/**
 * Creates one workspace with `tabCount` tabs and switches the UI to it. Owns
 * only what it creates; the workspace id is returned so the caller deletes
 * exactly that one.
 */
export async function activateSelectionWorkspace(
  page: Page,
  tabCount = 1,
): Promise<SelectionWorkspaceContext> {
  const context = await page.evaluate(async (count) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E precondition failed: missing auth token');
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    // WorkspaceService rejects names over 32 characters.
    const name = `e2e-sel-${crypto.randomUUID().slice(0, 8)}`;
    const workspaceResponse = await fetch('/api/workspaces', {
      method: 'POST', headers, body: JSON.stringify({ name }),
    });
    if (!workspaceResponse.ok) {
      const body = await workspaceResponse.text().catch(() => '<unreadable body>');
      throw new Error(`selection workspace create failed: ${workspaceResponse.status} ${body}`);
    }
    const workspace = await workspaceResponse.json();
    const tabIds: string[] = [];
    const sessionIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
        method: 'POST', headers, body: JSON.stringify({ name: `E2E Selection ${index + 1}` }),
      });
      if (!tabResponse.ok) throw new Error(`selection tab create failed: ${tabResponse.status}`);
      const tab = await tabResponse.json();
      tabIds.push(tab.id);
      sessionIds.push(tab.sessionId);
    }
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspaceId: workspace.id, tabIds, sessionIds };
  }, tabCount);

  try {
    await page.reload();
    await waitForTerminal(page);
    // Assert the switch happened rather than waiting and hoping: without this an
    // earlier version of this pattern typed into Workspace-1.
    await expect.poll(() => getSelectedUiSessionId(page), {
      message: 'E2E precondition failed: UI did not switch to the newly created workspace',
      timeout: 15_000,
    }).toBe(context.sessionIds[0]);
    await focusTerminalHost(page, context.sessionIds[0]);
    return context;
  } catch (error) {
    try {
      await cleanupSelectionWorkspace(page.context(), context);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Selection workspace setup and cleanup failed');
    }
    throw error;
  }
}

/** Deletes exactly the workspace this run created, by id, and verifies it is gone. */
export async function cleanupSelectionWorkspace(
  context: BrowserContext,
  workspace: SelectionWorkspaceContext,
): Promise<void> {
  await deleteOwnedWorkspaceForContext(context, workspace.workspaceId);
  const page = context.pages()[0];
  if (!page) return;
  await page.evaluate(async (workspaceId) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const verification = await fetch('/api/workspaces', { headers });
    if (!verification.ok) throw new Error(`E2E cleanup verification failed: ${verification.status}`);
    const state = await verification.json();
    if (state.workspaces.some((entry: { id?: string }) => entry.id === workspaceId)) {
      throw new Error('E2E cleanup failed: selection workspace still exists');
    }
  }, workspace.workspaceId);
}
