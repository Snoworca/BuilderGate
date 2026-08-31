import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordTerminalDebugEvent } from '../../src/utils/terminalDebugCapture.ts';

test('PERF-BGSTAB-010 AC-6 ACK rejection debug event records only protocol identifiers', () => {
  const globalWithBrowser = globalThis as typeof globalThis & {
    window?: Window;
    localStorage?: Storage;
  };
  const previousWindow = globalWithBrowser.window;
  const previousLocalStorage = globalWithBrowser.localStorage;
  const fakeWindow = {
    location: { hostname: 'localhost' },
  } as unknown as Window;

  Object.defineProperty(globalWithBrowser, 'window', {
    configurable: true,
    value: fakeWindow,
    writable: true,
  });
  Object.defineProperty(globalWithBrowser, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    } as Storage,
    writable: true,
  });

  try {
    recordTerminalDebugEvent('session-ack-rejected', 'terminal_delivery_ack_rejected', {
      connectionEpoch: 'epoch-7',
      deliverySeq: 42,
      reason: 'stale-delivery-seq',
    }, undefined, { includeInputReliabilityMode: false });

    const store = fakeWindow.__buildergateTerminalDebug;
    assert.ok(store, 'debug store must initialize for the browser test host');
    store.enable('session-ack-rejected');
    store.clear('session-ack-rejected');

    recordTerminalDebugEvent('session-ack-rejected', 'terminal_delivery_ack_rejected', {
      connectionEpoch: 'epoch-7',
      deliverySeq: 42,
      reason: 'stale-delivery-seq',
    }, undefined, { includeInputReliabilityMode: false });

    const event = store.getEvents('session-ack-rejected').at(-1);
    assert.ok(event, 'ACK rejection must be captured when session debug is enabled');
    assert.equal(event.sessionId, 'session-ack-rejected');
    assert.equal(event.kind, 'terminal_delivery_ack_rejected');
    assert.deepEqual(event.details, {
      connectionEpoch: 'epoch-7',
      deliverySeq: 42,
      reason: 'stale-delivery-seq',
    });
    assert.equal(event.preview, undefined);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalWithBrowser, 'window');
    } else {
      Object.defineProperty(globalWithBrowser, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    }
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalWithBrowser, 'localStorage');
    } else {
      Object.defineProperty(globalWithBrowser, 'localStorage', {
        configurable: true,
        value: previousLocalStorage,
        writable: true,
      });
    }
  }
});
