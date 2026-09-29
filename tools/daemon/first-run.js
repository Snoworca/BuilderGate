// FR-BGSTAB-032 — first run picks a free port, and the packaged executable opens the browser.
//
// The port is persisted only in config.json5 server.port. A separate port file was considered and
// rejected: config.json5 already survives upgrades (OPS-BGSTAB-020) and a second file would be a
// second source of truth.

const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');

const NO_BROWSER_ENV_KEY = 'BUILDERGATE_NO_BROWSER';
const FREE_PORT_SEARCH_LIMIT = 100;
const SERVER_PORT_PATTERN = /(server\s*:\s*\{[^}]*?\bport\s*:\s*)(\d+)/;
const WINDOWS_HTTPS_HANDLER_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';

// No daemon state yet under this data root: the launcher has never started from it.
function isFirstRun(paths) {
  return !fs.existsSync(paths.statePath);
}

function probe(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve(error.code !== 'EADDRINUSE' && error.code !== 'EACCES'));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

// The server listens on both stacks, so a listener on either one takes the port.
async function isPortFree(port) {
  return (await probe(port, '0.0.0.0')) && (await probe(port, '::'));
}

async function findFreePort(start, options = {}) {
  const isFree = options.isPortFree ?? isPortFree;
  const limit = options.limit ?? FREE_PORT_SEARCH_LIMIT;
  for (let port = start + 1; port <= Math.min(start + limit, 65535); port += 1) {
    if (await isFree(port)) {
      return port;
    }
  }
  return null;
}

function writeConfigPort(configPath, port) {
  const content = fs.readFileSync(configPath, 'utf8');
  if (!SERVER_PORT_PATTERN.test(content)) {
    throw new Error(`Cannot find server.port in ${configPath}`);
  }
  fs.writeFileSync(configPath, content.replace(SERVER_PORT_PATTERN, `$1${port}`), 'utf8');
}

// AC-1: only on first run and only for a port the user did not name. Later runs keep the saved
// port so a bookmarked address never moves; startDaemon refuses a taken one instead (AC-2).
async function chooseStartPort({ port, source, firstRun, configPath }, deps = {}) {
  const isFree = deps.isPortFree ?? isPortFree;
  const log = deps.log ?? console.log;
  if (!firstRun || source === 'cli' || (await isFree(port))) {
    return { port, source, movedFrom: null };
  }

  const freePort = await findFreePort(port, { isPortFree: isFree });
  if (freePort === null) {
    return { port, source, movedFrom: null };
  }

  try {
    writeConfigPort(configPath, freePort);
    log(`[start] Port ${port} is in use by another program; using ${freePort} and saving it as server.port in ${configPath}.`);
  } catch (error) {
    log(`[start] Port ${port} is in use by another program; using ${freePort} for this run (${error instanceof Error ? error.message : error}).`);
  }
  return { port: freePort, source: 'config', movedFrom: port };
}

function shouldOpenBrowser({ isPackaged, mode, firstRun, open, env = process.env }) {
  if (!isPackaged || mode !== 'daemon' || env[NO_BROWSER_ENV_KEY] === '1') {
    return false;
  }
  return Boolean(firstRun || open);
}

function hasDefaultBrowser(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runSync = options.runSync ?? ((command, args) => childProcess.spawnSync(command, args, {
    stdio: 'ignore',
    windowsHide: true,
  }));

  if (platform === 'win32') {
    return runSync('reg.exe', ['query', WINDOWS_HTTPS_HANDLER_KEY, '/v', 'ProgId']).status === 0;
  }
  if (platform === 'darwin') {
    return true;
  }
  // Linux: only with a graphical session and xdg-open on PATH.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return false;
  }
  return runSync('sh', ['-c', 'command -v xdg-open']).status === 0;
}

function browserCommand(platform, url) {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  return { command: 'xdg-open', args: [url] };
}

// Opening the page is a convenience; it must never fail the start.
function openBrowser(url, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? childProcess.spawn;
  const { command, args } = browserCommand(platform, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  NO_BROWSER_ENV_KEY,
  chooseStartPort,
  findFreePort,
  hasDefaultBrowser,
  isFirstRun,
  isPortFree,
  openBrowser,
  shouldOpenBrowser,
  writeConfigPort,
};
