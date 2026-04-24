import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers';

type WorkspaceSetup = {
  workspaceId: string;
  workspaceName: string;
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

type CapturedWsMessage = {
  type?: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
};

declare global {
  interface Window {
    __buildergateCapturedWsMessages?: CapturedWsMessage[];
    __buildergateWsCaptureInstalled?: boolean;
    __buildergateOriginalWsSend?: WebSocket['send'];
    __buildergateTerminalDebug?: {
      enable: () => void;
      clear: () => void;
      getEvents: () => Array<{ kind: string }>;
    };
  }
}

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
        && !workspace.name?.startsWith('E2E Away ')
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

    const workspaceName = `E2E Equal Reorder ${Date.now()}`;
    const createWorkspaceRes = await request('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: workspaceName }),
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

    return { workspaceId: workspace.id, workspaceName: workspace.name ?? workspaceName, tabIds };
  }, tabCount);
}

async function createAuxWorkspace(page: Page): Promise<{ id: string; name: string }> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) {
      throw new Error('Missing auth token');
    }

    const res = await fetch('/api/workspaces', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `E2E Away ${Date.now().toString().slice(-8)}` }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create auxiliary workspace: ${res.status}`);
    }

    return res.json() as Promise<{ id: string; name: string }>;
  });
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

async function forceTabMode(page: Page, workspaceId: string): Promise<void> {
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
      body: JSON.stringify({ viewMode: 'tab' }),
    });

    if (!res.ok) {
      throw new Error(`Failed to force tab mode: ${res.status}`);
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

async function installWsMessageCapture(page: Page): Promise<void> {
  const install = () => {
    window.__buildergateCapturedWsMessages = [];
    if (window.__buildergateWsCaptureInstalled) {
      return;
    }
    window.__buildergateWsCaptureInstalled = true;

    window.__buildergateOriginalWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function patchedSend(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string') {
        try {
          window.__buildergateCapturedWsMessages?.push(JSON.parse(data) as CapturedWsMessage);
        } catch {
          // Ignore non-JSON frames.
        }
      }

      return window.__buildergateOriginalWsSend!.call(this, data);
    };
  };

  await page.addInitScript(install);
  await page.evaluate(install).catch(() => undefined);
}

async function clearWsMessageCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__buildergateCapturedWsMessages = [];
  });
}

async function readCapturedWsMessages(page: Page): Promise<CapturedWsMessage[]> {
  return page.evaluate(() => window.__buildergateCapturedWsMessages ?? []);
}

async function enableTerminalDebugCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__buildergateTerminalDebug?.enable();
    window.__buildergateTerminalDebug?.clear();
  });
}

async function hasTerminalDebugEvent(
  page: Page,
  kind: string,
  details?: Record<string, string | number | boolean | null>,
): Promise<boolean> {
  return page.evaluate(({ nextKind, expectedDetails }) => {
    return window.__buildergateTerminalDebug?.getEvents().some((event) => {
      if (event.kind !== nextKind) {
        return false;
      }
      if (!expectedDetails) {
        return true;
      }
      return Object.entries(expectedDetails).every(([key, value]) => event.details?.[key] === value);
    }) ?? false;
  }, { nextKind: kind, expectedDetails: details });
}

async function clearTerminalDebugCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__buildergateTerminalDebug?.clear();
  });
}

async function expectVisibleGridTerminal(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-view="true"]'))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    }).length), { timeout: 30000 }).toBeGreaterThan(0);
}

async function expectCapturedResizeBeforeRepairReplay(page: Page): Promise<void> {
  await expect.poll(async () => {
    const messages = await readCapturedWsMessages(page);
    return messages.some(message => message.type === 'repair-replay');
  }, { timeout: 10000 }).toBe(true);

  const messages = await readCapturedWsMessages(page);
  const repairIndex = messages.findIndex(message => message.type === 'repair-replay');
  const resizeIndex = messages.findIndex((message, index) => index < repairIndex && message.type === 'resize');

  expect(resizeIndex).toBeGreaterThanOrEqual(0);
  expect(repairIndex).toBeGreaterThan(resizeIndex);
}

async function selectWorkspaceByName(page: Page, workspaceName: string): Promise<void> {
  const option = page.getByRole('option', { name: workspaceName }).first();
  await option.click();
  await expect(option).toHaveAttribute('aria-selected', 'true');
}

async function sendVisibleTerminalCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('.terminal-view:visible .xterm-helper-textarea').first();
  await input.click();
  await page.keyboard.type(command, { delay: 0 });
  await page.keyboard.press('Enter');
}

async function middleMouseDownFirstVisibleTerminal(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-view="true"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
      });

    const target = targets.find((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const topElement = document.elementFromPoint(x, y);
      return topElement !== null && element.contains(topElement);
    }) ?? targets[0];

    if (!target) {
      throw new Error('Visible terminal view not found');
    }

    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });

  await page.mouse.click(point.x, point.y, { button: 'middle' });
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
      const target = targetWindow?.querySelector('.drop-target.reorder-target') as HTMLElement | null;

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
  await expect(page.locator(`[data-layout-mode-button="${mode}"]`).nth(tileIndex)).toBeVisible();
  await page.locator(`[data-layout-mode-button="${mode}"]`).nth(tileIndex).click();
}

async function collapseToolbar(page: Page, tileIndex: number): Promise<void> {
  const toolbar = page.locator('[data-grid-toolbar="true"]').nth(tileIndex);
  await toolbar.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
  });
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

  test('TC-6609: move button follows toolbar hover visibility', async ({ page }) => {
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);

    const moveButton = page.locator('[data-grid-move-button="true"]').first();

    await expect.poll(async () => moveButton.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    await expect.poll(async () => moveButton.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');

    await expandToolbar(page, 0);

    await expect.poll(async () => moveButton.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await expect.poll(async () => moveButton.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('auto');

    await collapseToolbar(page, 0);
    await page.waitForTimeout(350);

    await expect.poll(async () => moveButton.evaluate((element) => getComputedStyle(element).opacity)).toBe('0');
    await expect.poll(async () => moveButton.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('equal');
  });

  test('TC-6611: middle mouse repair performs resize before repair replay', async ({ page }) => {
    await installWsMessageCapture(page);
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await expectVisibleGridTerminal(page);
    await enableTerminalDebugCapture(page);
    await page.waitForTimeout(500);
    await clearWsMessageCapture(page);

    await middleMouseDownFirstVisibleTerminal(page);
    await expect.poll(async () => hasTerminalDebugEvent(page, 'grid_layout_repair_started', { reason: 'manual' }), { timeout: 5000 }).toBe(true);
    await expectCapturedResizeBeforeRepairReplay(page);
    await expect.poll(async () => hasTerminalDebugEvent(page, 'screen_snapshot_duplicate_reapplied_for_repair'), { timeout: 10000 }).toBe(true);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('equal');
  });

  test('TC-6612: workspace switch repair performs resize before repair replay', async ({ page }) => {
    await installWsMessageCapture(page);
    await login(page);
    const { workspaceId, workspaceName } = await setupEqualGridWorkspace(page, 4);
    const awayWorkspace = await createAuxWorkspace(page);

    await openGridWorkspace(page, workspaceId, 4);
    await expectVisibleGridTerminal(page);
    await enableTerminalDebugCapture(page);

    await selectWorkspaceByName(page, awayWorkspace.name);
    await page.waitForTimeout(500);
    await clearWsMessageCapture(page);
    await clearTerminalDebugCapture(page);

    await selectWorkspaceByName(page, workspaceName);
    await expectVisibleGridTerminal(page);

    await expect.poll(async () => hasTerminalDebugEvent(page, 'grid_layout_repair_started', { reason: 'workspace' }), { timeout: 10000 }).toBe(true);
    await expectCapturedResizeBeforeRepairReplay(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('equal');
  });

  test('TC-6613: running to idle repair performs resize before repair replay', async ({ page }) => {
    await installWsMessageCapture(page);
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await expectVisibleGridTerminal(page);
    await enableTerminalDebugCapture(page);
    await expect.poll(async () => hasTerminalDebugEvent(page, 'input_gate_synced', { inputReady: true }), { timeout: 30000 }).toBe(true);

    await page.waitForTimeout(500);
    await clearWsMessageCapture(page);
    await clearTerminalDebugCapture(page);
    await sendVisibleTerminalCommand(
      page,
      `Write-Host "$([char]27)]133;C$([char]7)"; Start-Sleep -Milliseconds 1000; Write-Host "$([char]27)]133;D;0$([char]7)"; echo TC6613-${Date.now()}`,
    );

    await expect.poll(async () => hasTerminalDebugEvent(page, 'grid_layout_repair_started', { reason: 'idle' }), { timeout: 30000 }).toBe(true);
    await expectCapturedResizeBeforeRepairReplay(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('equal');
  });

  test('TC-6614: tab mode middle mouse does not request grid repair', async ({ page }) => {
    await installWsMessageCapture(page);
    await login(page);
    const { workspaceId } = await setupEqualGridWorkspace(page, 1);
    await forceTabMode(page, workspaceId);
    await page.reload();
    await waitForWorkspaceScreen(page);
    await expectVisibleGridTerminal(page);
    await enableTerminalDebugCapture(page);
    await page.waitForTimeout(500);
    await clearWsMessageCapture(page);
    await clearTerminalDebugCapture(page);

    await middleMouseDownFirstVisibleTerminal(page);
    await page.waitForTimeout(500);

    expect(await hasTerminalDebugEvent(page, 'grid_layout_repair_started', { reason: 'manual' })).toBe(false);
    expect((await readCapturedWsMessages(page)).some(message => message.type === 'repair-replay')).toBe(false);
  });

  test('TC-6607: non-equal modes do not enter reorder', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutMode(page, 0, 'equal');
    await page.waitForTimeout(200);
    await expect(page.locator('.drop-target.reorder-target')).toHaveCount(0);
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('none');
    await nativeInvalidDrag(page, 0);
    await waitForLayoutPersist(page);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await setLayoutMode(page, 0, 'focus');
    await page.waitForTimeout(200);
    await expect(page.locator('.drop-target.reorder-target')).toHaveCount(0);
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('focus');
    await nativeInvalidDrag(page, 0);
    await waitForLayoutPersist(page);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await setLayoutMode(page, 0, 'auto');
    await page.waitForTimeout(200);
    await expect(page.locator('.drop-target.reorder-target')).toHaveCount(0);
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('auto');
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);
  });

  test('TC-6610: mode transitions keep the move handle drag-active across equal focus and auto', async ({ page }) => {
    await login(page);
    const { workspaceId, tabIds } = await setupEqualGridWorkspace(page, 4);
    await openGridWorkspace(page, workspaceId, 4);
    await prepareGridForNativeDrag(page);

    await setLayoutMode(page, 0, 'focus');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('focus');

    const focusDrag = await measureSourceRectDuringInvalidDrag(page, 0);
    expectRectsToMatch(focusDrag.during, focusDrag.before);
    expectRectsToMatch(focusDrag.after, focusDrag.before);
    expect(focusDrag.previewCount).toBeGreaterThan(0);
    expect(focusDrag.splitTargetCount).toBeGreaterThan(0);
    expect(focusDrag.reorderTargetCount).toBe(0);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await setLayoutMode(page, 0, 'auto');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('auto');

    const autoDrag = await measureSourceRectDuringInvalidDrag(page, 0);
    expectRectsToMatch(autoDrag.during, autoDrag.before);
    expectRectsToMatch(autoDrag.after, autoDrag.before);
    expect(autoDrag.previewCount).toBeGreaterThan(0);
    expect(autoDrag.splitTargetCount).toBeGreaterThan(0);
    expect(autoDrag.reorderTargetCount).toBe(0);
    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual(tabIds);

    await setLayoutMode(page, 0, 'equal');
    await waitForLayoutPersist(page);
    expect((await readPersistedLayout(page, workspaceId))?.mode).toBe('equal');

    await nativeReorderDrag(page, 0, 3);
    await waitForLayoutPersist(page);

    expect(await readPersistedLeafOrder(page, workspaceId)).toEqual([
      ...tabIds.slice(1),
      tabIds[0],
    ]);
    expectUniformGrid(await readGridCells(page));
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
});
