import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { getActiveSessionId, login, waitForTerminal } from './helpers';

type JsonFrame = Record<string, unknown> & {
  type?: string;
  sessionId?: string;
  data?: string;
  seq?: number;
  snapshotSeq?: number;
  cols?: number;
  rows?: number;
  replayToken?: string;
  sessionIds?: string[];
  mode?: string;
  truncated?: boolean;
  source?: string;
  authorityEpoch?: string;
  authorityRevision?: number;
  coversThroughSeq?: number;
};

type RoutedDirection = 'page-to-server' | 'server-to-page';

interface CapturedRoutedFrame {
  direction: RoutedDirection;
  connectionGeneration: number;
  message: JsonFrame | null;
}

interface ActiveRoute {
  pageRoute: WebSocketRoute;
  serverRoute: WebSocketRoute;
  connectionGeneration: number;
}

const RED_SIGNATURES = {
  ac4: 'Frontend stale/resync barrier RED 계약 RED AC-4: restore-needed did not engage the stale barrier, or snapshot-covered prefix/tail was lost, duplicated, or reordered',
  ac8: 'Frontend stale/resync barrier RED 계약 RED AC-8: restore-needed did not engage the stale barrier, or provisional local restore cleared hidden dirty/skipped/stale or promoted retained equivalence',
} as const;

class RoutedWsFaultHarness {
  readonly frames: CapturedRoutedFrame[] = [];
  private activeRoute: ActiveRoute | null = null;
  private nextConnectionGeneration = 0;

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws(?:\?|$)/, (pageRoute) => {
      const serverRoute = pageRoute.connectToServer();
      const connectionGeneration = ++this.nextConnectionGeneration;
      this.activeRoute = { pageRoute, serverRoute, connectionGeneration };

      pageRoute.onMessage((raw) => {
        this.frames.push({
          direction: 'page-to-server',
          connectionGeneration,
          message: parseJsonFrame(raw),
        });
        serverRoute.send(raw);
      });
      serverRoute.onMessage((raw) => {
        this.frames.push({
          direction: 'server-to-page',
          connectionGeneration,
          message: parseJsonFrame(raw),
        });
        pageRoute.send(raw);
      });
    });
  }

  get connectionCount(): number {
    return this.nextConnectionGeneration;
  }

  latestMessage(
    direction: RoutedDirection,
    predicate: (message: JsonFrame) => boolean,
    connectionGeneration?: number,
  ): JsonFrame | null {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      if (
        frame.direction === direction
        && (connectionGeneration === undefined || frame.connectionGeneration === connectionGeneration)
        && frame.message
        && predicate(frame.message)
      ) {
        return frame.message;
      }
    }
    return null;
  }

  injectToPage(message: JsonFrame): void {
    const active = this.activeRoute;
    if (!active) {
      throw new Error('E2E precondition failed: routed WebSocket is not connected');
    }
    active.pageRoute.send(JSON.stringify(message));
  }
}

function parseJsonFrame(raw: string | Buffer): JsonFrame | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as JsonFrame : null;
  } catch {
    return null;
  }
}

function isAuthoritativeSnapshot(message: JsonFrame, sessionId: string): boolean {
  return message.type === 'screen-snapshot'
    && message.sessionId === sessionId
    && message.mode === 'authoritative'
    && message.truncated === false
    && message.source === 'headless'
    && typeof message.data === 'string'
    && Number.isSafeInteger(message.seq)
    && Number(message.seq) >= 0;
}

async function startDebugCapture(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (targetSessionId) => {
    const debug = window.__buildergateTerminalDebug;
    if (!debug) {
      throw new Error('E2E precondition failed: terminal debug API is unavailable');
    }
    await debug.start(targetSessionId);
    if (!debug.isEnabled(targetSessionId)) {
      throw new Error('E2E precondition failed: terminal debug capture did not start');
    }
    debug.clear(targetSessionId);
  }, sessionId);
}

interface SeededTerminalTab {
  workspaceId: string;
  tabId: string;
}

const seededTerminalTabs: SeededTerminalTab[] = [];

/**
 * `login()` returns as soon as `.workspace-screen` is visible, and App renders
 * that container before the workspace list has been fetched. During that window
 * the no-workspace `EmptyState` is on screen with its `+ Add Terminal` button,
 * but `handleAddTab` reads an `activeWorkspaceId` that is still null, so the
 * click is a silent no-op — and on a workspace that does hold a terminal the
 * same button disappears the moment hydration lands. Branching on an
 * instantaneous `count()` therefore either seeds nothing or clicks an element
 * that is about to vanish. Wait for a hydrated workspace first, decide only
 * then, and confirm the seed actually produced a tab.
 */
async function ensureSeededTerminal(page: Page): Promise<void> {
  const terminal = page.locator('.xterm-screen:visible');
  const hydratedWorkspace = page.locator('[role="option"][aria-selected="true"]');
  await expect.poll(async () => (
    await terminal.count() > 0 || await hydratedWorkspace.count() > 0
  ), {
    message: 'E2E precondition failed: the workspace list never hydrated',
    timeout: 20_000,
  }).toBe(true);

  if (await terminal.count() > 0) {
    return;
  }

  const before = await readWorkspaceTabKeys(page);
  const addTerminal = page.getByRole('button', { name: '+ Add Terminal' });
  await expect.poll(() => addTerminal.count(), {
    message: 'E2E precondition failed: neither a terminal nor the empty state is present',
    timeout: 20_000,
  }).toBeGreaterThan(0);
  await addTerminal.first().click();

  await expect.poll(async () => (await readWorkspaceTabKeys(page)).length, {
    message: 'E2E precondition failed: seeding did not create a terminal tab',
    timeout: 20_000,
  }).toBeGreaterThan(before.length);

  for (const key of await readWorkspaceTabKeys(page)) {
    if (before.includes(key)) continue;
    const [workspaceId, tabId] = key.split('/');
    seededTerminalTabs.push({ workspaceId, tabId });
  }
}

/**
 * Every tab the server knows about, keyed `workspaceId/tabId`. Keying on the
 * pair rather than picking a workspace means the helper never has to guess
 * which workspace the click landed in — it owns whichever tab is new.
 */
async function readWorkspaceTabKeys(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) return [];
    const response = await fetch('/api/workspaces', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.tabs ?? []).map((tab: { id?: string; workspaceId?: string }) => (
      `${String(tab.workspaceId)}/${String(tab.id)}`
    ));
  });
}

async function releaseSeededTerminalTabs(page: Page): Promise<void> {
  if (seededTerminalTabs.length === 0) return;
  const owned = seededTerminalTabs.splice(0, seededTerminalTabs.length);
  await page.evaluate(async (tabs) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    for (const tab of tabs) {
      await fetch(`/api/workspaces/${tab.workspaceId}/tabs/${tab.tabId}`, { method: 'DELETE', headers })
        .catch(() => undefined);
    }
  }, owned);
}

async function establishTerminalHarness(page: Page, harness: RoutedWsFaultHarness): Promise<string> {
  await harness.install(page);
  await login(page);
  await ensureSeededTerminal(page);
  await waitForTerminal(page);
  await expect.poll(() => harness.connectionCount, {
    message: 'E2E precondition failed: no real routed WebSocket connection',
    timeout: 10_000,
  }).toBeGreaterThan(0);

  const sessionId = await getActiveSessionId(page);
  expect(sessionId, 'E2E precondition failed: active terminal session is unavailable').not.toBeNull();
  await startDebugCapture(page, sessionId!);
  return sessionId!;
}

async function readDebugEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => {
    return window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? [];
  }, sessionId);
}

async function expectRestoreBarrier(
  page: Page,
  sessionId: string,
  signature: string,
): Promise<void> {
  try {
    await expect.poll(async () => {
      const events = await readDebugEvents(page, sessionId);
      return events.some((event) => (
        event.kind === 'input_transport_state_synced'
        && event.details?.serverReady === false
        && event.details?.barrierReason === 'visible-output-recovery'
        && event.details?.reason === 'screen-repair-restore-needed'
      ));
    }, { message: signature, timeout: 5_000 }).toBe(true);
  } catch (error) {
    const diagnostic = (await readDebugEvents(page, sessionId))
      .filter((event) => (
        event.kind.includes('resync')
        || event.kind.includes('screen_repair')
        || event.kind === 'input_transport_state_synced'
      ))
      .slice(-20)
      .map((event) => ({ kind: event.kind, details: event.details }));
    console.error('restore barrier diagnostic', diagnostic);
    throw error;
  }
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.locator('.terminal-view:visible .xterm-rows').first().textContent().then((value) => (
    value ?? ''
  )).then((value) => value.replace(/\u00a0/g, ' '));
}

function countOccurrences(value: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(marker, offset);
    if (index < 0) break;
    count += 1;
    offset = index + marker.length;
  }
  return count;
}

interface ResyncAuthorityProof {
  authorityEpoch: string;
  authorityRevision: number;
  coversThroughSeq: number;
}

/**
 * The client ignores a `screen-repair:restore-needed` frame — and any snapshot
 * offered as its answer — unless both carry the same authority proof and
 * `coversThroughSeq` equals `snapshotSeq`. WsRouter derives that proof from the
 * restore-authority snapshot it is about to replay, so the harness derives its
 * synthetic proof from the observed authoritative snapshot instead of inventing
 * one. Without it the injected frame is discarded as an invalid proof and the
 * stale barrier under test never engages.
 */
function resyncAuthorityProof(
  initialSnapshot: JsonFrame,
  snapshotSeq: number,
): ResyncAuthorityProof {
  const authorityEpoch = initialSnapshot.authorityEpoch;
  const authorityRevision = initialSnapshot.authorityRevision;
  expect(
    typeof authorityEpoch === 'string' && authorityEpoch.length > 0,
    'E2E precondition failed: authoritative snapshot carried no authorityEpoch',
  ).toBe(true);
  expect(
    Number.isSafeInteger(authorityRevision),
    'E2E precondition failed: authoritative snapshot carried no authorityRevision',
  ).toBe(true);
  return {
    authorityEpoch: authorityEpoch as string,
    authorityRevision: Number(authorityRevision),
    coversThroughSeq: snapshotSeq,
  };
}

function buildRestoreNeeded(
  sessionId: string,
  repairToken: string,
  replayToken: string,
  snapshotSeq: number,
  proof: ResyncAuthorityProof,
): JsonFrame {
  return {
    type: 'screen-repair:restore-needed',
    sessionId,
    repairToken,
    state: 'stale',
    reason: 'byte-cap-exceeded',
    outcome: 'fresh-snapshot-started',
    replayToken,
    snapshotSeq,
    ...proof,
  };
}

interface HiddenTargetContext {
  workspaceId: string;
  originalActiveTabId: string;
  originalViewMode: 'tab' | 'grid';
  temporaryTabId: string | null;
  temporaryTabName: string;
}

async function hideTargetBehindTemporaryTab(
  page: Page,
  targetSessionId: string,
): Promise<HiddenTargetContext> {
  const result = await page.evaluate(async (sessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E precondition failed: missing auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const stateResponse = await fetch('/api/workspaces', { headers });
    if (!stateResponse.ok) {
      throw new Error(`E2E precondition failed: workspace fetch returned ${stateResponse.status}`);
    }
    const state = await stateResponse.json();
    const targetTab = state.tabs.find((tab: { sessionId?: string }) => tab.sessionId === sessionId);
    const workspace = state.workspaces.find((item: { id?: string }) => item.id === targetTab?.workspaceId);
    if (!targetTab || !workspace) {
      throw new Error('E2E precondition failed: target tab/workspace is unavailable');
    }
    const context: HiddenTargetContext = {
      workspaceId: workspace.id,
      originalActiveTabId: workspace.activeTabId,
      originalViewMode: workspace.viewMode,
      temporaryTabId: null,
      temporaryTabName: `E2E Hidden Guard ${Date.now()}`,
    };

    try {
      const tabResponse = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ shell: 'powershell', name: context.temporaryTabName }),
      });
      if (!tabResponse.ok) {
        throw new Error(`temporary tab create returned ${tabResponse.status}`);
      }
      const temporaryTab = await tabResponse.json();
      context.temporaryTabId = temporaryTab.id;
      const updateResponse = await fetch(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ viewMode: 'tab', activeTabId: temporaryTab.id }),
      });
      if (!updateResponse.ok) {
        throw new Error(`temporary tab activation returned ${updateResponse.status}`);
      }
      return { context, error: null };
    } catch (error) {
      try {
        for (let attempt = 0; attempt < 5 && !context.temporaryTabId; attempt += 1) {
          const discoveryResponse = await fetch('/api/workspaces', { headers });
          if (discoveryResponse.ok) {
            const discovered = await discoveryResponse.json();
            const temporaryTab = discovered.tabs.find((tab: { id?: string; name?: string; workspaceId?: string }) => (
              tab.name === context.temporaryTabName && tab.workspaceId === context.workspaceId
            ));
            context.temporaryTabId = temporaryTab?.id ?? context.temporaryTabId;
          }
          if (!context.temporaryTabId) {
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
        }
      } catch {
        // The outer rollback still restores the workspace and searches by the unique tab name.
      }
      return {
        context,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, targetSessionId);
  if (result.error) {
    try {
      await restoreHiddenTargetContext(page, result.context);
    } catch (rollbackError) {
      throw new Error(
        `E2E precondition failed: ${result.error}; rollback failed: ${String(rollbackError)}`,
      );
    }
    throw new Error(`E2E precondition failed: ${result.error}; rollback verified`);
  }
  return result.context;
}

async function restoreHiddenTargetContext(page: Page, context: HiddenTargetContext): Promise<void> {
  await page.evaluate(async (input) => {
    const token = localStorage.getItem('cws_auth_token');
    if (!token) throw new Error('E2E cleanup failed: missing auth token');
    const headers = { Authorization: `Bearer ${token}` };
    const errors: string[] = [];
    try {
      const restoreResponse = await fetch(`/api/workspaces/${input.workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          viewMode: input.originalViewMode,
          activeTabId: input.originalActiveTabId,
        }),
      });
      if (!restoreResponse.ok) {
        errors.push(`workspace restore returned ${restoreResponse.status}`);
      }
    } catch (error) {
      errors.push(`workspace restore threw ${String(error)}`);
    }

    let temporaryTab: { id?: string } | undefined = input.temporaryTabId
      ? { id: input.temporaryTabId }
      : undefined;
    for (let attempt = 0; attempt < 5 && !temporaryTab; attempt += 1) {
      try {
        const discoveryResponse = await fetch('/api/workspaces', { headers });
        if (!discoveryResponse.ok) {
          errors.push(`temporary tab discovery returned ${discoveryResponse.status}`);
          break;
        }
        const discovered = await discoveryResponse.json();
        temporaryTab = discovered.tabs.find((tab: { id?: string; name?: string; workspaceId?: string }) => (
          tab.workspaceId === input.workspaceId
          && (tab.id === input.temporaryTabId || tab.name === input.temporaryTabName)
        ));
      } catch (error) {
        errors.push(`temporary tab discovery threw ${String(error)}`);
        break;
      }
      if (!temporaryTab) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
    }
    if (temporaryTab?.id) {
      try {
        const deleteResponse = await fetch(
          `/api/workspaces/${input.workspaceId}/tabs/${temporaryTab.id}`,
          { method: 'DELETE', headers },
        );
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          errors.push(`temporary tab delete returned ${deleteResponse.status}`);
        }
      } catch (error) {
        errors.push(`temporary tab delete threw ${String(error)}`);
      }
    }

    try {
      const verifyResponse = await fetch('/api/workspaces', { headers });
      if (!verifyResponse.ok) {
        errors.push(`verification fetch returned ${verifyResponse.status}`);
      } else {
        const verified = await verifyResponse.json();
        const verifiedWorkspace = verified.workspaces.find((item: { id?: string }) => item.id === input.workspaceId);
        const leakedTab = verified.tabs.find((tab: { id?: string; name?: string; workspaceId?: string }) => (
          tab.workspaceId === input.workspaceId
          && (tab.id === input.temporaryTabId || tab.name === input.temporaryTabName)
        ));
        if (
          !verifiedWorkspace
          || verifiedWorkspace.activeTabId !== input.originalActiveTabId
          || verifiedWorkspace.viewMode !== input.originalViewMode
          || leakedTab
        ) {
          errors.push('workspace/tab state was not fully restored');
        }
      }
    } catch (error) {
      errors.push(`verification threw ${String(error)}`);
    }
    if (errors.length > 0) {
      throw new Error(`E2E cleanup failed: ${errors.join('; ')}`);
    }
  }, context);
}

test.describe('REL-BGSTAB-008 frontend stale/resync RED', () => {
  // The spec owns only the terminal it seeded itself, and gives it back so a
  // second run meets the same empty workspace the first one did.
  test.afterEach(async ({ page }) => {
    await releaseSeededTerminalTabs(page);
  });

  test.beforeEach(({ page }, testInfo) => {
    void page;
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only recovery contract');
  });

  test('Frontend stale/resync barrier RED 계약 — AC-4', async ({ page }) => {
    test.setTimeout(90_000);
    const signature = RED_SIGNATURES.ac4;
    const harness = new RoutedWsFaultHarness();
    const sessionId = await establishTerminalHarness(page, harness);

    await expect.poll(() => harness.latestMessage(
      'server-to-page',
      (message) => isAuthoritativeSnapshot(message, sessionId),
    ), {
      message: 'E2E precondition failed: initial authoritative screen snapshot was not observed',
      timeout: 15_000,
    }).not.toBeNull();
    const initialSnapshot = harness.latestMessage(
      'server-to-page',
      (message) => isAuthoritativeSnapshot(message, sessionId),
    )!;
    const snapshotSeq = Number(initialSnapshot.seq ?? 0) + 4;
    const authorityProof = resyncAuthorityProof(initialSnapshot, snapshotSeq);
    const replayToken = `e2e-resync-${Date.now()}`;
    const repairToken = `e2e-repair-${Date.now()}`;

    harness.injectToPage(buildRestoreNeeded(sessionId, repairToken, replayToken, snapshotSeq, authorityProof));
    await expectRestoreBarrier(page, sessionId, signature);

    const stamp = Date.now();
    const coveredMarkers = [
      `covered-ASCII-${stamp}`,
      `covered-한글-${stamp}`,
      `covered-😀-${stamp}`,
      `covered-ANSI-${stamp}`,
    ];
    const coveredPayloads = [
      `${coveredMarkers[0]}\r\n`,
      `${coveredMarkers[1]}\r\n`,
      `${coveredMarkers[2]}\r\n`,
      `\x1b[32m${coveredMarkers[3]}\x1b[0m\r\n`,
    ];
    const tailMarkers = [
      `tail-ASCII-${stamp}`,
      `tail-한글-${stamp}`,
      `tail-😀-${stamp}`,
      `tail-ANSI-${stamp}`,
      `tail-final-${stamp}`,
    ];
    const tailPayloads = [
      `${tailMarkers[0]}\r\n`,
      `${tailMarkers[1]}\r\n`,
      `${tailMarkers[2]}\r\n`,
      `\x1b[31m${tailMarkers[3]}\x1b[0m\r\n`,
      `${tailMarkers[4]}\r\n`,
    ];
    for (let index = 0; index < coveredPayloads.length; index += 1) {
      harness.injectToPage({
        type: 'output',
        sessionId,
        replayToken,
        screenSeq: snapshotSeq - coveredPayloads.length + index + 1,
        chunkId: `${replayToken}:covered:${index + 1}`,
        data: coveredPayloads[index],
      });
    }
    for (let index = 0; index < tailPayloads.length; index += 1) {
      harness.injectToPage({
        type: 'output',
        sessionId,
        replayToken,
        screenSeq: snapshotSeq + index + 1,
        chunkId: `${replayToken}:tail:${index + 1}`,
        data: tailPayloads[index],
      });
    }

    try {
      await expect.poll(async () => {
        const events = await readDebugEvents(page, sessionId);
        return events.some((event) => (
          event.kind === 'visible_output_resync_state'
          && event.details?.currentViewTransactionReady === false
          && event.details?.staleTerminal === true
          && event.details?.heldOutputChunks === coveredPayloads.length + tailPayloads.length
        ));
      }, { message: signature, timeout: 10_000 }).toBe(true);
    } catch (error) {
      const diagnostic = (await readDebugEvents(page, sessionId))
        .filter((event) => event.kind.includes('resync') || event.kind.includes('screen_repair'))
        .slice(-40)
        .map((event) => ({ kind: event.kind, details: event.details }));
      const frameDiagnostic = harness.frames.slice(-60).map((frame) => ({
        direction: frame.direction,
        connectionGeneration: frame.connectionGeneration,
        type: frame.message?.type,
        sessionIdMatches: frame.message?.sessionId === sessionId,
        replayTokenMatches: frame.message?.replayToken === replayToken,
        repairTokenMatches: frame.message?.repairToken === repairToken,
        screenSeq: frame.message?.screenSeq,
        seq: frame.message?.seq,
      }));
      console.error('held output diagnostic', diagnostic, frameDiagnostic);
      throw error;
    }
    const beforeSnapshotText = await readVisibleTerminalText(page);
    for (const marker of [...coveredMarkers, ...tailMarkers]) {
      expect(countOccurrences(beforeSnapshotText, marker), signature).toBe(0);
    }

    harness.injectToPage({
      ...initialSnapshot,
      type: 'screen-snapshot',
      sessionId,
      replayToken,
      seq: snapshotSeq,
      mode: 'authoritative',
      data: coveredPayloads.join(''),
      truncated: false,
      source: 'headless',
      ...authorityProof,
    });
    harness.injectToPage({
      type: 'session:ready',
      sessionId,
      replayToken,
      repairToken,
      snapshotSeq,
    });

    await expect.poll(async () => {
      const events = await readDebugEvents(page, sessionId);
      return events.some((event) => (
        event.kind === 'visible_output_resync_state'
        && event.details?.currentViewTransactionReady === true
        && event.details?.retainedHistoryEquivalent === false
        && event.details?.heldOutputChunks === 0
      ));
    }, { message: signature, timeout: 15_000 }).toBe(true);

    const text = await readVisibleTerminalText(page);
    const expectedOrder = [...coveredMarkers, ...tailMarkers];
    for (const marker of expectedOrder) {
      expect(countOccurrences(text, marker), signature).toBe(1);
    }
    for (let index = 1; index < expectedOrder.length; index += 1) {
      expect(text.indexOf(expectedOrder[index - 1]), signature)
        .toBeLessThan(text.indexOf(expectedOrder[index]));
    }
  });

  test('Frontend stale/resync barrier RED 계약 — AC-8', async ({ page }) => {
    test.setTimeout(90_000);
    const signature = RED_SIGNATURES.ac8;
    const harness = new RoutedWsFaultHarness();
    const sessionId = await establishTerminalHarness(page, harness);
    let hiddenContext: HiddenTargetContext | null = null;

    try {
      await expect.poll(() => harness.latestMessage(
        'server-to-page',
        (message) => isAuthoritativeSnapshot(message, sessionId),
      ), {
        message: 'E2E precondition failed: initial authoritative screen snapshot was not observed',
        timeout: 15_000,
      }).not.toBeNull();
      const initialSnapshot = harness.latestMessage(
        'server-to-page',
        (message) => isAuthoritativeSnapshot(message, sessionId),
      )!;
      await expect.poll(async () => page.evaluate((targetSessionId) => (
        localStorage.getItem(`terminal_snapshot_${targetSessionId}`) !== null
      ), sessionId), {
        message: 'E2E precondition failed: local viewport snapshot was not persisted',
        timeout: 15_000,
      }).toBe(true);

      hiddenContext = await hideTargetBehindTemporaryTab(page, sessionId);
      const generationBeforeReload = harness.connectionCount;
      await page.reload();
      await waitForTerminal(page);
      await expect.poll(() => harness.connectionCount, {
        message: 'E2E precondition failed: reload did not establish a new WebSocket generation',
        timeout: 15_000,
      }).toBeGreaterThan(generationBeforeReload);
      const currentGeneration = harness.connectionCount;
      await startDebugCapture(page, sessionId);
      await expect.poll(() => harness.latestMessage(
        'server-to-page',
        (message) => message.type === 'connected',
        currentGeneration,
      ), {
        message: 'E2E precondition failed: current WebSocket generation received no server traffic',
        timeout: 15_000,
      }).not.toBeNull();
      await expect.poll(() => harness.latestMessage(
        'page-to-server',
        (message) => (
          message.type === 'subscribe'
          && Array.isArray(message.sessionIds)
          && message.sessionIds.includes(sessionId)
        ),
        currentGeneration,
      ), {
        message: 'E2E precondition failed: hidden target was not subscribed after reload',
        timeout: 15_000,
      }).not.toBeNull();

      const hiddenMarker = `hidden-dirty-${Date.now()}`;
      const hiddenMarkerBytes = new TextEncoder().encode(hiddenMarker).byteLength;
      harness.injectToPage({ type: 'output', sessionId, data: hiddenMarker });
      await expect.poll(async () => {
        const events = await readDebugEvents(page, sessionId);
        return events.some((event) => (
          event.kind === 'hidden_output_skipped'
          && Number(event.details?.skippedBytes ?? 0) >= hiddenMarkerBytes
        ));
      }, {
        message: 'E2E precondition failed: target did not become actually hidden/dirty/skipped',
        timeout: 10_000,
      }).toBe(true);

      const snapshotSeq = Number(initialSnapshot.seq ?? 0) + 1;
      const authorityProof = resyncAuthorityProof(initialSnapshot, snapshotSeq);
      const replayToken = `e2e-provisional-${Date.now()}`;
      const repairToken = `e2e-provisional-repair-${Date.now()}`;
      harness.injectToPage(buildRestoreNeeded(sessionId, repairToken, replayToken, snapshotSeq, authorityProof));
      await expectRestoreBarrier(page, sessionId, signature);

      await page.locator(
        `[role="tab"][aria-controls="terminal-${sessionId}"]`,
      ).click();
      await waitForTerminal(page);
      harness.injectToPage({
        ...initialSnapshot,
        type: 'screen-snapshot',
        sessionId,
        replayToken,
        seq: snapshotSeq,
        mode: 'fallback',
        data: '',
        truncated: true,
        source: 'headless',
        fallbackDataState: 'empty-no-recoverable-data',
        fallbackDataBytes: 0,
        ...authorityProof,
      });

      await expect.poll(async () => {
        const events = await readDebugEvents(page, sessionId);
        return events.some((event) => (
          event.kind === 'visible_output_resync_state'
          && event.details?.provisionalLocalState === true
          && event.details?.staleTerminal === true
          && event.details?.currentViewTransactionReady === false
          && event.details?.retainedHistoryEquivalent === false
          && event.details?.hiddenDirty === true
          && event.details?.hiddenSkipped === true
          && Number(event.details?.hiddenSkippedBytes ?? 0) >= hiddenMarkerBytes
        ));
      }, { message: signature, timeout: 10_000 }).toBe(true);

      expect(harness.latestMessage(
        'page-to-server',
        (message) => message.type === 'screen-snapshot:ready' && message.replayToken === replayToken,
        currentGeneration,
      ), signature).toBeNull();
      harness.injectToPage({
        type: 'screen-repair:reconnect-required',
        sessionId,
        repairToken,
        reason: 'ack-timeout',
        outcome: 'reconnect-required',
      });
      // Queue a late frame on the same routed generation before the reconnect
      // closes it. Injecting after convergence would target the replacement
      // socket and would no longer model an in-flight stale server frame.
      const lateFailedAuthorityMarker = `late-failed-authority-${Date.now()}`;
      harness.injectToPage({
        ...initialSnapshot,
        type: 'screen-snapshot',
        sessionId,
        replayToken,
        seq: snapshotSeq,
        mode: 'authoritative',
        data: `${lateFailedAuthorityMarker}\r\n`,
        truncated: false,
        source: 'headless',
        ...authorityProof,
      });

      try {
        await expect.poll(async () => {
          const events = await readDebugEvents(page, sessionId);
          const hasReconnectOutcome = events.some((event) => (
            event.kind === 'visible_output_resync_outcome'
            && event.details?.outcome === 'reconnect-required'
            && event.details?.reason === 'ack-timeout'
          ));
          const remainsStale = events.some((event) => (
            event.kind === 'visible_output_resync_state'
            && event.details?.source === 'reconnect-required'
            && event.details?.currentViewTransactionReady === false
            && event.details?.staleTerminal === true
            && event.details?.retainedHistoryEquivalent === false
            && event.details?.heldOutputChunks === 0
          ));
          return hasReconnectOutcome && remainsStale;
        }, { message: signature, timeout: 15_000 }).toBe(true);
      } catch (error) {
        const diagnostic = (await readDebugEvents(page, sessionId))
          .filter((event) => event.kind.includes('resync'))
          .slice(-30)
          .map((event) => ({ kind: event.kind, details: event.details }));
        console.error('authoritative resync diagnostic', diagnostic);
        throw error;
      }
      await expect.poll(async () => {
        const events = await readDebugEvents(page, sessionId);
        const ignoredInFailedRuntime = events.some((event) => (
          event.kind === 'visible_output_resync_failed_snapshot_ignored'
          && event.details?.replayToken === replayToken
          && event.details?.seq === snapshotSeq
        ));
        const fencedByReplacementGeneration = harness.connectionCount > currentGeneration;
        return ignoredInFailedRuntime || fencedByReplacementGeneration;
      }, { message: signature, timeout: 10_000 }).toBe(true);
      expect(harness.latestMessage(
        'page-to-server',
        (message) => message.type === 'screen-snapshot:ready' && message.replayToken === replayToken,
        currentGeneration,
      ), signature).toBeNull();
      expect(await readVisibleTerminalText(page), signature).not.toContain(lateFailedAuthorityMarker);

      const stateEvents = (await readDebugEvents(page, sessionId)).filter(
        (event) => event.kind === 'visible_output_resync_state',
      );
      expect(stateEvents.length, signature).toBeGreaterThan(0);
      expect(
        stateEvents.every((event) => event.details?.retainedHistoryEquivalent === false),
        signature,
      ).toBe(true);
    } finally {
      if (hiddenContext) {
        await restoreHiddenTargetContext(page, hiddenContext);
      }
    }
  });
});
