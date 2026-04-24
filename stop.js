const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_NAME = 'buildergate';
const LEGACY_APP_NAMES = ['projectmaster'];

function resolveRuntimeRoot() {
  if (process.env.BUILDERGATE_ROOT) {
    return path.resolve(process.env.BUILDERGATE_ROOT);
  }

  if (process.pkg) {
    return path.dirname(process.execPath);
  }

  return __dirname;
}

const ROOT = resolveRuntimeRoot();
const LOCAL_BIN_DIRS = [
  path.join(ROOT, 'node_modules', '.bin'),
  path.join(ROOT, 'server', 'node_modules', '.bin'),
];

function getPm2Command() {
  const commandName = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
  const localCandidates = LOCAL_BIN_DIRS.map((binDir) => path.join(binDir, commandName));

  for (const candidate of localCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return commandName;
}

function getPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function withLocalBinPath(env) {
  const pathKey = getPathKey(env);
  const existingPath = env[pathKey] ?? '';
  const localPath = LOCAL_BIN_DIRS.filter((binDir) => fs.existsSync(binDir)).join(path.delimiter);
  if (!localPath) {
    return env;
  }

  return {
    ...env,
    [pathKey]: existingPath ? `${localPath}${path.delimiter}${existingPath}` : localPath,
  };
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

function isPm2Installed() {
  try {
    runCommand(getPm2Command(), ['-v'], {
      stdio: 'ignore',
      label: 'pm2 version check',
    });
    return true;
  } catch {
    return false;
  }
}

function getPm2ProcessList() {
  const result = runCommand(getPm2Command(), ['jlist'], {
    captureOutput: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    label: 'pm2 jlist',
  });

  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    return [];
  }

  return JSON.parse(stdout);
}

function main() {
  if (!isPm2Installed()) {
    console.log('[stop] pm2 is not installed. Nothing to stop.');
    return;
  }

  const runningAppNames = new Set(getPm2ProcessList().map((app) => app.name));
  const targetAppNames = [APP_NAME, ...LEGACY_APP_NAMES].filter((appName) => runningAppNames.has(appName));
  if (targetAppNames.length === 0) {
    console.log(`[stop] pm2 app "${APP_NAME}" is not running.`);
    return;
  }

  for (const appName of targetAppNames) {
    runCommand(getPm2Command(), ['stop', appName], {
      label: `pm2 stop ${appName}`,
    });
    runCommand(getPm2Command(), ['delete', appName], {
      label: `pm2 delete ${appName}`,
    });

    console.log(`[stop] pm2 app "${appName}" stopped and removed.`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[stop] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
