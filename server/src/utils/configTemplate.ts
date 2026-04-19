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
