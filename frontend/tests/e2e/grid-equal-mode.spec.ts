import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers';

type WorkspaceSetup = {
  workspaceId: string;
  tabIds: string[];
};

type RectSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type GridCellSnapshot = {
  label: string;
  width: number;
  height: number;
};

type ReorderDragResult = {
  hovered: boolean;
  targetRect: RectSnapshot;
  guideRect: RectSnapshot;
};

type DragStartOffset = {
  x: number;
  y: number;
};

type SplitEdge = 'left' | 'right' | 'top' | 'bottom';

type NonEqualDropTarget =
  | { kind: 'cell'; targetWindowIndex: number; edge: SplitEdge }
  | { kind: 'root-edge'; edge: SplitEdge };

type NonEqualSplitDragResult = {
  hovered: boolean;
  targetRect: RectSnapshot;
  overlayRect: RectSnapshot | null;
  movedRectAfterDrop: RectSnapshot | null;
  sourceTabId: string | null;
  sourceRectBeforeDrag: RectSnapshot;
};

function extractLeafIds(node: unknown): string[] {
  if (typeof node === 'string') {
    return [node];
  }

  if (!node || typeof node !== 'object') {
    return [];
  }

  const parent = node as { first: unknown; second: unknown };
  return [...extractLeafIds(parent.first), ...extractLeafIds(parent.second)];
}

async function setupEqualGridWorkspace(page: Page, tabCount: number): Promise<WorkspaceSetup> {
  return page.evaluate(async (count: number) => {
    type WorkspaceResponse = { id: string; name?: string };
    type TabResponse = { id: string; workspaceId: string };
    type WorkspaceStateResponse = {
      workspaces: WorkspaceResponse[];
      tabs: TabResponse[];
    };

    const token = localStorage.getItem('cws_auth_token');
    if (!token) {
      throw new Error('Missing auth token');
    }

    const request = async (input: string, init: RequestInit = {}): Promise<Response> => {
      const headers = {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      };
      return fetch(input, { ...init, headers });
    };

    const buildLinearTree = (
      ids: string[],
      direction: 'row' | 'column',
    ): string | { direction: 'row' | 'column'; first: unknown; second: unknown; splitPercentage: number } => {
      if (ids.length === 1) return ids[0];
      if (ids.length === 2) {
        return { direction, first: ids[0], second: ids[1], splitPercentage: 50 };
      }

      const mid = Math.ceil(ids.length / 2);
      return {
        direction,
        first: buildLinearTree(ids.slice(0, mid), direction),
        second: buildLinearTree(ids.slice(mid), direction),
        splitPercentage: (mid / ids.length) * 100,
      };
    };

    const buildEqualTree = (ids: string[]) => {
      if (ids.length === 0) {
        throw new Error('Cannot build equal tree without tabs');
      }
      if (ids.length === 1) {
        return ids[0];
      }

      const topCount = Math.ceil(ids.length / 2);
      const topIds = ids.slice(0, topCount);
      const bottomIds = ids.slice(topCount);

      if (bottomIds.length === 0) {
        return buildLinearTree(topIds, 'row');
      }

      return {
        direction: 'column' as const,
        first: buildLinearTree(topIds, 'row'),
        second: buildLinearTree(bottomIds, 'row'),
        splitPercentage: 50,
      };
    };

    const loadState = async (): Promise<WorkspaceStateResponse> => {
      const res = await request('/api/workspaces');
      if (!res.ok) {
        throw new Error(`Failed to load workspace state: ${res.status}`);
      }
      return res.json() as Promise<WorkspaceStateResponse>;
    };

    const initialState = await loadState();
    for (const workspace of initialState.workspaces) {
      if (
        !workspace.name?.startsWith('E2E Equal Reorder ')
        && !workspace.name?.startsWith('DBG Equal ')
      ) {
        continue;
      }

      const deleteRes = await request(`/api/workspaces/${workspace.id}`, {
        method: 'DELETE',
      });
      if (!deleteRes.ok) {
        throw new Error(`Failed to delete stale E2E workspace ${workspace.id}: ${deleteRes.status}`);
      }
    }

    const createWorkspaceRes = await request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: `E2E Equal Reorder ${Date.now()}` }),
    });
    if (!createWorkspaceRes.ok) {
      throw new Error(`Failed to create workspace: ${createWorkspaceRes.status}`);
    }

    const workspace = (await createWorkspaceRes.json()) as WorkspaceResponse;
    const refreshedState = await loadState();
    const tabs = refreshedState.tabs
      .filter(tab => tab.workspaceId === workspace.id)
      .map(tab => ({ id: tab.id }));

    for (let i = tabs.length; i < count; i += 1) {
      const addTabRes = await request(`/api/workspaces/${workspace.id}/tabs`, {
        method: 'POST',
        body: JSON.stringify({ name: `E2E-${i + 1}` }),
      });
      if (!addTabRes.ok) {
        throw new Error(`Failed to add tab ${i + 1}: ${addTabRes.status}`);
      }
      const tab = (await addTabRes.json()) as { id: string };
      tabs.push({ id: tab.id });
    }

    const tabIds = tabs.map(tab => tab.id);
    localStorage.setItem('active_workspace_id', workspace.id);
    localStorage.setItem(`mosaic_layout_${workspace.id}`, JSON.stringify({
      schemaVersion: 1,
      tree: buildEqualTree(tabIds),
      mode: 'equal',
      focusTarget: null,
      savedAt: new Date().toISOString(),
    }));

    const updateWorkspaceRes = await request(`/api/workspaces/${workspace.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        viewMode: 'grid',
        activeTabId: tabIds[tabIds.length - 1] ?? null,
      }),
    });
    if (!updateWorkspaceRes.ok) {
      throw new Error(`Failed to switch workspace to grid: ${updateWorkspaceRes.status}`);
    }

    return { workspaceId: workspace.id, tabIds };
  }, tabCount);
}

async function waitForWorkspaceScreen(page: Page): Promise<void> {
  const passwordField = page.locator('input[type="password"]');
  if (await passwordField.isVisible().catch(() => false)) {
    await passwordField.fill(process.env.BUILDERGATE_PASSWORD || '1234');
    await page.click('button[type="submit"]');
  }

  await page.waitForSelector('.workspace-screen', { timeout: 30000 });
}

async function forceGridMode(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async (nextWorkspaceId: string) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) {
      throw new Error('Missing auth token');
    }

    localStorage.setItem('active_workspace_id', nextWorkspaceId);

    const res = await fetch(`/api/workspaces/${nextWorkspaceId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ viewMode: 'grid' }),
    });

    if (!res.ok) {
      throw new Error(`Failed to force grid mode: ${res.status}`);
    }
  }, workspaceId);
}

async function openGridWorkspace(page: Page, workspaceId: string, expectedTileCount: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.reload();
    await waitForWorkspaceScreen(page);
    await forceGridMode(page, workspaceId);
    await page.reload();
    await waitForWorkspaceScreen(page);

    const tileCount = await page.locator('.mosaic-tile').count();
    if (tileCount === expectedTileCount) {
      return;
    }
  }

  await expect(page.locator('.mosaic-tile')).toHaveCount(expectedTileCount, { timeout: 30000 });
}

async function prepareGridForNativeDrag(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll(
      '[data-terminal-runtime-entry], .terminal-container, .terminal-view, .terminal-root, .xterm, .xterm-screen, .xterm-helpers, .xterm-helper-textarea, .xterm-viewport, .xterm-scroll-area, canvas',
    ).forEach((element) => {
      (element as HTMLElement).style.pointerEvents = 'none';
    });

    document.querySelectorAll('[data-grid-move-button="true"]').forEach((element) => {
      const handle = element as HTMLElement;
      handle.style.opacity = '1';
      handle.style.pointerEvents = 'auto';
    });
  });
}

async function nativeReorderDrag(
  page: Page,
  sourceIndex: number,
  targetWindowIndex: number,
  sourceOffset: DragStartOffset = { x: 14, y: 14 },
): Promise<ReorderDragResult> {
  return page.evaluate(
    async ({ nextSourceIndex, nextTargetWindowIndex, nextSourceOffset }) => {
      const source = document.querySelectorAll('[data-grid-move-button="true"]')[nextSourceIndex] as HTMLElement | undefined;
      const targetWindow = document.querySelectorAll('.mosaic-window')[nextTargetWindowIndex] as HTMLElement | undefined;
      const target = targetWindow?.querySelector('.drop-target.reorder-target') as HTMLElement | null;

      if (!source || !target || !targetWindow) {
        throw new Error('Reorder source or target not found');
      }

      const dataTransfer = new DataTransfer();
      const sourceRect = source.getBoundingClientRect();
      const clientX = sourceRect.x + nextSourceOffset.x;
      const clientY = sourceRect.y + nextSourceOffset.y;

      const firePointer = (element: HTMLElement, type: string, button: number) =>
        element.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button,
          buttons: button === 0 ? 1 : 0,
          clientX,
          clientY,
        }));

      const fireMouse = (element: HTMLElement, type: string, button: number) =>
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button,
          buttons: button === 0 ? 1 : 0,
          clientX,
          clientY,
        }));

      const fireDrag = (element: HTMLElement, type: string) =>
        element.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

      firePointer(source, 'pointerdown', 0);
      fireMouse(source, 'mousedown', 0);
      fireDrag(source, 'dragstart');
      fireDrag(target, 'dragenter');
      fireDrag(target, 'dragover');

      await new Promise(resolve => setTimeout(resolve, 50));

      const targetRect = targetWindow.getBoundingClientRect();
      const guideRect = target.getBoundingClientRect();
      const hovered = target.classList.contains('drop-target-hover');

      fireDrag(target, 'drop');
      fireDrag(source, 'dragend');

      await new Promise(resolve => setTimeout(resolve, 1200));

      return {
        hovered,
        targetRect: {
          x: Math.round(targetRect.x),
          y: Math.round(targetRect.y),
          width: Math.round(targetRect.width),
          height: Math.round(targetRect.height),
        },
        guideRect: {
          x: Math.round(guideRect.x),
          y: Math.round(guideRect.y),
          width: Math.round(guideRect.width),
          height: Math.round(guideRect.height),
        },
      };
    },
    { nextSourceIndex: sourceIndex, nextTargetWindowIndex: targetWindowIndex, nextSourceOffset: sourceOffset },
  );
}

async function nativeInvalidDrag(page: Page, sourceIndex: number): Promise<void> {
  await page.evaluate(async (nextSourceIndex: number) => {
    const source = document.querySelectorAll('[data-grid-move-button="true"]')[nextSourceIndex] as HTMLElement | undefined;
    if (!source) {
      throw new Error('Drag source not found');
    }

    const sourceRect = source.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    const firePointer = (element: HTMLElement, type: string) =>
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: sourceRect.x + sourceRect.width / 2,
        clientY: sourceRect.y + sourceRect.height / 2,
      }));
    const fireMouse = (element: HTMLElement, type: string) =>
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: sourceRect.x + sourceRect.width / 2,
        clientY: sourceRect.y + sourceRect.height / 2,
      }));
    const fireDrag = (element: HTMLElement, type: string) =>
      element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));

    firePointer(source, 'pointerdown');
    fireMouse(source, 'mousedown');
    fireDrag(source, 'dragstart');
    fireDrag(source, 'dragend');

    await new Promise(resolve => setTimeout(resolve, 1200));
  }, sourceIndex);
}

async function measureSourceRectDuringInvalidDrag(
  page: Page,
  sourceIndex: number,
): Promise<{
  before: RectSnapshot;
  during: RectSnapshot;
  after: RectSnapshot;
  previewCount: number;
  draggingContainerCount: number;
  splitTargetCount: number;
  reorderTargetCount: number;
}> {
  return page.evaluate(async (nextSourceIndex: number) => {
    const source = document.querySelectorAll('[data-grid-move-button="true"]')[nextSourceIndex] as HTMLElement | undefined;
    const sourceWindow = source?.closest('.mosaic-window') as HTMLElement | null;
    if (!source || !sourceWindow) {
      throw new Error('Drag source window not found');
    }

    const sourceRect = source.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    const readRect = () => {
      const rect = sourceWindow.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    const firePointer = (element: HTMLElement, type: string) =>
      element.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: sourceRect.x + sourceRect.width / 2,
        clientY: sourceRect.y + sourceRect.height / 2,
      }));
    const fireMouse = (element: HTMLElement, type: string) =>
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX: sourceRect.x + sourceRect.width / 2,
        clientY: sourceRect.y + sourceRect.height / 2,
      }));
    const fireDrag = (element: HTMLElement, type: string) =>
      element.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));

    const before = readRect();
    firePointer(source, 'pointerdown');
    fireMouse(source, 'mousedown');
    fireDrag(source, 'dragstart');
    await new Promise(resolve => setTimeout(resolve, 150));
    const during = readRect();
    const previewCount = document.querySelectorAll('.mosaic-preview').length;
    const draggingContainerCount = document.querySelectorAll('.drop-target-container.-dragging').length;
    const splitTargetCount = document.querySelectorAll('.drop-target:not(.reorder-target)').length;
    const reorderTargetCount = document.querySelectorAll('.drop-target.reorder-target').length;
    fireDrag(source, 'dragend');
    await new Promise(resolve => setTimeout(resolve, 150));
    const after = readRect();

    return {
      before,
      during,
      after,
      previewCount,
      draggingContainerCount,
      splitTargetCount,
      reorderTargetCount,
    };
  }, sourceIndex);
}

async function nativeNonPrimaryDrag(page: Page, sourceIndex: number, targetWindowIndex: number): Promise<void> {
  await page.evaluate(
    async ({ nextSourceIndex, nextTargetWindowIndex }) => {
      const source = document.querySelectorAll('[data-grid-move-button="true"]')[nextSourceIndex] as HTMLElement | undefined;
      const targetWindow = document.querySelectorAll('.mosaic-window')[nextTargetWindowIndex] as HTMLElement | undefined;
      const target =
        targetWindow?.querySelector('.drop-target.reorder-target') as HTMLElement | null
        || targetWindow?.querySelector('.drop-target.left:not(.reorder-target)') as HTMLElement | null;

      if (!source || !target) {
        throw new Error('Non-primary drag source or target not found');
      }

      const sourceRect = source.getBoundingClientRect();
      const dataTransfer = new DataTransfer();

      const firePointer = (element: HTMLElement, type: string, button: number) =>
        element.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button,
          buttons: 0,
          clientX: sourceRect.x + sourceRect.width / 2,
          clientY: sourceRect.y + sourceRect.height / 2,
        }));

      const fireMouse = (element: HTMLElement, type: string, button: number) =>
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button,
          buttons: 0,
          clientX: sourceRect.x + sourceRect.width / 2,
          clientY: sourceRect.y + sourceRect.height / 2,
        }));

      const fireDrag = (element: HTMLElement, type: string) =>
        element.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

      firePointer(source, 'pointerdown', 2);
      fireMouse(source, 'mousedown', 2);
      fireDrag(source, 'dragstart');
      fireDrag(target, 'dragenter');
      fireDrag(target, 'dragover');
      fireDrag(target, 'drop');
      fireDrag(source, 'dragend');

      await new Promise(resolve => setTimeout(resolve, 1200));
    },
    { nextSourceIndex: sourceIndex, nextTargetWindowIndex: targetWindowIndex },
  );
}

async function expandToolbar(page: Page, tileIndex: number): Promise<void> {
  const toolbar = page.locator('[data-grid-toolbar="true"]').nth(tileIndex);
  await toolbar.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('[data-grid-mode-controls="true"]').nth(tileIndex)).toBeVisible();
}

async function nativeModeButtonDrag(
  page: Page,
  sourceIndex: number,
  mode: 'equal' | 'focus' | 'auto',
  targetWindowIndex: number,
): Promise<void> {
  await page.evaluate(
    async ({ nextSourceIndex, nextMode, nextTargetWindowIndex }) => {
      const source = document.querySelectorAll(`[data-layout-mode-button="${nextMode}"]`)[nextSourceIndex] as HTMLElement | undefined;
      const targetWindow = document.querySelectorAll('.mosaic-window')[nextTargetWindowIndex] as HTMLElement | undefined;
      const target = targetWindow?.querySelector('.drop-target.reorder-target') as HTMLElement | null;

      if (!source || !target) {
        throw new Error('Toolbar surface source or target not found');
      }

      const sourceRect = source.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      const firePointer = (element: HTMLElement, type: string) =>
        element.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: sourceRect.x + 12,
          clientY: sourceRect.y + 12,
        }));
      const fireMouse = (element: HTMLElement, type: string) =>
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          clientX: sourceRect.x + 12,
          clientY: sourceRect.y + 12,
        }));
      const fireDrag = (element: HTMLElement, type: string) =>
        element.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

      firePointer(source, 'pointerdown');
      fireMouse(source, 'mousedown');
      fireDrag(source, 'dragstart');
      fireDrag(target, 'dragenter');
      fireDrag(target, 'dragover');
      fireDrag(target, 'drop');
      fireDrag(source, 'dragend');

      await new Promise(resolve => setTimeout(resolve, 1200));
    },
    { nextSourceIndex: sourceIndex, nextMode: mode, nextTargetWindowIndex: targetWindowIndex },
  );
}

async function runNonEqualSplitDragCase(
  page: Page,
  sourceIndex: number,
  target: NonEqualDropTarget,
  options?: {
    commit?: boolean;
    preArmStatusByTabId?: Record<string, 'running' | 'idle' | 'disconnected'>;
    statusByTabId?: Record<string, 'running' | 'idle' | 'disconnected'>;
  },
): Promise<NonEqualSplitDragResult> {
  const commit = options?.commit ?? true;
  return page.evaluate(
    async ({ nextSourceIndex, nextTarget, nextCommit, nextPreArmStatusByTabId, nextStatusByTabId }) => {
      const readRect = (element: Element | null): RectSnapshot | null => {
        if (!(element instanceof HTMLElement)) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const findTarget = (): HTMLElement | null => {
        if (nextTarget.kind === 'cell') {
          const targetWindow = document.querySelectorAll('.mosaic-window')[nextTarget.targetWindowIndex] as HTMLElement | undefined;
          return targetWindow?.querySelector(`.drop-target.${nextTarget.edge}:not(.reorder-target)`) as HTMLElement | null;
        }
        return document.querySelector(`.mosaic.mosaic-drop-target > .drop-target-container .drop-target.${nextTarget.edge}:not(.reorder-target)`) as HTMLElement | null;
      };
      const findTileByTabId = (tabId: string | null): HTMLElement | null => {
        if (!tabId) {
          return null;
        }
        return document.querySelector(`.grid-cell[data-grid-tab-id="${tabId}"]`) as HTMLElement | null;
      };

      const source = document.querySelectorAll('[data-grid-move-button="true"]')[nextSourceIndex] as HTMLElement | undefined;
      const sourceWindow = source?.closest('.mosaic-window');
      const sourceToolbar = source?.closest('[data-grid-toolbar-tab-id]') as HTMLElement | null;
      const targetElement = findTarget();
      if (!source || !sourceWindow || !sourceToolbar || !targetElement) {
        throw new Error('Non-equal source or target not found');
      }

      const testApiWindow = window as Window & {
        __PM_TEST_API__?: {
          grid?: {
            injectAutoStatusChange?: (payload: {
              statusByTabId: Record<string, 'running' | 'idle' | 'disconnected'>;
            }) => void;
          };
        };
      };
      const injectStatus = (statusByTabId: Record<string, 'running' | 'idle' | 'disconnected'> | null) => {
        if (statusByTabId && Object.keys(statusByTabId).length > 0) {
          testApiWindow.__PM_TEST_API__?.grid?.injectAutoStatusChange?.({ statusByTabId });
        }
      };

      injectStatus(nextPreArmStatusByTabId);
      if (nextPreArmStatusByTabId && Object.keys(nextPreArmStatusByTabId).length > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      const sourceRect = source.getBoundingClientRect();
      const sourceRectBeforeDrag = readRect(sourceWindow);
      const sourceTabId = sourceToolbar.dataset.gridToolbarTabId ?? null;
      const dataTransfer = new DataTransfer();
      const firePointer = (element: HTMLElement, type: string, button = 0) =>
        element.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button,
          buttons: button === 0 ? 1 : 0,
          clientX: sourceRect.x + sourceRect.width / 2,
          clientY: sourceRect.y + sourceRect.height / 2,
        }));
      const fireMouse = (element: HTMLElement, type: string, button = 0) =>
        element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button,
          buttons: button === 0 ? 1 : 0,
          clientX: sourceRect.x + sourceRect.width / 2,
          clientY: sourceRect.y + sourceRect.height / 2,
        }));
      const fireDrag = (element: HTMLElement, type: string) =>
        element.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }));

      firePointer(source, 'pointerdown');
      fireMouse(source, 'mousedown');
      fireDrag(source, 'dragstart');
      fireDrag(targetElement, 'dragenter');
      fireDrag(targetElement, 'dragover');

      injectStatus(nextStatusByTabId);

      await new Promise(resolve => setTimeout(resolve, 200));
      if (!document.querySelector('[data-grid-predictive-overlay="true"]')) {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }

      const hovered = targetElement.classList.contains('drop-target-hover');
      const targetRect = readRect(targetElement);
      const overlayRect = readRect(document.querySelector('[data-grid-predictive-overlay="true"]'));

      if (!targetRect) {
        throw new Error('Target rect missing');
      }

      if (nextCommit) {
        fireDrag(targetElement, 'drop');
      }
      fireDrag(source, 'dragend');

      await new Promise(resolve => setTimeout(resolve, 1200));

      return {
        hovered,
        targetRect,
        overlayRect,
        movedRectAfterDrop: nextCommit ? readRect(findTileByTabId(sourceTabId)) : null,
        sourceTabId,
        sourceRectBeforeDrag: sourceRectBeforeDrag ?? targetRect,
      };
    },
    {
      nextSourceIndex: sourceIndex,
      nextTarget: target,
      nextCommit: commit,
      nextPreArmStatusByTabId: options?.preArmStatusByTabId ?? null,
      nextStatusByTabId: options?.statusByTabId ?? null,
    },
  );
}

async function waitForLayoutPersist(page: Page): Promise<void> {
  await page.waitForTimeout(2500);
}

async function readGridCells(page: Page): Promise<GridCellSnapshot[]> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.mosaic-tile')).map((tile) => {
      const rect = tile.getBoundingClientRect();
      const label =
        tile.querySelector('.metadata-row')?.textContent?.trim().split('│')[0].trim() ??
        tile.textContent?.trim() ??
        '';

      return {
        label,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  });
}

async function readGridCellGeometry(page: Page): Promise<Array<{ width: number; height: number }>> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.mosaic-tile')).map((tile) => {
      const rect = tile.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  });
}

async function readTileRectByTabId(page: Page, tabId: string | null): Promise<RectSnapshot | null> {
  return page.evaluate((targetTabId: string | null) => {
    if (!targetTabId) {
      return null;
    }
    const tile = document.querySelector(`.grid-cell[data-grid-tab-id="${targetTabId}"]`);
    if (!(tile instanceof HTMLElement)) {
      return null;
    }
    const rect = tile.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, tabId);
}

async function readPersistedLayout(
  page: Page,
  workspaceId: string,
): Promise<{ mode: string; tree: unknown } | null> {
  return page.evaluate((nextWorkspaceId: string) => {
    const raw = localStorage.getItem(`mosaic_layout_${nextWorkspaceId}`);
    return raw ? JSON.parse(raw) : null;
  }, workspaceId);
}

async function readPersistedLeafOrder(page: Page, workspaceId: string): Promise<string[]> {
  const persisted = await readPersistedLayout(page, workspaceId);
  return persisted?.tree ? extractLeafIds(persisted.tree) : [];
}

async function forcePersistedLayoutMode(
  page: Page,
  workspaceId: string,
  mode: 'equal' | 'focus' | 'auto' | 'none',
  focusTarget: string | null = null,
): Promise<void> {
  await page.evaluate(({ nextWorkspaceId, nextMode, nextFocusTarget }) => {
    const raw = localStorage.getItem(`mosaic_layout_${nextWorkspaceId}`);
    if (!raw) {
      throw new Error('Persisted layout not found');
    }
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      tree: unknown;
      mode: string;
      focusTarget: string | null;
      savedAt: string;
    };
    parsed.mode = nextMode;
    parsed.focusTarget = nextMode === 'focus' ? nextFocusTarget : null;
    parsed.savedAt = new Date().toISOString();
    localStorage.setItem(`mosaic_layout_${nextWorkspaceId}`, JSON.stringify(parsed));
  }, { nextWorkspaceId: workspaceId, nextMode: mode, nextFocusTarget: focusTarget });
}

async function setLayoutModeViaTestApi(
  page: Page,
  mode: 'equal' | 'focus' | 'auto' | 'none',
  focusTarget: string | null = null,
): Promise<void> {
  await page.evaluate(({ nextMode, nextFocusTarget }) => {
    const testApiWindow = window as Window & {
      __PM_TEST_API__?: {
        grid?: {
          setLayoutMode?: (payload: {
            mode: 'equal' | 'focus' | 'auto' | 'none';
            focusTarget?: string | null;
          }) => void;
        };
      };
    };
    const setLayoutMode = testApiWindow.__PM_TEST_API__?.grid?.setLayoutMode;
    if (!setLayoutMode) {
      throw new Error('setLayoutMode test API is not available');
    }
    setLayoutMode({
      mode: nextMode,
      focusTarget: nextFocusTarget,
    });
  }, { nextMode: mode, nextFocusTarget: focusTarget });
}

async function addWorkspaceTab(page: Page, workspaceId: string, name: string): Promise<string> {
  return page.evaluate(async ({ nextWorkspaceId, nextName }) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) {
      throw new Error('Missing auth token');
    }

    const res = await fetch(`/api/workspaces/${nextWorkspaceId}/tabs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: nextName }),
    });

    if (!res.ok) {
      throw new Error(`Failed to add workspace tab: ${res.status}`);
    }

    const tab = (await res.json()) as { id: string };
    return tab.id;
  }, { nextWorkspaceId: workspaceId, nextName: name });
}

async function deleteWorkspaceTab(page: Page, workspaceId: string, tabId: string): Promise<void> {
  await page.evaluate(async ({ nextWorkspaceId, nextTabId }) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) {
      throw new Error('Missing auth token');
    }

    const res = await fetch(`/api/workspaces/${nextWorkspaceId}/tabs/${nextTabId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to delete workspace tab: ${res.status}`);
    }
  }, { nextWorkspaceId: workspaceId, nextTabId: tabId });
}

function expectUniformGrid(cells: GridCellSnapshot[], tolerance = 2): void {
  expect(cells.length).toBeGreaterThan(1);
  const baselineWidth = cells[0].width;
  const baselineHeight = cells[0].height;

  for (const cell of cells) {
    expect(Math.abs(cell.width - baselineWidth)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(cell.height - baselineHeight)).toBeLessThanOrEqual(tolerance);
  }
}

function expectAllCellsVisible(cells: GridCellSnapshot[]): void {
  for (const cell of cells) {
    expect(cell.width).toBeGreaterThan(0);
    expect(cell.height).toBeGreaterThan(0);
  }
}

function expectRectsToMatch(actual: RectSnapshot, expected: RectSnapshot, tolerance = 2): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(tolerance);
}

async function setLayoutMode(page: Page, tileIndex: number, mode: 'equal' | 'focus' | 'auto'): Promise<void> {
  const toolbar = page.locator('[data-grid-toolbar="true"]').nth(tileIndex);
  await toolbar.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
  });
  const button = toolbar.locator(`[data-layout-mode-button="${mode}"]`);
  await expect(button).toBeVisible();
  await button.click();
}

test.describe('Grid Equal Mode Reorder', () => {
  test('TC-6599: equal drag start keeps source geometry stable before drop', async ({ page }) => {
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    const rects = await measureSourceRectDuringInvalidDrag(page, 0);
    expectRectsToMatch(rects.during, rects.before);
    expectRectsToMatch(rects.after, rects.before);
    expect(rects.previewCount).toBeGreaterThan(0);
    expect(rects.reorderTargetCount).toBeGreaterThan(0);
  });

  test('TC-6600: none-mode drag start keeps source geometry stable before drop', async ({ page }) => {
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutMode(page, 0, 'equal');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('none');

    const rects = await measureSourceRectDuringInvalidDrag(page, 0);
    expectRectsToMatch(rects.during, rects.before);
    expectRectsToMatch(rects.after, rects.before);
    expect(rects.previewCount).toBeGreaterThan(0);
    expect(rects.draggingContainerCount).toBeGreaterThan(0);
    expect(rects.splitTargetCount).toBeGreaterThan(0);
  });

  test('TC-6601: equal mode uses move semantics and full-cell guide', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    expectUniformGrid(await readGridCells(page));

    const drag = await nativeReorderDrag(page, 0, 3);
    expect(drag.hovered).toBeTruthy();
    expectRectsToMatch(drag.guideRect, drag.targetRect);

    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual([
      ...tabIds.slice(1),
      tabIds[0],
    ]);
    expectUniformGrid(await readGridCells(page));
  });

  test('TC-6602: self-drop is a no-op', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await nativeReorderDrag(page, 0, 0);
    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
    expectUniformGrid(await readGridCells(page));
  });

  test('TC-6603: outside-target drop restores the pre-drag tree', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await nativeInvalidDrag(page, 0);
    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
    const cells = await readGridCells(page);
    expectUniformGrid(cells);
    expectAllCellsVisible(cells);
  });

  test('TC-6604: right-click and non-primary pointer do not trigger reorder', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);

    await page.evaluate(() => {
      const cell = document.querySelector('.grid-cell');
      if (!cell) {
        throw new Error('Grid cell not found');
      }
      const rect = (cell as HTMLElement).getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: rect.x + 12,
        clientY: rect.y + 12,
      }));
    });
    await expect(page.locator('.context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await prepareGridForNativeDrag(page);
    await nativeNonPrimaryDrag(page, 0, 3);
    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
  });

  test('TC-6605: move button shell padding and edge remain draggable', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await nativeReorderDrag(page, 0, 3, { x: 2, y: 2 });
    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual([
      ...tabIds.slice(1),
      tabIds[0],
    ]);
    expectUniformGrid(await readGridCells(page));
  });

  test('TC-6606: mode buttons stay click-only and do not start reorder', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);
    await expandToolbar(page, 0);

    await nativeModeButtonDrag(page, 0, 'equal', 3);
    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('equal');
  });

  test('TC-6607: non-equal modes do not enter reorder', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutModeViaTestApi(page, 'none');
    await waitForLayoutPersist(page);
    await expect(page.locator('.drop-target.reorder-target')).toHaveCount(0);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('none');
    await nativeInvalidDrag(page, 0);
    await waitForLayoutPersist(page);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await setLayoutModeViaTestApi(page, 'focus', tabIds[0]);
    await waitForLayoutPersist(page);
    await expect(page.locator('.drop-target.reorder-target')).toHaveCount(0);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('focus');
    await nativeInvalidDrag(page, 0);
    await waitForLayoutPersist(page);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await setLayoutModeViaTestApi(page, 'auto');
    await waitForLayoutPersist(page);
    await expect(page.locator('.drop-target.reorder-target')).toHaveCount(0);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('auto');
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
  });

  test('TC-6608: equal reorder order persists across reload/add/remove', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);
    await nativeReorderDrag(page, 0, 3);
    await waitForLayoutPersist(page);

    const reordered = [...tabIds.slice(1), tabIds[0]];
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(reordered);

    await openGridWorkspace(page, workspaceId, 4);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(reordered);
    expectUniformGrid(await readGridCells(page));

    await deleteWorkspaceTab(page, workspaceId, tabIds[2]);
    await openGridWorkspace(page, workspaceId, 3);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual([
      tabIds[1],
      tabIds[3],
      tabIds[0],
    ]);

    const newTabId = await addWorkspaceTab(page, workspaceId, 'E2E-5');
    await openGridWorkspace(page, workspaceId, 4);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual([
      tabIds[1],
      tabIds[3],
      tabIds[0],
      newTabId,
    ]);
  });

  test('TC-6609: none mode predictive overlay matches cell split target and completes drop', async ({ page }) => {
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutModeViaTestApi(page, 'none');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('none');

    const result = await runNonEqualSplitDragCase(page, 3, { kind: 'cell', targetWindowIndex: 0, edge: 'left' });
    expect(result.hovered).toBeTruthy();
    expect(result.overlayRect).not.toBeNull();
    expectRectsToMatch(result.overlayRect!, result.targetRect);
    expect(result.movedRectAfterDrop).not.toBeNull();
  });

  test('TC-6610: none mode predictive overlay matches root edge target and completes drop', async ({ page }) => {
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutModeViaTestApi(page, 'none');
    await waitForLayoutPersist(page);

    const result = await runNonEqualSplitDragCase(page, 3, { kind: 'root-edge', edge: 'left' });
    expect(result.hovered).toBeTruthy();
    expect(result.overlayRect).not.toBeNull();
    expectRectsToMatch(result.overlayRect!, result.targetRect);
    expect(result.movedRectAfterDrop).not.toBeNull();
  });

  test('TC-6611: focus mode keeps predictive overlay immediate and preserves focus mode after drop', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutModeViaTestApi(page, 'focus', tabIds[0]);
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('focus');

    const result = await runNonEqualSplitDragCase(page, 3, { kind: 'cell', targetWindowIndex: 1, edge: 'top' });
    expect(result.hovered).toBeTruthy();
    expect(result.overlayRect).not.toBeNull();
    expectRectsToMatch(result.overlayRect!, result.targetRect);
    expect(result.movedRectAfterDrop).not.toBeNull();
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('focus');
  });

  test('TC-6612: auto mode pauses status-driven rebalance during drag and resumes after drop', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutModeViaTestApi(page, 'auto');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('auto');

    const result = await runNonEqualSplitDragCase(
      page,
      0,
      { kind: 'cell', targetWindowIndex: 1, edge: 'right' },
      {
        preArmStatusByTabId: {
          [tabIds[0]]: 'running',
          [tabIds[1]]: 'idle',
          [tabIds[2]]: 'idle',
          [tabIds[3]]: 'idle',
        },
        statusByTabId: {
          [tabIds[0]]: 'running',
          [tabIds[1]]: 'idle',
          [tabIds[2]]: 'idle',
          [tabIds[3]]: 'idle',
        },
      },
    );

    expect(result.hovered).toBeTruthy();
    expect(result.overlayRect).not.toBeNull();
    expectRectsToMatch(result.overlayRect!, result.targetRect);
    expect(result.movedRectAfterDrop).not.toBeNull();
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('auto');

    const immediateCells = await readGridCells(page);
    await page.waitForTimeout(1800);
    const stabilizedRect = await readTileRectByTabId(page, result.sourceTabId);
    const stabilizedCells = await readGridCells(page);
    expect(stabilizedRect).not.toBeNull();
    expect(
      stabilizedCells.some((cell, index) =>
        Math.abs(cell.width - immediateCells[index].width) > 2
        || Math.abs(cell.height - immediateCells[index].height) > 2,
      ),
    ).toBeTruthy();
  });

  test('TC-6613: non-equal invalid and non-primary drags remain no-op', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutModeViaTestApi(page, 'none');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('none');
    const beforeInvalidLayout = await readPersistedLayout(page, workspaceId);
    const beforeInvalidCells = await readGridCellGeometry(page);

    await nativeInvalidDrag(page, 0);
    await waitForLayoutPersist(page);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
    expect((await readPersistedLayout(page, workspaceId))?.tree).toEqual(beforeInvalidLayout?.tree);
    expect(await readGridCellGeometry(page)).toEqual(beforeInvalidCells);

    const beforeNonPrimaryLayout = await readPersistedLayout(page, workspaceId);
    const beforeNonPrimaryCells = await readGridCellGeometry(page);
    await nativeNonPrimaryDrag(page, 0, 1);
    await waitForLayoutPersist(page);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
    expect((await readPersistedLayout(page, workspaceId))?.tree).toEqual(beforeNonPrimaryLayout?.tree);
    expect(await readGridCellGeometry(page)).toEqual(beforeNonPrimaryCells);
  });
});
