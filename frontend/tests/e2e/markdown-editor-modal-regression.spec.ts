// FR-MDE-003 AC-7: the six modals that predate the dialog-stack split still
// behave the way they did when one array held every dialog.
//
// `dialogStack.ts` now keeps a stack per `DialogMode`, so a modal's layer
// index and its `isTopmost` are decided among modals alone. Every criterion
// below is therefore read with no editor window on screen: that is the state
// in which the split must be invisible, and any difference it produced would
// show up here rather than in the modeless coverage.
//
// This is a characterization spec -- it passed before the split and has to
// pass after it -- so it can never be run red first. That makes a test which
// measures nothing indistinguishable from a test which measures the right
// thing, and three choices below exist to close that gap:
//
//   * Stacking is read as the layer's computed z-index, not as a class name or
//     a DOM position. `window-dialog-layer-modal` is on every modal layer
//     whatever the stack says, and portal order is mount order; only the
//     z-index carries the index the stack computed.
//
//   * Escape is asserted through a probe listener on `document.body`. The
//     dialog staying open is not evidence on its own -- a dialog with no
//     Escape handling at all also stays open. What the modal actually does is
//     swallow the key at document capture, and only a listener below document
//     can tell the two apart.
//
//   * Tab containment is read at the two boundaries the component computes,
//     by focusing the last focusable and pressing Tab, then the first and
//     pressing Shift+Tab. Pressing Tab in a loop and watching focus stay
//     inside passes even when the wrap is broken, because a wrap that lands on
//     the wrong element is still inside the dialog.

import { test, expect, type Page } from '@playwright/test';

import {
  clearCommandPresets,
  createCommandPresetViaApi,
  login,
  openCommandPresetDialog,
  openRecoveryOptionDialog,
  openTerminalContextMenu,
  openTerminalShortcutDialog,
  waitForTerminal,
} from './helpers';

/** `LAYER_BANDS.modal.base` in windowDialogModel.ts. */
const MODAL_BAND_BASE = 5000;
/** `LAYER_STEP` in windowDialogModel.ts. */
const LAYER_STEP = 20;

/** The label the delete confirmation is raised from. */
const DELETE_PRESET_LABEL = 'e2e-dialog-modal-regression';

interface ModalCase {
  /** Reported name, and the test title. */
  name: string;
  /**
   * The dialog's registered id, which is the prefix of its surface's
   * `aria-labelledby`. The delete confirmation carries the preset id after
   * this, so every lookup matches on the prefix.
   */
  dialogId: string;
  /** Opens the modal and waits until its content has settled. */
  open: (page: Page) => Promise<void>;
  /**
   * Modals already on screen underneath this one. A MessageBox is only ever
   * raised from a dialog, so it is measured as the topmost of a pair -- which
   * is the only state it exists in.
   */
  stackDepth: number;
  /** Cleans up server state this case created. */
  cleanup?: (page: Page) => Promise<void>;
}

const MODAL_CASES: ModalCase[] = [
  {
    name: 'CommandPresetDialog',
    dialogId: 'command-preset-manager',
    stackDepth: 1,
    open: async (page) => {
      await openCommandPresetDialog(page);
      await expect(page.getByTestId('command-preset-dialog').getByRole('tab').first())
        .toBeVisible();
    },
    cleanup: clearCommandPresets,
  },
  {
    name: 'TerminalShortcutDialog',
    dialogId: 'terminal-shortcut-manager',
    stackDepth: 1,
    open: async (page) => {
      await openTerminalShortcutDialog(page);
      await expect(page.getByTestId('terminal-shortcut-dialog').getByRole('tab').first())
        .toBeVisible();
    },
  },
  {
    name: 'RecoveryOptionDialog',
    dialogId: 'recovery-option-manager',
    stackDepth: 1,
    open: async (page) => {
      await openRecoveryOptionDialog(page);
      await expect(page.locator('.command-preset-list[aria-label="복구 옵션 목록"]'))
        .toBeVisible();
    },
  },
  {
    name: 'McpControlDialog',
    dialogId: 'mcp-control-manager',
    stackDepth: 1,
    open: async (page) => {
      await page.locator('button[title="Tools"]').click();
      await page.getByRole('menuitem', { name: 'MCP 설정', exact: true }).click();
      const dialog = page.getByTestId('mcp-control-dialog');
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByRole('tab', { name: '보안' }))
        .toHaveAttribute('aria-selected', 'true');
    },
  },
  {
    name: 'WorkspaceMoveDialog',
    dialogId: 'workspace-move-dialog',
    stackDepth: 1,
    open: async (page) => {
      await openTerminalContextMenu(page);
      await page.locator('.context-menu-item:has-text("워크스페이스 이동")').first().click();
      await expect(surfaceOf(page, 'workspace-move-dialog')).toBeVisible({ timeout: 10000 });
    },
  },
  {
    name: 'MessageBox',
    dialogId: 'command-preset-delete-confirm-',
    stackDepth: 2,
    open: async (page) => {
      await openDeleteConfirmation(page);
    },
    cleanup: clearCommandPresets,
  },
];

test.describe('Markdown editor modal regression (FR-MDE-003 AC-7)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only dialog coverage');
    await login(page);
    await ensureTerminal(page);
    await clearCommandPresets(page);
  });

  for (const modalCase of MODAL_CASES) {
    test(`${modalCase.name} keeps its place in the modal band`, async ({ page }) => {
      await modalCase.open(page);
      try {
        // No editor window is open, so nothing may have registered in the
        // modeless stack. If one had, the index read below would no longer be
        // a statement about modals alone.
        await expect(page.locator('.window-dialog-layer-modeless')).toHaveCount(0);

        const stack = await readModalStack(page);
        expect(stack).toHaveLength(modalCase.stackDepth);

        const index = stack.findIndex(entry => entry.dialogId.startsWith(modalCase.dialogId));
        expect(index, `${modalCase.dialogId} is registered in the modal stack`).toBe(
          modalCase.stackDepth - 1,
        );

        // The band, the step, and the one-above-the-layer rule the backdrop and
        // the box are separated by.
        stack.forEach((entry, entryIndex) => {
          expect(entry.layerZ).toBe(MODAL_BAND_BASE + entryIndex * LAYER_STEP);
          expect(entry.dialogZ).toBe(entry.layerZ + 1);
          expect(entry.hasBackdrop).toBe(true);
        });
      } finally {
        await modalCase.cleanup?.(page);
      }
    });

    test(`${modalCase.name} swallows Escape instead of closing`, async ({ page }) => {
      await modalCase.open(page);
      try {
        const surface = surfaceOf(page, modalCase.dialogId);
        await expectFocusInside(page, modalCase.dialogId);

        await installEscapeProbe(page);
        await page.keyboard.press('Escape');

        // Still open, and the key never reached anything below document.
        await expect(surface).toBeVisible();
        expect(await readEscapeProbe(page)).toBe(0);
        expect(await readModalStack(page)).toHaveLength(modalCase.stackDepth);
      } finally {
        await modalCase.cleanup?.(page);
      }
    });

    test(`${modalCase.name} wraps Tab at both ends of its own surface`, async ({ page }) => {
      await modalCase.open(page);
      try {
        await expectFocusInside(page, modalCase.dialogId);
        const boundaries = await markFocusBoundaries(page, modalCase.dialogId);
        // A single focusable makes both wraps the identity move, and the
        // measurement below would pass without the trap existing.
        expect(boundaries.focusableCount).toBeGreaterThanOrEqual(2);

        // Forward wrap: past the last focusable is the first, not the document.
        await page.locator('[data-e2e-focus-role="last"]').focus();
        await page.keyboard.press('Tab');
        expect(await readFocusRole(page)).toBe('first');

        // Backward wrap: before the first focusable is the last.
        await page.locator('[data-e2e-focus-role="first"]').focus();
        await page.keyboard.press('Shift+Tab');
        expect(await readFocusRole(page)).toBe('last');

        // And nothing in between leaves the surface.
        await installFocusTrail(page, modalCase.dialogId);
        for (let press = 0; press < 10; press += 1) {
          await page.keyboard.press('Tab');
        }
        const trail = await readFocusTrail(page);
        expect(trail.length).toBeGreaterThan(0);
        expect(trail.filter(entry => !entry.inSurface)).toEqual([]);
      } finally {
        await modalCase.cleanup?.(page);
      }
    });
  }

  test('a second modal takes the top of the band and gives it back on close', async ({ page }) => {
    await openDeleteConfirmation(page);
    try {
      // Focus ownership first: it is what `isTopmost` decides, and it is
      // decided before any of the z-indices below are read.
      await expectFocusInside(page, 'command-preset-delete-confirm-');

      const stacked = await readModalStack(page);
      expect(stacked.map(entry => entry.dialogId.replace(/-[0-9a-f-]{6,}$/, ''))).toEqual([
        'command-preset-manager',
        'command-preset-delete-confirm',
      ]);
      expect(stacked.map(entry => entry.layerZ)).toEqual([
        MODAL_BAND_BASE,
        MODAL_BAND_BASE + LAYER_STEP,
      ]);

      // Closing the newest hands the band, and the focus, back to the dialog
      // that raised it.
      await page.getByRole('alertdialog', { name: '삭제 확인' })
        .getByRole('button', { name: 'Cancel' })
        .click();
      await expect(page.getByRole('alertdialog', { name: '삭제 확인' })).toHaveCount(0);

      const remaining = await readModalStack(page);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].dialogId).toBe('command-preset-manager');
      expect(remaining[0].layerZ).toBe(MODAL_BAND_BASE);
      await expectFocusInside(page, 'command-preset-manager');
    } finally {
      await clearCommandPresets(page);
    }
  });
});

/**
 * Leaves the workspace with one live terminal.
 *
 * A server started for this spec alone has an empty workspace, and the
 * workspace move dialog is only reachable from a terminal's context menu. The
 * tab is created once and outlives the test, because the workspace state is
 * the server's: adding one per test would walk into the eight-tab ceiling
 * partway through the run.
 *
 * Whether a tab exists is asked of the server rather than read off the screen.
 * The workspace state arrives after the first paint, so the empty state is on
 * screen for a moment even when a tab is already there, and a check that
 * trusted the DOM would click a button that is about to be unmounted.
 */
async function ensureTerminal(page: Page): Promise<void> {
  const hasTab = await page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      return false;
    }
    const state = await response.json() as { tabs?: unknown[] };
    return Array.isArray(state.tabs) && state.tabs.length > 0;
  });

  if (!hasTab) {
    await page.getByRole('button', { name: '+ Add Terminal' }).first().click();
  }
  await waitForTerminal(page);
}

/** The dialog surface registered under an id starting with `dialogId`. */
function surfaceOf(page: Page, dialogId: string) {
  return page.locator(`.window-dialog-surface[aria-labelledby^="${dialogId}"]`);
}

/** Opens the command preset manager and raises its delete confirmation. */
async function openDeleteConfirmation(page: Page): Promise<void> {
  const label = `${DELETE_PRESET_LABEL}-${Date.now()}`;
  await createCommandPresetViaApi(page, 'command', label, 'echo modal-regression');
  await openCommandPresetDialog(page);
  await page.getByLabel(`${label} 삭제`).click();
  await expect(page.getByRole('alertdialog', { name: '삭제 확인' })).toBeVisible({ timeout: 10000 });
}

interface ModalLayerReading {
  dialogId: string;
  layerZ: number;
  dialogZ: number;
  hasBackdrop: boolean;
}

/**
 * Every modal layer on screen, in the order the stack put them in.
 *
 * Modals are never reordered by a press -- `useDialogStack` refuses to raise
 * one -- so portal order and stack order are the same, and the z-index each
 * layer carries is the index the stack computed for it.
 */
async function readModalStack(page: Page): Promise<ModalLayerReading[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>('.window-dialog-layer-modal'))
      .map((layer) => {
        const surface = layer.querySelector<HTMLElement>('.window-dialog-surface');
        const box = layer.querySelector<HTMLElement>('.window-dialog');
        return {
          dialogId: (surface?.getAttribute('aria-labelledby') ?? '').replace(/-title$/, ''),
          layerZ: Number(window.getComputedStyle(layer).zIndex),
          dialogZ: box === null ? Number.NaN : Number(window.getComputedStyle(box).zIndex),
          hasBackdrop: layer.querySelector('.window-dialog-backdrop') !== null,
        };
      });
  });
}

/**
 * Counts Escape keydowns that get past document capture.
 *
 * The listener sits on `document.body`, one step below where the modal's
 * handler runs. `stopPropagation` on a document-capture listener does not stop
 * other listeners on document itself, so a probe placed there would fire
 * whether or not the modal swallowed the key and would measure nothing.
 */
async function installEscapeProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = { count: 0 };
    (window as unknown as { __e2eEscapeProbe: { count: number } }).__e2eEscapeProbe = probe;
    document.body.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        probe.count += 1;
      }
    }, true);
  });
}

async function readEscapeProbe(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { __e2eEscapeProbe?: { count: number } })
      .__e2eEscapeProbe?.count ?? -1;
  });
}

/**
 * Marks the first and last focusable elements, once the surface has stopped
 * changing shape.
 *
 * Several of these dialogs paint a loading placeholder and fetch their
 * contents afterwards, and the rows that arrive carry buttons of their own. A
 * mark applied before that lands is attached to a node the next render throws
 * away, and the wrap then reads `null` for a reason that has nothing to do
 * with the wrap. Two consecutive readings agreeing is what says the fetch is
 * over; the marks left behind are the ones from the last reading.
 */
async function markFocusBoundaries(
  page: Page,
  dialogId: string,
): Promise<{ focusableCount: number }> {
  let previousCount = -1;
  let settledCount = -1;

  await expect.poll(async () => {
    const { focusableCount } = await markFocusBoundariesOnce(page, dialogId);
    const stable = focusableCount > 0 && focusableCount === previousCount;
    previousCount = focusableCount;
    settledCount = focusableCount;
    return stable;
  }, {
    timeout: 15000,
    intervals: [300, 300, 300, 300, 500, 500, 1000, 1000],
  }).toBe(true);

  return { focusableCount: settledCount };
}

/**
 * One reading of the surface's focusable ends.
 *
 * The selector restates `getFocusableElements` in WindowDialog.tsx. The two
 * ends are what the component's wrap compares `document.activeElement` against,
 * so a test that guessed them from the DOM would be asserting against a
 * different pair than the one the component uses.
 */
async function markFocusBoundariesOnce(
  page: Page,
  dialogId: string,
): Promise<{ focusableCount: number }> {
  const reading = await page.evaluate((prefix) => {
    const surface = document.querySelector<HTMLElement>(
      `.window-dialog-surface[aria-labelledby^="${prefix}"]`,
    );
    if (surface === null) {
      return { focusableCount: 0 };
    }

    document.querySelectorAll('[data-e2e-focus-role]')
      .forEach(element => element.removeAttribute('data-e2e-focus-role'));

    const selector = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusable = Array.from(surface.querySelectorAll<HTMLElement>(selector))
      .filter(element => !element.hasAttribute('disabled') && element.offsetParent !== null);

    if (focusable.length >= 2) {
      focusable[0].setAttribute('data-e2e-focus-role', 'first');
      focusable[focusable.length - 1].setAttribute('data-e2e-focus-role', 'last');
    }

    return { focusableCount: focusable.length };
  }, dialogId);

  return reading;
}

async function readFocusRole(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-e2e-focus-role') ?? null);
}

/** Records where focus lands, and whether it was still inside the surface. */
async function installFocusTrail(page: Page, dialogId: string): Promise<void> {
  await page.evaluate((prefix) => {
    const surface = document.querySelector<HTMLElement>(
      `.window-dialog-surface[aria-labelledby^="${prefix}"]`,
    );
    const trail: { inSurface: boolean }[] = [];
    (window as unknown as { __e2eFocusTrail: { inSurface: boolean }[] }).__e2eFocusTrail = trail;

    document.addEventListener('focusin', (event) => {
      const target = event.target;
      trail.push({
        inSurface: surface !== null && target instanceof Node && surface.contains(target),
      });
    }, true);
  }, dialogId);
}

async function readFocusTrail(page: Page): Promise<{ inSurface: boolean }[]> {
  return page.evaluate(() => {
    return (window as unknown as { __e2eFocusTrail?: { inSurface: boolean }[] })
      .__e2eFocusTrail ?? [];
  });
}

/** Waits until the focused element is inside the named dialog's surface. */
async function expectFocusInside(page: Page, dialogId: string): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate((prefix) => {
      const surface = document.querySelector<HTMLElement>(
        `.window-dialog-surface[aria-labelledby^="${prefix}"]`,
      );
      return surface !== null
        && document.activeElement instanceof Node
        && surface.contains(document.activeElement);
    }, dialogId);
  }, { timeout: 10000 }).toBe(true);
}
