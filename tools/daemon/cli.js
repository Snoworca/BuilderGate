const path = require('path');

function parseBootstrapAllowIps(value) {
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (parsed.length === 0) {
    throw new Error('--bootstrap-allow-ip requires at least one IP value');
  }

  return parsed;
}

function parsePort(rawValue, optionName) {
  if (!/^\d+$/.test(String(rawValue))) {
    throw new Error(`${optionName} requires a valid integer port value`);
  }

  const port = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${optionName} must be between 1024 and 65535 (got: ${rawValue})`);
  }

  return port;
}

function readRequiredValue(argv, index, optionName, description) {
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${optionName} requires ${description}`);
  }

  return next;
}

function parseArgs(argv) {
  const parsed = {
    mode: 'daemon',
    cliPort: null,
    port: null,
    resetPassword: false,
    bootstrapAllowedIps: [],
    internalSentinel: false,
    internalSentinelStatePath: null,
    internalSentinelStartAttemptId: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--help' || current === '-h') {
      parsed.help = true;
      continue;
    }

    if (current === '--foreground' || current === '--forground') {
      parsed.mode = 'foreground';
      continue;
    }

    if (current === '--internal-sentinel') {
      parsed.internalSentinel = true;
      continue;
    }

    if (current === '--internal-sentinel-state') {
      const next = readRequiredValue(argv, index, current, 'a daemon state path');
      parsed.internalSentinelStatePath = next;
      index += 1;
      continue;
    }

    if (current === '--internal-sentinel-start') {
      const next = readRequiredValue(argv, index, current, 'a daemon start attempt id');
      parsed.internalSentinelStartAttemptId = next;
      index += 1;
      continue;
    }

    if (current === '-p' || current === '--port') {
      const next = readRequiredValue(argv, index, current, 'a port value');
      parsed.cliPort = parsePort(next, current);
      parsed.port = parsed.cliPort;
      index += 1;
      continue;
    }

    if (current.startsWith('--port=')) {
      parsed.cliPort = parsePort(current.slice('--port='.length), '--port');
      parsed.port = parsed.cliPort;
      continue;
    }

    if (current === '--reset-password') {
      parsed.resetPassword = true;
      continue;
    }

    if (current === '--bootstrap-allow-ip') {
      const next = readRequiredValue(argv, index, current, 'an IP value');
      parsed.bootstrapAllowedIps.push(...parseBootstrapAllowIps(next));
      index += 1;
      continue;
    }

    if (current.startsWith('--bootstrap-allow-ip=')) {
      parsed.bootstrapAllowedIps.push(...parseBootstrapAllowIps(current.slice('--bootstrap-allow-ip='.length)));
      continue;
    }

    throw new Error(`Unknown option: ${current}`);
  }

  parsed.bootstrapAllowedIps = [...new Set(parsed.bootstrapAllowedIps)];
  return parsed;
}

function formatHelp(options = {}) {
  const executableName = options.executableName ?? (process.pkg ? path.basename(process.execPath) : 'start.sh');
  const stopCommand = process.platform === 'win32' ? 'BuilderGateStop.exe' : 'buildergate-stop';
  const configPolicy = options.packaged ?? process.pkg
    ? 'config.json5 next to the executable'
    : 'server/config.json5 unless BUILDERGATE_CONFIG_PATH overrides it';

  return [
    `Usage: ${executableName} [--foreground|--forground] [-p <port>] [--reset-password] [--bootstrap-allow-ip <ip[,ip]>]`,
    '',
    'BuilderGate default mode is daemon. Use --foreground or legacy --forground to run in the current console.',
    '',
    'Options:',
    '  -p, --port                Override HTTPS port',
    '  --foreground             Run in the current console instead of daemon mode',
    '  --forground              Legacy alias for --foreground',
    '  --reset-password          Clear auth.password in config.json5 before launch',
    '  --bootstrap-allow-ip      Temporarily allow specific IP(s) for initial password bootstrap',
    '  -h, --help                Show this help',
    '',
    `Stop command: ${stopCommand}`,
    'Packaged output: dist/bin',
    `Config policy: ${configPolicy}`,
  ].join('\n');
}

module.exports = {
  formatHelp,
  parseArgs,
  parseBootstrapAllowIps,
};
