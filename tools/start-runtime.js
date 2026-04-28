const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const daemonCli = require('./daemon/cli');
const { preflightConfig } = require('./daemon/config-preflight');
const daemonLauncher = require('./daemon/launcher');
const { CONFIG_ENV_KEY, resolveRuntimePaths } = require('./daemon/runtime-paths');
const { createFatalState, writeStateAtomic } = require('./daemon/state-store');
const { stopDaemon } = require('./daemon/stop-client');
const { runDaemonTotpPreflight } = require('./daemon/totp-preflight');

const RUNTIME_PATHS = resolveRuntimePaths();
const ROOT = RUNTIME_PATHS.root;
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const SERVER_DIR = RUNTIME_PATHS.serverDir;
const FRONTEND_DIST_DIR = path.join(FRONTEND_DIR, 'dist');
const FRONTEND_INDEX_HTML = path.join(FRONTEND_DIST_DIR, 'index.html');
const SERVER_DIST_DIR = RUNTIME_PATHS.serverDistDir;
const SERVER_ENTRY = RUNTIME_PATHS.serverEntry;
const SERVER_STRICT_CONFIG_LOADER = RUNTIME_PATHS.configLoaderEntry;
const SERVER_DAEMON_TOTP_PREFLIGHT = RUNTIME_PATHS.daemonTotpPreflightEntry;
const SERVER_PUBLIC_DIR = RUNTIME_PATHS.serverPublicDir;
const SERVER_PUBLIC_INDEX = RUNTIME_PATHS.webIndexPath;
const RUNTIME_CONFIG_PATH = RUNTIME_PATHS.configPath;
const LOCAL_BIN_DIRS = [
  path.join(ROOT, 'node_modules', '.bin'),
  path.join(SERVER_DIR, 'node_modules', '.bin'),
];
let daemonLogTeeInstalled = false;

const APP_NAME = 'buildergate';
const DEFAULT_PORT = 2222;

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function withLocalBinPath(env) {
  return daemonLauncher.withLocalBinPath(env, LOCAL_BIN_DIRS);
}

function parseArgs(argv) {
  return daemonCli.parseArgs(argv);
}

function loadConfigPort() {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) {
    return null;
  }

  const content = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8');
  const match = content.match(/server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d+)/);
  if (!match) {
    return null;
  }

  const configPort = Number.parseInt(match[1], 10);
  if (!Number.isInteger(configPort) || configPort < 1024 || configPort > 65535) {
    return null;
  }

  return configPort;
}

function resolvePort(cliPort, configPort = loadConfigPort()) {
  if (cliPort !== null) {
    return { port: cliPort, source: 'cli' };
  }

  if (configPort !== null) {
    return { port: configPort, source: 'config' };
  }

  return { port: DEFAULT_PORT, source: 'default' };
}

function parseValueSuffix(rawValue) {
  const commentIndex = findCommentStart(rawValue);
  const valueWithoutComment = commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue;
  const hasTrailingComma = valueWithoutComment.trimEnd().endsWith(',');
  const comment = commentIndex >= 0 ? ` ${rawValue.slice(commentIndex).trimStart()}` : '';
  return { hasTrailingComma, comment };
}

function findCommentStart(rawValue) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < rawValue.length - 1; index += 1) {
    const current = rawValue[index];
    const next = rawValue[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (current === '\\') {
      escaped = true;
      continue;
    }

    if (!inDoubleQuote && current === '\'') {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && current === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && current === '/' && next === '/') {
      return index;
    }
  }

  return -1;
}

function insertRootAuthSection(renderedLines) {
  let rootClosingIndex = -1;
  for (let index = renderedLines.length - 1; index >= 0; index -= 1) {
    if (/^\s*}\s*$/.test(renderedLines[index])) {
      rootClosingIndex = index;
      break;
    }
  }

  if (rootClosingIndex < 0) {
    throw new Error('Could not locate the root config closing brace');
  }

  renderedLines.splice(rootClosingIndex, 0, '  auth: {', '    password: "",', '  },');
}

function insertPasswordIntoExistingAuthSection(renderedLines) {
  let authStartIndex = -1;
  for (let index = 0; index < renderedLines.length; index += 1) {
    if (/^\s*auth:\s*\{\s*(?:\/\/.*)?$/.test(renderedLines[index].trim())) {
      authStartIndex = index;
      break;
    }
  }

  if (authStartIndex < 0) {
    return false;
  }

  let depth = 0;
  for (let index = authStartIndex; index < renderedLines.length; index += 1) {
    const line = renderedLines[index];
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;

    if (depth === 0) {
      const indent = line.match(/^(\s*)}/)?.[1] ?? '  ';
      renderedLines.splice(index, 0, `${indent}  password: "",`);
      return true;
    }
  }

  return false;
}

function resetPasswordInConfigContent(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const stack = [];
  const renderedLines = [];
  let replaced = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('}')) {
      const currentPath = stack.join('.');
      if (currentPath === 'auth' && !replaced) {
        const parentIndent = line.match(/^(\s*)}/)?.[1] ?? '';
        renderedLines.push(`${parentIndent}  password: "",`);
        replaced = true;
      }

      const closingCount = (trimmed.match(/}/g) || []).length;
      for (let index = 0; index < closingCount; index += 1) {
        stack.pop();
      }
      renderedLines.push(line);
      continue;
    }

    const objectMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*\{\s*(,?\s*(?:\/\/.*)?)?$/);
    if (objectMatch) {
      stack.push(objectMatch[2]);
      renderedLines.push(line);
      continue;
    }

    const valueMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.+)$/);
    if (!valueMatch) {
      renderedLines.push(line);
      continue;
    }

    const key = valueMatch[2];
    const path = [...stack, key].join('.');
    if (path !== 'auth.password') {
      renderedLines.push(line);
      continue;
    }

    const suffix = parseValueSuffix(valueMatch[3]);
    renderedLines.push(`${valueMatch[1]}${key}: ""${suffix.hasTrailingComma ? ',' : ''}${suffix.comment}`);
    replaced = true;
  }

  if (!replaced) {
    if (!insertPasswordIntoExistingAuthSection(renderedLines)) {
      insertRootAuthSection(renderedLines);
    }
  }

  return renderedLines.join(newline);
}

function resetPasswordInConfigFile(configPath = RUNTIME_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    console.log('[start] config.json5 not found. Bootstrap password is already unset; the server will create a fresh config on start.');
    return false;
  }

  const originalContent = fs.readFileSync(configPath, 'utf8');
  const nextContent = resetPasswordInConfigContent(originalContent);
  fs.writeFileSync(configPath, nextContent, 'utf8');
  console.log(`[start] auth.password cleared in ${configPath}`);
  return true;
}

function hasDeploymentArtifacts() {
  return (
    fs.existsSync(SERVER_ENTRY)
    && fs.existsSync(SERVER_STRICT_CONFIG_LOADER)
    && fs.existsSync(SERVER_DAEMON_TOTP_PREFLIGHT)
    && fs.existsSync(SERVER_PUBLIC_INDEX)
    && fs.existsSync(path.join(RUNTIME_PATHS.shellIntegrationDir, 'bash-osc133.sh'))
  );
}

function normalizeLogChunk(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
}

function installDaemonLogTee(logPath = process.env[daemonLauncher.DAEMON_LOG_PATH_KEY], options = {}) {
  if (daemonLogTeeInstalled || !logPath) {
    return false;
  }

  const echo = options.echo !== false;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const patchStream = (stream) => {
    const originalWrite = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      try {
        fs.appendFileSync(logPath, normalizeLogChunk(chunk, encoding));
      } catch {
        // Runtime logging must not prevent an internal daemon child from starting.
      }

      if (!echo) {
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') {
          process.nextTick(done);
        }
        return true;
      }

      try {
        return originalWrite(chunk, encoding, callback);
      } catch (error) {
        if (typeof callback === 'function') {
          callback(error);
        }
        return true;
      }
    };
  };

  patchStream(process.stdout);
  patchStream(process.stderr);
  daemonLogTeeInstalled = true;
  return true;
}

function ensureSafePublicTarget(targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  const expectedTarget = path.resolve(SERVER_PUBLIC_DIR);
  const serverRoot = path.resolve(SERVER_DIR);

  if (resolvedTarget !== expectedTarget) {
    throw new Error(`Refusing to modify unexpected staging directory: ${resolvedTarget}`);
  }

  if (resolvedTarget !== serverRoot && !resolvedTarget.startsWith(`${serverRoot}${path.sep}`)) {
    throw new Error(`Staging directory escaped server root: ${resolvedTarget}`);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: withLocalBinPath(options.env ?? process.env),
    stdio: options.stdio ?? 'inherit',
    shell: process.platform === 'win32',
    encoding: options.captureOutput ? 'utf8' : undefined,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const label = options.label ?? `${command} ${args.join(' ')}`;
    throw new Error(`${label} failed with exit code ${result.status}`);
  }

  return result;
}

function ensureDependenciesAndBuild() {
  if (hasDeploymentArtifacts()) {
    console.log('[start] Deployment dist already exists. Skipping install/build.');
    return;
  }

  if (RUNTIME_PATHS.isPackaged) {
    throw new Error(`Packaged runtime is incomplete. Missing embedded server artifacts or web assets for ${ROOT}`);
  }

  console.log('[start] Deployment dist missing. Installing dependencies...');
  runCommand(getNpmCommand(), ['install'], { cwd: FRONTEND_DIR, label: 'frontend npm install' });
  runCommand(getNpmCommand(), ['install'], { cwd: SERVER_DIR, label: 'server npm install' });

  console.log('[start] Building frontend first...');
  runCommand(getNpmCommand(), ['run', 'build'], { cwd: FRONTEND_DIR, label: 'frontend build' });

  if (!fs.existsSync(FRONTEND_INDEX_HTML)) {
    throw new Error(`Frontend build artifact missing after build: ${FRONTEND_INDEX_HTML}`);
  }

  console.log('[start] Building server...');
  runCommand(getNpmCommand(), ['run', 'build'], { cwd: SERVER_DIR, label: 'server build' });

  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Server build artifact missing after build: ${SERVER_ENTRY}`);
  }

  ensureSafePublicTarget(SERVER_PUBLIC_DIR);
  fs.rmSync(SERVER_PUBLIC_DIR, { recursive: true, force: true });
  fs.cpSync(FRONTEND_DIST_DIR, SERVER_PUBLIC_DIR, { recursive: true, force: true });

  if (!fs.existsSync(SERVER_PUBLIC_INDEX)) {
    throw new Error(`Frontend staging failed: ${SERVER_PUBLIC_INDEX}`);
  }

  console.log(`[start] Frontend assets staged into ${SERVER_PUBLIC_DIR}`);
}

function createRuntimeEnv(port, bootstrapAllowedIps = [], baseEnv = process.env, paths = RUNTIME_PATHS) {
  return daemonLauncher.createRuntimeEnv(port, bootstrapAllowedIps, baseEnv, paths, LOCAL_BIN_DIRS);
}

function createForegroundLaunchOptions(port, bootstrapAllowedIps = [], paths = RUNTIME_PATHS) {
  return daemonLauncher.createForegroundLaunchOptions(port, bootstrapAllowedIps, paths, {
    localBinDirs: LOCAL_BIN_DIRS,
  });
}

function startForeground(port, source, bootstrapAllowedIps = [], paths = RUNTIME_PATHS, options = {}) {
  return daemonLauncher.startForeground(port, source, bootstrapAllowedIps, paths, {
    localBinDirs: LOCAL_BIN_DIRS,
    ...options,
  });
}

async function startDaemon(port, source, bootstrapAllowedIps = [], paths = RUNTIME_PATHS, options = {}) {
  return daemonLauncher.startDaemon(port, source, bootstrapAllowedIps, paths, {
    localBinDirs: LOCAL_BIN_DIRS,
    ...options,
  });
}

async function runStrictConfigPreflight(options = {}) {
  const paths = options.paths ?? RUNTIME_PATHS;
  try {
    return await preflightConfig({
      paths,
      platform: options.platform ?? process.platform,
    });
  } catch (error) {
    if ((options.mode ?? 'daemon') === 'daemon') {
      const existing = options.inspectExistingDaemon
        ? await options.inspectExistingDaemon(paths)
        : await daemonLauncher.inspectExistingDaemon(paths);
      const active = options.isExistingDaemonActive
        ? await options.isExistingDaemonActive(existing.state)
        : existing.active || existing.status === 'unknown';
      if (active) {
        throw error;
      }

      const fatalState = createFatalState({
        stage: 'preflight',
        message: error instanceof Error ? error.message : String(error),
        paths,
        port: null,
      });
      writeStateAtomic(paths.statePath, fatalState);
    }
    throw error;
  }
}

async function runInternalApp(paths = RUNTIME_PATHS) {
  if (!fs.existsSync(paths.serverEntry)) {
    throw new Error(`Packaged server entry is not available: ${paths.serverEntry}`);
  }

  if (paths.isPackaged || path.extname(paths.serverEntry) === '.cjs') {
    require(paths.serverEntry);
    return;
  }

  await import(pathToFileURL(paths.serverEntry).href);
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const isInternalApp = parsedArgs.internalApp || (process.pkg && process.env.BUILDERGATE_INTERNAL_MODE === 'app');
  const isInternalSentinel = process.env.BUILDERGATE_INTERNAL_MODE === 'sentinel' || parsedArgs.internalSentinel;

  if (process.pkg && (isInternalApp || isInternalSentinel)) {
    installDaemonLogTee(undefined, { echo: false });
  }

  if (isInternalApp) {
    await runInternalApp();
    return;
  }

  if (isInternalSentinel) {
    daemonLauncher.runSentinelLoop();
    return;
  }

  if (parsedArgs.help) {
    console.log(daemonCli.formatHelp({
      executableName: process.pkg ? path.basename(process.execPath) : 'start.sh',
      packaged: Boolean(process.pkg),
    }));
    return;
  }

  if (parsedArgs.command === 'stop') {
    const result = await stopDaemon(RUNTIME_PATHS);
    if (result.message) {
      const log = result.exitCode === 0 ? console.log : console.error;
      log(result.message);
    }
    process.exitCode = result.exitCode;
    return;
  }

  const { cliPort, resetPassword, bootstrapAllowedIps } = parsedArgs;

  ensureDependenciesAndBuild();
  const preflight = await runStrictConfigPreflight({ mode: parsedArgs.mode });
  const { port, source } = resolvePort(cliPort, preflight.config.server.port);

  if (parsedArgs.mode === 'foreground') {
    process.exitCode = await startForeground(port, source, bootstrapAllowedIps);
    return;
  }

  const exitCode = await startDaemon(port, source, bootstrapAllowedIps, RUNTIME_PATHS, {
    beforeSpawn: resetPassword ? () => resetPasswordInConfigFile() : undefined,
    requiresFreshStart: resetPassword,
    freshStartReason: '--reset-password requires a new daemon process so the cleared password can take effect.',
    daemonPreflight: ({ paths }) => runDaemonTotpPreflight({
      paths,
      config: preflight.config,
    }),
  });
  process.exitCode = exitCode;
  if (exitCode !== 0) {
    return;
  }

  console.log('[start] Deployed in background with native daemon.');
  console.log(`[start] App name: ${APP_NAME}`);
  console.log(`[start] Config: ${RUNTIME_CONFIG_PATH}`);
  console.log(`[start] HTTPS: https://localhost:${port}`);
  console.log(`[start] HTTP redirect: http://localhost:${port - 1}`);
  if (bootstrapAllowedIps.length > 0) {
    console.log(`[start] Temporary bootstrap allowlist: ${bootstrapAllowedIps.join(', ')}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[start] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  APP_NAME,
  CONFIG_ENV_KEY,
  DEFAULT_PORT,
  parseBootstrapAllowIps: daemonCli.parseBootstrapAllowIps,
  parseArgs,
  loadConfigPort,
  resolvePort,
  hasDeploymentArtifacts,
  installDaemonLogTee,
  resetPasswordInConfigContent,
  resetPasswordInConfigFile,
  createRuntimeEnv,
  createForegroundLaunchOptions,
  runStrictConfigPreflight,
  runInternalApp,
  startDaemon,
  startForeground,
  stopDaemon,
  main,
};
