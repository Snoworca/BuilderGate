import type { BootstrapConfig, PTYConfig } from '../types/config.types.js';
import { getBootstrapPtyDefaults } from './ptyPlatformPolicy.js';

const DEFAULT_BOOTSTRAP: BootstrapConfig = {
  allowedIps: [],
};

function renderArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

export function renderBootstrapConfigTemplate(platform: NodeJS.Platform): string {
  const ptyDefaults: Pick<PTYConfig, 'useConpty' | 'windowsPowerShellBackend' | 'shell'> =
    getBootstrapPtyDefaults(platform);

  return `{
  // BuilderGate Server Configuration
  // Created automatically on first run.
  // Initial administrator password is configured in the browser bootstrap flow.

  server: {
    port: 2002,
  },

  pty: {
    termName: "xterm-256color",
    defaultCols: 80,
    defaultRows: 24,
    useConpty: ${ptyDefaults.useConpty},
    windowsPowerShellBackend: ${JSON.stringify(ptyDefaults.windowsPowerShellBackend)},
    scrollbackLines: 1000,
    maxSnapshotBytes: 2097152,
    shell: ${JSON.stringify(ptyDefaults.shell)},
  },

  session: {
    idleDelayMs: 200,
    runningDelayMs: 250,
    processCleanup: {
      mode: "observe",
      gracefulWaitMs: 750,
      forceWaitMs: 1500,
      descendantSampleLimit: 64,
    },
  },

  realtime: {
    wsTransportMode: "unified",
  },

  resourceLimits: {
    headless: {
      pendingOutputMaxBytes: 8388608,
      pendingOutputMaxChunks: 1024,
      writeLagWarnMs: 500,
      writeBatchMaxBytes: 65536,
      overflowPolicy: "degrade-headless",
    },
    ws: {
      serverBufferedHighWaterBytes: 8388608,
      serverBufferedHardLimitBytes: 33554432,
      perClientOutputQueueMaxBytes: 2097152,
      perClientControlQueueMaxBytes: 262144,
      outputCoalesceWindowMs: 16,
    },
    clientWs: {
      inputBackpressureBytes: 1048576,
      hardReconnectBytes: 4194304,
    },
    terminal: {
      visibleOutputQueueMaxBytes: 4194304,
      visibleOutputMaxChunks: 512,
      visibleFlushBudgetBytes: 262144,
      hiddenOutputPolicy: "snapshot-restore",
      hiddenOutputTailBytes: 0,
      inputQueueMaxBytes: 65536,
      inputQueueTtlMs: 1500,
      transportOutboxMaxBytes: 65536,
      transportOutboxTtlMs: 1500,
      scrollbackLines: 10000,
    },
    snapshots: {
      perSnapshotMaxChars: 2000000,
      totalStorageBudgetChars: 3000000,
      maxEntries: 16,
      tombstoneTtlMs: 86400000,
    },
    workspaceRuntime: {
      maxLiveWorkspaces: 3,
      maxLiveTerminals: 12,
      hiddenRuntimeTtlMs: 60000,
    },
    telemetry: {
      sampleIntervalMs: 60000,
      recentEventLimit: 256,
    },
  },

  stabilityModes: {
    headlessQueueMode: "observe",
    wsSendMode: "direct",
    frontendRuntimeResidency: "legacy",
  },

  ssl: {
    certPath: "",
    keyPath: "",
    caPath: "",
  },

  security: {
    cors: {
      allowedOrigins: [],
      credentials: true,
      maxAge: 86400,
    },
  },

  logging: {
    level: "info",
    audit: true,
    directory: "logs",
    maxSize: "10m",
    maxFiles: 14,
  },

  bootstrap: {
    allowedIps: ${renderArray(DEFAULT_BOOTSTRAP.allowedIps)},
  },

  auth: {
    password: "",
    durationMs: 1800000,
    maxDurationMs: 86400000,
    jwtSecret: "",
    localhostPasswordOnly: false,
  },

  fileManager: {
    maxFileSize: 1048576,
    maxCodeFileSize: 524288,
    maxDirectoryEntries: 10000,
    blockedExtensions: [".exe", ".dll", ".so", ".bin"],
    blockedPaths: [".ssh", ".gnupg", ".aws"],
    cwdCacheTtlMs: 1000,
  },

  workspace: {
    dataPath: "./data/workspaces.json",
    maxWorkspaces: 10,
    maxTabsPerWorkspace: 8,
    maxTotalSessions: 32,
    flushDebounceMs: 5000,
  },

  twoFactor: {
    enabled: false,
    externalOnly: false,
    issuer: "BuilderGate",
    accountName: "admin",
  },
}
`;
}
