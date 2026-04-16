const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const SERVER_DIR = path.join(ROOT, 'server');
const FRONTEND_DIST_DIR = path.join(FRONTEND_DIR, 'dist');
const FRONTEND_INDEX_HTML = path.join(FRONTEND_DIST_DIR, 'index.html');
const SERVER_DIST_DIR = path.join(SERVER_DIR, 'dist');
const SERVER_ENTRY = path.join(SERVER_DIST_DIR, 'index.js');
const SERVER_PUBLIC_DIR = path.join(SERVER_DIST_DIR, 'public');
const SERVER_PUBLIC_INDEX = path.join(SERVER_PUBLIC_DIR, 'index.html');
const SERVER_CONFIG_PATH = path.join(SERVER_DIR, 'config.json5');

const APP_NAME = 'projectmaster';
const DEFAULT_PORT = 2222;

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getPm2Command() {
  return process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
}

function parseArgs(argv) {
  let cliPort = null;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if ((current === '--help') || (current === '-h')) {
      console.log('Usage: start.sh [-p <port>]');
      console.log('   or: start.bat -p <port>');
      process.exit(0);
    }

    if ((current === '-p' || current === '--port') && argv[index + 1]) {
      cliPort = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  if (cliPort !== null && (!Number.isInteger(cliPort) || cliPort < 1024 || cliPort > 65535)) {
    throw new Error(`-p/--port must be between 1024 and 65535 (got: ${cliPort})`);
  }

  return { cliPort };
}

function loadConfigPort() {
  if (!fs.existsSync(SERVER_CONFIG_PATH)) {
    return null;
  }

  const content = fs.readFileSync(SERVER_CONFIG_PATH, 'utf8');
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

function hasDeploymentArtifacts() {
  return fs.existsSync(SERVER_ENTRY) && fs.existsSync(SERVER_PUBLIC_INDEX);
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
    env: options.env ?? process.env,
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

function ensurePm2Installed() {
  if (isPm2Installed()) {
    console.log('[start] pm2 already installed.');
    return;
  }

  console.log('[start] pm2 not found. Installing globally...');
  runCommand(getNpmCommand(), ['install', '-g', 'pm2'], {
    label: 'npm install -g pm2',
  });
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

function hasPm2App(appName) {
  return getPm2ProcessList().some((app) => app.name === appName);
}

function startWithPm2(port, source) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
  };

  if (hasPm2App(APP_NAME)) {
    console.log(`[start] Removing existing pm2 app "${APP_NAME}" before redeploy.`);
    runCommand(getPm2Command(), ['delete', APP_NAME], {
      env,
      label: `pm2 delete ${APP_NAME}`,
    });
  }

  console.log(`[start] Starting pm2 app "${APP_NAME}" on port ${port} (${source})...`);
  runCommand(getPm2Command(), ['start', 'dist/index.js', '--name', APP_NAME, '--cwd', SERVER_DIR, '--time'], {
    env,
    label: `pm2 start ${APP_NAME}`,
  });

  runCommand(getPm2Command(), ['status', APP_NAME], {
    env,
    label: `pm2 status ${APP_NAME}`,
  });
}

function main() {
  const { cliPort } = parseArgs(process.argv.slice(2));
  const { port, source } = resolvePort(cliPort);

  ensureDependenciesAndBuild();
  ensurePm2Installed();
  startWithPm2(port, source);

  console.log('[start] Deployed in background with pm2.');
  console.log(`[start] App name: ${APP_NAME}`);
  console.log(`[start] HTTPS: https://localhost:${port}`);
  console.log(`[start] HTTP redirect: http://localhost:${port - 1}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[start] Failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = {
  APP_NAME,
  DEFAULT_PORT,
  parseArgs,
  loadConfigPort,
  resolvePort,
  hasDeploymentArtifacts,
  main,
};
