import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getClientWsResourceLimits,
  getFrontendRuntimeResidencyMode,
  getRuntimeConfigVersion,
  getSnapshotResourceLimits,
  getTerminalResourceLimits,
  getWsTransportMode,
  getWorkspaceRuntimeResourceLimits,
  initializeInputReliabilityMode,
  subscribeRuntimeConfigChanges,
} from '../../src/utils/inputReliabilityMode.ts';
import {
  createHiddenOutputState,
  resolveHiddenOutput,
} from '../../src/utils/terminalHiddenOutput.ts';

test('runtime config loads terminal hidden output limits from public payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    resourceLimits: {
      terminal: {
        hiddenOutputPolicy: 'debug-tail',
        hiddenOutputTailBytes: 4096,
      },
    },
  }), { status: 200 });

  try {
    const mode = await initializeInputReliabilityMode();

    assert.equal(mode, 'queue');
    assert.deepEqual(getTerminalResourceLimits(), {
      visibleOutputQueueMaxBytes: 4_194_304,
      visibleOutputMaxChunks: 512,
      visibleFlushBudgetBytes: 262_144,
      hiddenOutputPolicy: 'debug-tail',
      hiddenOutputTailBytes: 4096,
      inputQueueMaxBytes: 65_536,
      inputQueueTtlMs: 1500,
      transportOutboxMaxBytes: 65_536,
      transportOutboxTtlMs: 1500,
      scrollbackLines: 10_000,
    });
    const decision = resolveHiddenOutput(createHiddenOutputState(), {
      isVisible: false,
      byteLength: 5,
      data: 'abcde',
      ...getTerminalResourceLimits(),
    });
    assert.equal(decision.nextState.debugTail, 'abcde');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime config loads all public resource limit sections from public payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    wsTransportMode: 'split-shadow',
    stabilityModes: {
      frontendRuntimeResidency: 'bounded',
    },
    resourceLimits: {
      clientWs: {
        inputBackpressureBytes: 2_000_000,
        hardReconnectBytes: 8_000_000,
      },
      terminal: {
        visibleOutputQueueMaxBytes: 9_000_000,
        visibleOutputMaxChunks: 1024,
        visibleFlushBudgetBytes: 512_000,
        hiddenOutputPolicy: 'debug-tail',
        hiddenOutputTailBytes: 4096,
        inputQueueMaxBytes: 128_000,
        inputQueueTtlMs: 2500,
        transportOutboxMaxBytes: 256_000,
        transportOutboxTtlMs: 3500,
        scrollbackLines: 20_000,
      },
      snapshots: {
        perSnapshotMaxChars: 1_500_000,
        totalStorageBudgetChars: 6_000_000,
        maxEntries: 32,
        tombstoneTtlMs: 120_000,
      },
      workspaceRuntime: {
        maxLiveWorkspaces: 5,
        maxLiveTerminals: 20,
        hiddenRuntimeTtlMs: 30_000,
      },
    },
  }), { status: 200 });

  try {
    const mode = await initializeInputReliabilityMode();

    assert.equal(mode, 'queue');
    assert.equal(getWsTransportMode(), 'split-shadow');
    assert.equal(getFrontendRuntimeResidencyMode(), 'bounded');
    assert.deepEqual(getClientWsResourceLimits(), {
      inputBackpressureBytes: 2_000_000,
      hardReconnectBytes: 8_000_000,
    });
    assert.deepEqual(getTerminalResourceLimits(), {
      visibleOutputQueueMaxBytes: 9_000_000,
      visibleOutputMaxChunks: 1024,
      visibleFlushBudgetBytes: 512_000,
      hiddenOutputPolicy: 'debug-tail',
      hiddenOutputTailBytes: 4096,
      inputQueueMaxBytes: 128_000,
      inputQueueTtlMs: 2500,
      transportOutboxMaxBytes: 256_000,
      transportOutboxTtlMs: 3500,
      scrollbackLines: 20_000,
    });
    assert.deepEqual(getSnapshotResourceLimits(), {
      perSnapshotMaxChars: 1_500_000,
      totalStorageBudgetChars: 6_000_000,
      maxEntries: 32,
      tombstoneTtlMs: 120_000,
    });
    assert.deepEqual(getWorkspaceRuntimeResourceLimits(), {
      maxLiveWorkspaces: 5,
      maxLiveTerminals: 20,
      hiddenRuntimeTtlMs: 30_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime config publishes a version change after successful initialization', async () => {
  const originalFetch = globalThis.fetch;
  const beforeVersion = getRuntimeConfigVersion();
  let notifiedVersion: number | null = null;
  const unsubscribe = subscribeRuntimeConfigChanges(() => {
    notifiedVersion = getRuntimeConfigVersion();
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    resourceLimits: {
      terminal: {
        visibleOutputQueueMaxBytes: 1_000_000,
      },
    },
  }), { status: 200 });

  try {
    await initializeInputReliabilityMode();

    assert.equal(getRuntimeConfigVersion(), beforeVersion + 1);
    assert.equal(notifiedVersion, beforeVersion + 1);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
  }
});

test('runtime config falls back to snapshot restore for invalid terminal hidden output limits', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'strict',
    resourceLimits: {
      terminal: {
        hiddenOutputPolicy: 'write-hidden',
        hiddenOutputTailBytes: -1,
      },
    },
  }), { status: 200 });

  try {
    const mode = await initializeInputReliabilityMode();

    assert.equal(mode, 'strict');
    assert.deepEqual(getTerminalResourceLimits(), {
      visibleOutputQueueMaxBytes: 4_194_304,
      visibleOutputMaxChunks: 512,
      visibleFlushBudgetBytes: 262_144,
      hiddenOutputPolicy: 'snapshot-restore',
      hiddenOutputTailBytes: 0,
      inputQueueMaxBytes: 65_536,
      inputQueueTtlMs: 1500,
      transportOutboxMaxBytes: 65_536,
      transportOutboxTtlMs: 1500,
      scrollbackLines: 10_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime config falls back to defaults for invalid resource limit sections', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'strict',
    resourceLimits: {
      clientWs: {
        inputBackpressureBytes: 4_000_000,
        hardReconnectBytes: 1_000_000,
      },
      terminal: {
        visibleOutputQueueMaxBytes: -1,
        visibleOutputMaxChunks: 0,
        visibleFlushBudgetBytes: 1.5,
        hiddenOutputPolicy: 'write-hidden',
        hiddenOutputTailBytes: -1,
        inputQueueMaxBytes: Number.POSITIVE_INFINITY,
        inputQueueTtlMs: '1500',
        transportOutboxMaxBytes: -100,
        transportOutboxTtlMs: null,
        scrollbackLines: -10,
      },
      snapshots: {
        perSnapshotMaxChars: 4_000_000,
        totalStorageBudgetChars: 2_000_000,
        maxEntries: 0,
        tombstoneTtlMs: -1,
      },
      workspaceRuntime: {
        maxLiveWorkspaces: 0,
        maxLiveTerminals: -5,
        hiddenRuntimeTtlMs: -1,
      },
    },
  }), { status: 200 });

  try {
    const mode = await initializeInputReliabilityMode();

    assert.equal(mode, 'strict');
    assert.deepEqual(getClientWsResourceLimits(), {
      inputBackpressureBytes: 1_048_576,
      hardReconnectBytes: 4_194_304,
    });
    assert.deepEqual(getTerminalResourceLimits(), {
      visibleOutputQueueMaxBytes: 4_194_304,
      visibleOutputMaxChunks: 512,
      visibleFlushBudgetBytes: 262_144,
      hiddenOutputPolicy: 'snapshot-restore',
      hiddenOutputTailBytes: 0,
      inputQueueMaxBytes: 65_536,
      inputQueueTtlMs: 1500,
      transportOutboxMaxBytes: 65_536,
      transportOutboxTtlMs: 1500,
      scrollbackLines: 10_000,
    });
    assert.deepEqual(getSnapshotResourceLimits(), {
      perSnapshotMaxChars: 2_000_000,
      totalStorageBudgetChars: 3_000_000,
      maxEntries: 16,
      tombstoneTtlMs: 86_400_000,
    });
    assert.deepEqual(getWorkspaceRuntimeResourceLimits(), {
      maxLiveWorkspaces: 3,
      maxLiveTerminals: 12,
      hiddenRuntimeTtlMs: 60_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime config falls back to unified for invalid websocket transport mode', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    wsTransportMode: 'dual-fast',
  }), { status: 200 });

  try {
    await initializeInputReliabilityMode();

    assert.equal(getWsTransportMode(), 'unified');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime config accepts split websocket transport mode', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    inputReliabilityMode: 'queue',
    wsTransportMode: 'split',
  }), { status: 200 });

  try {
    await initializeInputReliabilityMode();

    assert.equal(getWsTransportMode(), 'split');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
