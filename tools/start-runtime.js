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

function parseBootstrapAllowIps(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  let cliPort = null;
  let resetPassword = false;
  const bootstrapAllowedIps = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if ((current === '--help') || (current === '-h')) {
      console.log('Usage: start.sh [-p <port>] [--reset-password] [--bootstrap-allow-ip <ip[,ip]>]');
      console.log('   or: start.bat -p <port> [--reset-password] [--bootstrap-allow-ip <ip[,ip]>]');
      console.log('');
      console.log('Options:');
      console.log('  -p, --port                Override HTTPS port');
      console.log('  --reset-password          Clear auth.password in server/config.json5 before launch');
      console.log('  --bootstrap-allow-ip      Temporarily allow specific IP(s) for initial password bootstrap');
      process.exit(0);
    }

    if ((current === '-p' || current === '--port') && argv[index + 1]) {
      cliPort = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (current === '--reset-password') {
      resetPassword = true;
      continue;
    }

    if (current === '--bootstrap-allow-ip') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--bootstrap-allow-ip requires an IP value');
      }
      bootstrapAllowedIps.push(...parseBootstrapAllowIps(next));
      index += 1;
    }
  }

  if (cliPort !== null && (!Number.isInteger(cliPort) || cliPort < 1024 || cliPort > 65535)) {
    throw new Error(`-p/--port must be between 1024 and 65535 (got: ${cliPort})`);
  }

  return {
    cliPort,
    resetPassword,
    bootstrapAllowedIps: [...new Set(bootstrapAllowedIps)],
  };
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

function resetPasswordInConfigFile(configPath = SERVER_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    console.log('[start] config.json5 not found. Bootstrap password is already unset; the server will create a fresh config on start.');
    return false;
  }

  const originalContent = fs.readFileSync(configPath, 'utf8');
  const nextContent = resetPasswordInConfigContent(originalContent);
  fs.writeFileSync(configPath, nextContent, 'utf8');
  console.log('[start] auth.password cleared in server/config.json5');
  return true;
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

function startWithPm2(port, source, bootstrapAllowedIps = []) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
  };
  if (bootstrapAllowedIps.length > 0) {
    env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS = bootstrapAllowedIps.join(',');
  }

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
  const { cliPort, resetPassword, bootstrapAllowedIps } = parseArgs(process.argv.slice(2));
  const { port, source } = resolvePort(cliPort);

  if (resetPassword) {
    resetPasswordInConfigFile();
  }

  ensureDependenciesAndBuild();
  ensurePm2Installed();
  startWithPm2(port, source, bootstrapAllowedIps);

  console.log('[start] Deployed in background with pm2.');
  console.log(`[start] App name: ${APP_NAME}`);
  console.log(`[start] HTTPS: https://localhost:${port}`);
  console.log(`[start] HTTP redirect: http://localhost:${port - 1}`);
  if (bootstrapAllowedIps.length > 0) {
    console.log(`[start] Temporary bootstrap allowlist: ${bootstrapAllowedIps.join(', ')}`);
  }
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
  parseBootstrapAllowIps,
  parseArgs,
  loadConfigPort,
  resolvePort,
  hasDeploymentArtifacts,
  resetPasswordInConfigContent,
  resetPasswordInConfigFile,
  main,
};
