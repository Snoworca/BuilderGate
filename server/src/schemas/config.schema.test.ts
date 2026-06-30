import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from './config.schema.js';

function minimalConfig() {
  return {
    server: { port: 2002 },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 2097152,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
      runningDelayMs: 250,
    },
  };
}

test('configSchema applies resourceLimits defaults to legacy config files', () => {
  const parsed = configSchema.parse(minimalConfig());

  assert.equal(parsed.resourceLimits.headless.pendingOutputMaxBytes, 8388608);
  assert.equal(parsed.resourceLimits.headless.pendingOutputMaxChunks, 1024);
  assert.equal(parsed.resourceLimits.headless.overflowPolicy, 'degrade-headless');
  assert.equal(parsed.resourceLimits.ws.serverBufferedHighWaterBytes, 8388608);
  assert.equal(parsed.resourceLimits.ws.serverBufferedHardLimitBytes, 33554432);
  assert.equal(parsed.resourceLimits.clientWs.inputBackpressureBytes, 1048576);
  assert.equal(parsed.resourceLimits.terminal.hiddenOutputPolicy, 'snapshot-restore');
  assert.equal(parsed.resourceLimits.terminal.hiddenOutputTailBytes, 262144);
  assert.equal(parsed.resourceLimits.snapshots.maxEntries, 16);
  assert.equal(parsed.resourceLimits.workspaceRuntime.maxLiveTerminals, 12);
  assert.equal(parsed.resourceLimits.telemetry.recentEventLimit, 256);
  assert.equal(parsed.stabilityModes.headlessQueueMode, 'observe');
  assert.equal(parsed.stabilityModes.wsSendMode, 'direct');
  assert.equal(parsed.stabilityModes.frontendRuntimeResidency, 'bounded');
});

test('configSchema applies session processCleanup observe-mode defaults', () => {
  const parsed = configSchema.parse(minimalConfig());

  assert.equal(parsed.session.processCleanup.mode, 'observe');
  assert.equal(parsed.session.processCleanup.gracefulWaitMs, 750);
  assert.equal(parsed.session.processCleanup.forceWaitMs, 1500);
  assert.equal(parsed.session.processCleanup.descendantSampleLimit, 64);
});

test('configSchema validates session processCleanup strictly', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: null,
      },
    }),
    /processCleanup|object|null/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          mode: 'force',
        },
      },
    }),
    /mode|observe|enforce|legacy/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          descendantSampleLimit: 0,
        },
      },
    }),
    /descendantSampleLimit/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          gracefulWaitMs: 750.5,
        },
      },
    }),
    /gracefulWaitMs/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      session: {
        idleDelayMs: 200,
        runningDelayMs: 250,
        processCleanup: {
          unknownCleanupSwitch: true,
        },
      },
    }),
    /unknownCleanupSwitch|unrecognized/i,
  );
});

test('configSchema validates unsafe resourceLimits values instead of silently stripping them', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        terminal: {
          inputQueueMaxBytes: 0,
        },
      },
    }),
    /resourceLimits|inputQueueMaxBytes/i,
  );
});

test('configSchema rejects misspelled resourceLimits keys instead of defaulting around them', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        terminal: {
          inputQueueMaxBytez: 0,
        },
      },
    }),
    /inputQueueMaxBytez|unrecognized/i,
  );
});

test('configSchema rejects explicit null resourceLimits sections instead of treating them as omitted', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: null,
    }),
    /resourceLimits|object|null/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        terminal: null,
      },
    }),
    /terminal|object|null/i,
  );
});

test('configSchema rejects inconsistent resourceLimits relationships', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        ws: {
          serverBufferedHighWaterBytes: 8388608,
          serverBufferedHardLimitBytes: 1048576,
        },
      },
    }),
    /serverBufferedHardLimitBytes/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        clientWs: {
          inputBackpressureBytes: 4194304,
          hardReconnectBytes: 1048576,
        },
      },
    }),
    /hardReconnectBytes/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        snapshots: {
          perSnapshotMaxChars: 3000000,
          totalStorageBudgetChars: 2000000,
        },
      },
    }),
    /totalStorageBudgetChars/i,
  );
});

test('configSchema rejects zero output coalesce window', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      resourceLimits: {
        ws: {
          outputCoalesceWindowMs: 0,
        },
      },
    }),
    /outputCoalesceWindowMs|greater than or equal to 1|too small/i,
  );
});

test('configSchema rejects headless overflow policies that are not implemented', () => {
  for (const overflowPolicy of ['drop-tail', 'terminate-session']) {
    assert.throws(
      () => configSchema.parse({
        ...minimalConfig(),
        resourceLimits: {
          headless: {
            overflowPolicy,
          },
        },
      }),
      /overflowPolicy|degrade-headless/i,
    );
  }
});

test('configSchema validates stabilityModes strictly', () => {
  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      stabilityModes: null,
    }),
    /stabilityModes|object|null/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      stabilityModes: {
        wsSendMode: 'queued',
      },
    }),
    /wsSendMode|direct|safe-send/i,
  );

  assert.throws(
    () => configSchema.parse({
      ...minimalConfig(),
      stabilityModes: {
        frontendRuntimeResidency: 'bounded',
        unknownSwitch: true,
      },
    }),
    /unknownSwitch|unrecognized/i,
  );
});
