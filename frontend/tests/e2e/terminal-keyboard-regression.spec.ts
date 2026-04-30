import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';
import type { TerminalInputTransportOverride } from '../../src/types/ws-protocol';

async function createFreshPowerShellWorkspace(page: Page, name: string) {
  return page.evaluate(async ({ workspaceName }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const extractWorkspaceTimestamp = (name: string) => {
      const match = name.match(/(?:PW-(?:KEYS|IME|MOBILE-SCROLL)|SwitchTarget|E2E Equal(?: Grid| Reorder)?|REAL DND|DBG Verify|ROOTCAUSE)[ -]?(\d+)/);
      return match ? Number.parseInt(match[1], 10) : 0;
    };
    const isEvictableTestWorkspace = (name: string) =>
      name.startsWith('PW-KEYS-')
      || name.startsWith('PW-IME-')
      || name.startsWith('PW-MOBILE-SCROLL-')
      || name.startsWith('E2E Equal ')
      || name.startsWith('SwitchTarget-')
      || name.startsWith('REAL DND ')
      || name.startsWith('DBG Verify ')
      || name.startsWith('ROOTCAUSE ');

    const createWorkspace = async () => {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ name: workspaceName }),
      });
      return response;
    };

    let createWorkspaceRes = await createWorkspace();
    for (let attempt = 0; createWorkspaceRes.status === 409 && attempt < 20; attempt += 1) {
      const stateRes = await fetch('/api/workspaces', { headers });
      if (!stateRes.ok) {
        throw new Error(`workspace fetch failed: ${stateRes.status}`);
      }
      const state = await stateRes.json();
      const evictCandidate = state.workspaces
        .filter((item: { name: string }) => isEvictableTestWorkspace(item.name))
        .sort((left: { name: string }, right: { name: string }) => extractWorkspaceTimestamp(left.name) - extractWorkspaceTimestamp(right.name))[0] ?? null;

      if (!evictCandidate) {
        break;
      }

      const deleteRes = await fetch(`/api/workspaces/${evictCandidate.id}`, {
        method: 'DELETE',
        headers,
      });
      if (!deleteRes.ok && deleteRes.status !== 404) {
        throw new Error(`workspace delete failed: ${deleteRes.status}`);
      }
      createWorkspaceRes = await createWorkspace();
    }

    if (!createWorkspaceRes.ok) {
      throw new Error(`workspace create failed: ${createWorkspaceRes.status}`);
    }

    const workspace = await createWorkspaceRes.json();

    const createTabRes = await fetch(`/api/workspaces/${workspace.id}/tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ shell: 'powershell' }),
    });
    if (!createTabRes.ok) {
      throw new Error(`tab create failed: ${createTabRes.status}`);
    }
    const tab = await createTabRes.json();
    localStorage.setItem('active_workspace_id', workspace.id);
    return { workspace, tab };
  }, { workspaceName: name });
}

async function activateFreshPowerShellWorkspace(page: Page) {
  await createFreshPowerShellWorkspace(page, `PW-KEYS-${Date.now()}`);
  await page.reload();
  await waitForTerminal(page);

  await expect.poll(async () => {
    return await readVisibleTerminalText(page);
  }, { timeout: 15000 }).toContain('PS ');
}

async function startTerminalDebug(page: Page, sessionId: string) {
  await page.evaluate(async (targetSessionId) => {
    await window.__buildergateTerminalDebug?.start(targetSessionId);
  }, sessionId);
}

async function getActiveSessionId(page: Page) {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const activeWorkspaceId = localStorage.getItem('active_workspace_id');
    const res = await fetch('/api/workspaces', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new Error(`workspace fetch failed: ${res.status}`);
    }
    const state = await res.json();
    const workspace = state.workspaces.find((item: { id: string }) => item.id === activeWorkspaceId) ?? state.workspaces[0];
    const tab = state.tabs.find((item: { id: string }) => item.id === workspace.activeTabId);
    return tab?.sessionId ?? null;
  });
}

async function getManualInputEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => {
    return (window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? []).filter(
      (event) => event.kind === 'key_delegated_to_xterm',
    );
  }, sessionId);
}

async function getTerminalDebugEvents(page: Page, sessionId: string) {
  return page.evaluate((targetSessionId) => {
    return window.__buildergateTerminalDebug?.getEvents(targetSessionId) ?? [];
  }, sessionId);
}

async function setInputTransportOverride(
  page: Page,
  sessionId: string,
  override: TerminalInputTransportOverride | null,
) {
  return page.evaluate(({ targetSessionId, nextOverride }) => {
    return window.__buildergateTerminalDebug?.setInputTransportOverride(targetSessionId, nextOverride) ?? false;
  }, { targetSessionId: sessionId, nextOverride: override });
}

async function setNextWebSocketInputSendFailure(
  page: Page,
  reason: 'not-open' | 'missing-token' | 'stale-socket',
  count = 1,
) {
  return page.evaluate(({ failureReason, failureCount }) => {
    return window.__buildergateTerminalDebug?.setNextWebSocketInputSendFailure({
      reason: failureReason,
      count: failureCount,
    }) ?? false;
  }, { failureReason: reason, failureCount: count });
}

async function getVisibleInputSurfaceState(page: Page) {
  return page.evaluate(() => {
    const view = Array.from(document.querySelectorAll('.terminal-view')).find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const helper = view?.querySelector('textarea.xterm-helper-textarea');
    return helper instanceof HTMLTextAreaElement
      ? { disabled: helper.disabled, readOnly: helper.readOnly }
      : null;
  });
}

async function getServerDebugEvents(page: Page, sessionId: string) {
  return page.evaluate(async (targetSessionId) => {
    const token = localStorage.getItem('cws_auth_token');
    const response = await fetch(`/api/sessions/debug-capture/${targetSessionId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      throw new Error(`server debug fetch failed: ${response.status}`);
    }
    return response.json();
  }, sessionId);
}

async function dispatchAutoRepeatSpace(page: Page, repeatCount = 2) {
  const client = await page.context().newCDPSession(page);
  const baseEvent = {
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
    text: ' ',
    unmodifiedText: ' ',
  };

  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    autoRepeat: false,
    ...baseEvent,
  });

  for (let index = 0; index < repeatCount; index += 1) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      autoRepeat: true,
      ...baseEvent,
    });
  }

  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...baseEvent,
  });
}

async function focusTerminalInput(page: Page) {
  const input = page.getByRole('textbox', { name: 'Terminal input' }).first();
  await input.click();
}

async function clickVisibleTerminalSurface(page: Page) {
  const surface = page.locator('.terminal-view[data-terminal-view="true"]:visible').first();
  await surface.click({ position: { x: 24, y: 24 } });
}

async function getActiveElementInfo(page: Page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return null;
    }

    return {
      tagName: activeElement.tagName,
      ariaLabel: activeElement.getAttribute('aria-label'),
      className: activeElement.className,
    };
  });
}

async function readVisibleTerminalText(page: Page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    const activeInput = activeElement instanceof HTMLTextAreaElement ? activeElement : null;
    const visibleViews = Array.from(document.querySelectorAll('.terminal-view')).filter((node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const terminalView =
      activeInput?.closest('.terminal-view')
      ?? visibleViews[0]
      ?? null;
    const rows = terminalView?.querySelector('.xterm-rows');
    return rows?.textContent ?? '';
  });
}

async function dispatchRapidInvalidCommands(page: Page, count: number) {
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.type('A', { delay: 0 });
    await page.keyboard.press('Enter');
  }
}

function assertNoRawInputDebugLeak(events: Array<{ kind: string; details?: Record<string, unknown>; preview?: string }>, raw: string) {
  const inputEvents = events.filter((event) => [
    'helper_keydown',
    'helper_beforeinput',
    'helper_input',
    'xterm_data_emitted',
    'xterm_data_dropped_not_ready',
    'ws_input_sent',
    'ws_input_dropped_not_ready',
    'key_delegated_to_xterm',
    'terminal_input_would_queue',
    'terminal_input_would_reject',
    'terminal_input_queued',
    'terminal_input_rejected',
    'terminal_input_sequencer_received',
    'ws_send_debug_failure_forced',
    'ws_send_rejected_not_open',
    'ws_send_rejected_missing_token',
    'transport_input_would_queue',
    'transport_input_would_reject',
    'transport_input_queued',
    'transport_input_rejected',
    'transport_input_queue_overflow',
    'transport_input_flushed',
    'queued_input_flushed',
    'key_event_observed',
    'ime_guard_delegated',
    'ime_state_changed',
    'ime_capture_close_deferred',
    'ime_repair_deferred',
    'ime_commit_without_xterm_data',
    'ime_fallback_observed',
    'ime_settled',
    'ime_deferred_action_cancelled',
    'ime_deferred_action_retargeted',
    'ime_deferred_action_skipped',
    'ime_transaction_cancelled',
  ].includes(event.kind));

  for (const event of inputEvents) {
    expect(event.details?.code).toBeUndefined();
    expect(event.details?.key).toBeUndefined();
    for (const value of Object.values(event.details ?? {})) {
      if (typeof value === 'string') {
        expect(value).not.toContain(raw);
      }
    }
    if (event.preview !== undefined) {
      expect(event.preview).not.toContain(raw);
    }
  }
}

test.describe('Terminal Keyboard Regressions', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only regression coverage');
    await login(page);
    await waitForTerminal(page);
    await activateFreshPowerShellWorkspace(page);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode(null);
      const events = window.__buildergateTerminalDebug?.getEvents() ?? [];
      for (const event of events) {
        window.__buildergateTerminalDebug?.setInputTransportOverride(event.sessionId, null);
      }
      window.__buildergateTerminalDebug?.setNextWebSocketInputSendFailure(null);
    }).catch(() => undefined);
  });

  test('TC-7201: repeated space auto-repeat events should visibly advance the prompt line', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await dispatchAutoRepeatSpace(page, 2);
    await page.keyboard.press('X');

    await expect.poll(async () => {
      const events = await getManualInputEvents(page, sessionId!);
      return events.map((event) => ({
        preview: event.preview,
        repeat: event.details?.repeat,
      }));
    }, { timeout: 5000 }).toEqual([
      { preview: '␠', repeat: false },
      { preview: '␠', repeat: true },
      { preview: '␠', repeat: true },
    ]);

    await expect.poll(async () => {
      const text = await readVisibleTerminalText(page);
      return />\s{2,}X/.test(text);
    }, { timeout: 5000 }).toBe(true);
  });

  test('TC-7202: plain backspace should echo without newline-like output corruption', async ({ page }) => {
    await focusTerminalInput(page);
    await page.keyboard.type('abc');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).toContain('> abc');

    await page.keyboard.press('Backspace');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).toContain('> ab');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).not.toContain('> abc');
  });

  test('TC-7204: clicking the terminal surface should focus the xterm helper textarea', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await clickVisibleTerminalSurface(page);

    await expect.poll(async () => {
      return await getActiveElementInfo(page);
    }, { timeout: 5000 }).toMatchObject({
      tagName: 'TEXTAREA',
      ariaLabel: 'Terminal input',
      className: expect.stringContaining('xterm-helper-textarea'),
    });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events
        .filter((event) => event.kind === 'focus_applied' || event.kind === 'focus_fallback_applied')
        .map((event) => event.details?.reason);
    }, { timeout: 5000 }).toEqual(expect.arrayContaining(['runtime-layer']));

    await page.keyboard.press('Z');

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 5000 }).toContain('> Z');
  });

  test('TC-7203: debug capture start should expose browser-side input transport events', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode('queue');
    });
    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await page.keyboard.press('A');
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.map((event) => event.kind);
    }, { timeout: 5000 }).toEqual(
      expect.arrayContaining([
        'capture_started',
        'helper_keydown',
        'helper_beforeinput',
        'helper_input',
        'xterm_data_emitted',
        'ws_input_sent',
      ]),
    );

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.find((event) => event.kind === 'ws_input_sent') ?? null;
    }, { timeout: 5000 }).not.toBeNull();

    const wsInputEvent = (await getTerminalDebugEvents(page, sessionId)).find(
      (event) => event.kind === 'ws_input_sent' && event.details?.hasEnter === true,
    );
    const captureStartedEvent = (await getTerminalDebugEvents(page, sessionId)).find(
      (event) => event.kind === 'capture_started',
    );
    expect(captureStartedEvent?.details?.inputReliabilityMode).toBe('queue');
    expect(wsInputEvent?.details?.hasEnter).toBe(true);
    expect(wsInputEvent?.details?.enterCount).toBeGreaterThan(0);
    expect(wsInputEvent?.details?.captureSeq).toEqual(expect.any(Number));
    expect(wsInputEvent?.details?.byteLength).toBeGreaterThan(0);

    await expect.poll(async () => {
      const payload = await getServerDebugEvents(page, sessionId);
      const events = payload.server ?? [];
      const kinds = events.map((event: { kind: string }) => event.kind);
      return kinds.includes('input') && kinds.includes('raw_output');
    }, { timeout: 5000 }).toBe(true);

    const serverEvents = (await getServerDebugEvents(page, sessionId)).server ?? [];

    const inputIndex = serverEvents.findIndex(
      (event: { kind: string; details?: Record<string, unknown> }) => event.kind === 'input' && event.details?.hasEnter === true,
    );
    const rawOutputIndex = serverEvents.findIndex((event: { kind: string }, index: number) => index > inputIndex && event.kind === 'raw_output');
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(rawOutputIndex).toBeGreaterThan(inputIndex);

    const inputEvent = serverEvents[inputIndex];
    const rawOutputEvent = serverEvents[rawOutputIndex];
    expect(inputEvent?.details?.hasEnter).toBe(true);
    expect(inputEvent?.details?.captureSeq).toEqual(expect.any(Number));
    expect(inputEvent?.details?.clientObservedByteLength).toEqual(expect.any(Number));
    expect(rawOutputEvent?.details?.recentInputSampleCount).toEqual(expect.any(Number));
    expect(
      rawOutputEvent?.details?.msSinceNewestInputSample === null
      || typeof rawOutputEvent?.details?.msSinceNewestInputSample === 'number',
    ).toBe(true);

    const clientEvents = await getTerminalDebugEvents(page, sessionId);
    const xtermIndex = clientEvents.findIndex((event) => event.kind === 'xterm_data_emitted');
    const wsIndex = clientEvents.findIndex((event) => event.kind === 'ws_input_sent');
    expect(xtermIndex).toBeGreaterThanOrEqual(0);
    expect(wsIndex).toBeGreaterThan(xtermIndex);
    assertNoRawInputDebugLeak(clientEvents, 'A');
    assertNoRawInputDebugLeak(clientEvents, 'Space');
    for (const event of serverEvents.filter((item: { kind: string }) => item.kind === 'input')) {
      for (const value of Object.values(event.details ?? {})) {
        if (typeof value === 'string') {
          expect(value).not.toContain('A');
        }
      }
      expect(event.preview ?? '').not.toContain('A');
    }
  });

  test('TC-7209: server input rejection is routed into terminal debug capture', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      const current = WebSocket.prototype.send;
      if ((WebSocket.prototype as unknown as { __buildergateInvalidSeqPatch?: boolean }).__buildergateInvalidSeqPatch) {
        return;
      }
      (WebSocket.prototype as unknown as { __buildergateInvalidSeqPatch?: boolean }).__buildergateInvalidSeqPatch = true;
      WebSocket.prototype.send = function patchedSend(this: WebSocket, payload: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if ((window as unknown as { __buildergateForceInvalidInputSequence?: boolean }).__buildergateForceInvalidInputSequence && typeof payload === 'string') {
          try {
            const parsed = JSON.parse(payload);
            if (parsed?.type === 'input') {
              parsed.inputSeqStart = 9;
              parsed.inputSeqEnd = 1;
              (window as unknown as { __buildergateForceInvalidInputSequence?: boolean }).__buildergateForceInvalidInputSequence = false;
              return current.call(this, JSON.stringify(parsed));
            }
          } catch {
            // Leave non-JSON frames untouched.
          }
        }
        return current.call(this, payload);
      };
    });

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await page.evaluate(() => {
      (window as unknown as { __buildergateForceInvalidInputSequence?: boolean }).__buildergateForceInvalidInputSequence = true;
    });
    await page.keyboard.type('r', { delay: 0 });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.find((event) => event.kind === 'server_input_rejected') ?? null;
    }, { timeout: 5000 }).toMatchObject({
      kind: 'server_input_rejected',
      details: {
        reason: 'invalid-sequence',
        inputSeqStart: 9,
        inputSeqEnd: 1,
      },
    });
  });

  test('TC-7210: printable input is coalesced while Enter remains an ordered boundary', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await page.keyboard.type('abc', { delay: 0 });
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      const sent = events.filter((event) => event.kind === 'ws_input_sent');
      const printable = sent.find((event) =>
        event.details?.hasEnter === false
        && typeof event.details?.inputSeqStart === 'number'
        && typeof event.details?.inputSeqEnd === 'number'
        && event.details.inputSeqEnd > event.details.inputSeqStart
        && event.details.logicalChunkCount === 3,
      );
      const enter = sent.find((event) =>
        event.details?.hasEnter === true
        && typeof event.details?.inputSeqStart === 'number'
        && printable
        && event.details.inputSeqStart === Number(printable.details?.inputSeqEnd) + 1,
      );
      return {
        printableRange: printable
          ? [printable.details?.inputSeqStart, printable.details?.inputSeqEnd]
          : null,
        enterSeq: enter?.details?.inputSeqStart ?? null,
      };
    }, { timeout: 5000 }).toEqual({
      printableRange: [expect.any(Number), expect.any(Number)],
      enterSeq: expect.any(Number),
    });

    const serverPayload = await getServerDebugEvents(page, sessionId);
    const serverEvents = serverPayload.server ?? [];
    expect(serverEvents.some((event: { kind: string; details?: Record<string, unknown> }) =>
      event.kind === 'input'
      && typeof event.details?.inputSeqStart === 'number'
      && typeof event.details?.inputSeqEnd === 'number'
      && Number(event.details.inputSeqEnd) > Number(event.details.inputSeqStart),
    )).toBe(true);

    const events = await getTerminalDebugEvents(page, sessionId);
    assertNoRawInputDebugLeak(events, 'abc');
  });

  test('TC-7211: queue mode retries a transient WebSocket send failure without losing input', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode('queue');
    });
    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    expect(await setNextWebSocketInputSendFailure(page, 'not-open', 1)).toBe(true);
    await page.keyboard.type('z', { delay: 0 });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return {
        forced: events.some((event) => event.kind === 'ws_send_debug_failure_forced'),
        queued: events.some((event) => event.kind === 'transport_input_queued'),
        flushed: events.some((event) => event.kind === 'transport_input_flushed'),
        sent: events.some((event) =>
          event.kind === 'ws_input_sent'
          && event.details?.source === 'outbox-send-failure-not-open',
        ),
      };
    }, { timeout: 5000 }).toMatchObject({
      forced: true,
      queued: true,
      flushed: true,
      sent: true,
    });

    await expect.poll(async () => await readVisibleTerminalText(page), { timeout: 5000 }).toContain('> z');
  });

  test('TC-7212: stale WebSocket send failure is rejected instead of queued for late flush', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode('queue');
    });
    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    expect(await setNextWebSocketInputSendFailure(page, 'stale-socket', 1)).toBe(true);
    await page.keyboard.type('s', { delay: 0 });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return {
        forced: events.some((event) => event.kind === 'ws_send_debug_failure_forced'),
        rejected: events.some((event) =>
          event.kind === 'transport_input_rejected'
          && event.details?.reason === 'transport-closed'
          && event.details?.detailReason === 'stale-socket',
        ),
        queued: events.some((event) => event.kind === 'transport_input_queued'),
        flushed: events.some((event) => event.kind === 'transport_input_flushed'),
      };
    }, { timeout: 5000 }).toMatchObject({
      forced: true,
      rejected: true,
      queued: false,
      flushed: false,
    });
  });

  test('TC-7213: Hangul insertText followed by Space stays observable without transport rejection', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await page.keyboard.insertText('한');
    await page.keyboard.press('Space');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      const sent = events.filter((event) => event.kind === 'ws_input_sent');
      return {
        hangulSeen: sent.some((event) => event.details?.hasHangul === true),
        spaceSeen: sent.some((event) => Number(event.details?.spaceCount ?? 0) >= 1),
        rejected: events.some((event) =>
          event.kind === 'terminal_input_rejected'
          || event.kind === 'transport_input_rejected'
          || event.kind === 'server_input_rejected',
        ),
      };
    }, { timeout: 5000 }).toMatchObject({
      hangulSeen: true,
      spaceSeen: true,
      rejected: false,
    });

    const events = await getTerminalDebugEvents(page, sessionId);
    assertNoRawInputDebugLeak(events, '한');
  });

  test('TC-7206: queue mode preserves printable input across a transient transport barrier', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode('queue');
    });
    await startTerminalDebug(page, sessionId);
    expect(await setInputTransportOverride(page, sessionId, {
      serverReady: false,
      barrierReason: 'repair-server-not-ready',
      closedReason: 'none',
      reconnectState: 'connected',
    })).toBe(true);

    await focusTerminalInput(page);

    await expect.poll(async () => {
      const state = await getVisibleInputSurfaceState(page);
      const gateEvents = await getTerminalDebugEvents(page, sessionId);
      const gate = [...gateEvents].reverse().find((event) => event.kind === 'input_gate_synced');
      return {
        helperDisabled: state?.disabled,
        helperReadOnly: state?.readOnly,
        captureAllowed: gate?.details?.captureAllowed,
        transportReady: gate?.details?.transportReady,
        disableStdin: gate?.details?.disableStdin,
        barrierReason: gate?.details?.barrierReason,
      };
    }, { timeout: 5000 }).toMatchObject({
      helperDisabled: false,
      helperReadOnly: false,
      captureAllowed: true,
      transportReady: false,
      disableStdin: false,
      barrierReason: 'repair-server-not-ready',
    });

    await page.keyboard.type('abc', { delay: 0 });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.filter((event) => event.kind === 'terminal_input_queued').length;
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(3);

    await setInputTransportOverride(page, sessionId, null);

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      const sent = events.filter((event) => event.kind === 'ws_input_sent');
      return {
        flushedAtLeast3: events.filter((event) => event.kind === 'queued_input_flushed').length >= 3,
        sentAtLeast1: sent.length >= 1,
        coalescedSent: sent.some((event) =>
          typeof event.details?.inputSeqStart === 'number'
          && typeof event.details?.inputSeqEnd === 'number'
          && Number(event.details.inputSeqEnd) > Number(event.details.inputSeqStart),
        ),
        dropped: events.filter((event) => event.kind === 'xterm_data_dropped_not_ready').length,
      };
    }, { timeout: 5000 }).toMatchObject({
      flushedAtLeast3: true,
      sentAtLeast1: true,
      coalescedSent: true,
      dropped: 0,
    });

    const events = await getTerminalDebugEvents(page, sessionId);
    expect(events.filter((event) => event.kind === 'queued_input_flushed').length).toBeGreaterThanOrEqual(3);
    expect(events.filter((event) => event.kind === 'ws_input_sent').length).toBeGreaterThanOrEqual(1);

    await expect.poll(async () => await readVisibleTerminalText(page), { timeout: 5000 }).toContain('> abc');
    assertNoRawInputDebugLeak(events, 'abc');
  });

  test('TC-7207: queued Enter input expires without late execution', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode('queue');
    });
    await startTerminalDebug(page, sessionId);
    expect(await setInputTransportOverride(page, sessionId, {
      serverReady: false,
      barrierReason: 'repair-server-not-ready',
      closedReason: 'none',
      reconnectState: 'connected',
    })).toBe(true);

    await focusTerminalInput(page);
    await page.keyboard.type('Q', { delay: 0 });
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.some(
        (event) => event.kind === 'terminal_input_rejected'
          && event.details?.reason === 'timeout-enter-safety',
      );
    }, { timeout: 4000 }).toBe(true);

    await setInputTransportOverride(page, sessionId, null);
    await page.waitForTimeout(300);

    const events = await getTerminalDebugEvents(page, sessionId);
    expect(events.some(
      (event) => event.kind === 'queued_input_flushed' && event.details?.hasEnter === true,
    )).toBe(false);
    expect(events.some(
      (event) => event.kind === 'ws_input_sent' && event.details?.hasEnter === true,
    )).toBe(false);
  });

  test('TC-7208: queued input is rejected when session generation changes before flush', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await page.evaluate(() => {
      window.__buildergateTerminalDebug?.setInputReliabilityMode('queue');
    });
    await startTerminalDebug(page, sessionId);
    expect(await setInputTransportOverride(page, sessionId, {
      serverReady: false,
      barrierReason: 'repair-server-not-ready',
      closedReason: 'none',
      reconnectState: 'connected',
    })).toBe(true);

    await focusTerminalInput(page);
    await page.keyboard.type('g', { delay: 0 });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.some((event) => event.kind === 'terminal_input_queued');
    }, { timeout: 5000 }).toBe(true);

    await setInputTransportOverride(page, sessionId, {
      serverReady: true,
      barrierReason: 'none',
      closedReason: 'none',
      reconnectState: 'connected',
      sessionGeneration: 999,
    });

    await expect.poll(async () => {
      const events = await getTerminalDebugEvents(page, sessionId);
      return events.some(
        (event) => event.kind === 'terminal_input_rejected'
          && event.details?.reason === 'context-changed',
      );
    }, { timeout: 5000 }).toBe(true);

    const events = await getTerminalDebugEvents(page, sessionId);
    expect(events.some((event) => event.kind === 'queued_input_flushed')).toBe(false);
  });

  test('TC-7205: rapid PowerShell A+Enter repeats should render sequential command-not-found output', async ({ page }) => {
    const sessionId = await getActiveSessionId(page);
    test.skip(!sessionId, 'Need an active session');

    await startTerminalDebug(page, sessionId);
    await focusTerminalInput(page);
    await dispatchRapidInvalidCommands(page, 5);

    await expect.poll(async () => {
      const text = await readVisibleTerminalText(page);
      const matches = text.match(/CommandNotFoundException/g) ?? [];
      return matches.length;
    }, { timeout: 15000 }).toBeGreaterThanOrEqual(3);

    await expect.poll(async () => {
      return await readVisibleTerminalText(page);
    }, { timeout: 15000 }).toContain('PS ');

    const serverPayload = await getServerDebugEvents(page, sessionId);
    const serverEvents = serverPayload.server ?? [];
    const blockedInputs = serverEvents.filter((event: { kind: string }) => event.kind === 'input_blocked');
    expect(blockedInputs.length).toBe(0);
  });
});
