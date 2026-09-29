const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  chooseStartPort,
  findFreePort,
  hasDefaultBrowser,
  isFirstRun,
  isPortFree,
  openBrowser,
  shouldOpenBrowser,
  writeConfigPort,
} = require('./first-run');

// FR-BGSTAB-032 — first run picks a free port and the executable opens the default browser.

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('FR-BGSTAB-032: first run means no daemon state file yet', () => {
  const dir = tempDir('bg-first-run-');
  const statePath = path.join(dir, 'runtime', 'buildergate.daemon.json');
  assert.equal(isFirstRun({ statePath }), true);
  fs.mkdirSync(path.dirname(statePath));
  fs.writeFileSync(statePath, '{}');
  assert.equal(isFirstRun({ statePath }), false);
});

test('FR-BGSTAB-032 AC-1: isPortFree reports a port another listener holds as taken', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await isPortFree(port), true);
});

test('FR-BGSTAB-032 AC-1: findFreePort returns the next free port above the taken one', async () => {
  const taken = new Set([2002, 2003, 2004]);
  const free = async (port) => !taken.has(port);
  assert.equal(await findFreePort(2002, { isPortFree: free }), 2005);
  assert.equal(await findFreePort(2002, { isPortFree: async () => false, limit: 5 }), null);
  assert.equal(await findFreePort(65534, { isPortFree: async (port) => port > 65535 }), null);
});

test('FR-BGSTAB-032 AC-1: writeConfigPort rewrites only server.port and keeps the rest', () => {
  const dir = tempDir('bg-config-port-');
  const configPath = path.join(dir, 'config.json5');
  const original = [
    '// BuilderGate',
    '{',
    '  server: {',
    '    port: 2002, // HTTPS',
    '  },',
    '  mcp: { port: 3333 },',
    '  auth: { password: "" },',
    '}',
    '',
  ].join('\r\n');
  fs.writeFileSync(configPath, original);

  writeConfigPort(configPath, 2005);

  assert.equal(fs.readFileSync(configPath, 'utf8'), original.replace('port: 2002', 'port: 2005'));
  fs.writeFileSync(configPath, '{ auth: {} }');
  assert.throws(() => writeConfigPort(configPath, 2005), /server\.port/);
});

test('FR-BGSTAB-032 AC-3: the browser opens only for the packaged daemon on first run or --open', () => {
  const base = { isPackaged: true, mode: 'daemon', firstRun: true, open: false, env: {} };
  assert.equal(shouldOpenBrowser(base), true);
  assert.equal(shouldOpenBrowser({ ...base, firstRun: false }), false);
  assert.equal(shouldOpenBrowser({ ...base, firstRun: false, open: true }), true);
  assert.equal(shouldOpenBrowser({ ...base, isPackaged: false }), false);
  assert.equal(shouldOpenBrowser({ ...base, mode: 'foreground' }), false);
  assert.equal(shouldOpenBrowser({ ...base, env: { BUILDERGATE_NO_BROWSER: '1' } }), false);
});

test('FR-BGSTAB-032 AC-3: Windows needs a registered https handler before opening', () => {
  const calls = [];
  const registered = (command, args) => { calls.push([command, ...args]); return { status: 0 }; };
  assert.equal(hasDefaultBrowser({ platform: 'win32', runSync: registered }), true);
  assert.match(calls[0].join(' '), /reg(\.exe)? query .*UrlAssociations\\https\\UserChoice/);
  assert.equal(hasDefaultBrowser({ platform: 'win32', runSync: () => ({ status: 1 }) }), false);
  assert.equal(hasDefaultBrowser({ platform: 'linux', env: {}, runSync: registered }), false);
  assert.equal(hasDefaultBrowser({ platform: 'darwin', runSync: registered }), true);
});

test('FR-BGSTAB-032 AC-3: openBrowser launches detached and never throws', () => {
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    return { unref() {}, on() {} };
  };
  assert.equal(openBrowser('https://localhost:2005', { platform: 'win32', spawn }), true);
  assert.equal(spawned[0].command, 'rundll32.exe');
  assert.deepEqual(spawned[0].args, ['url.dll,FileProtocolHandler', 'https://localhost:2005']);
  assert.equal(spawned[0].options.detached, true);

  const failing = () => { throw new Error('ENOENT'); };
  assert.equal(openBrowser('https://localhost:2005', { platform: 'win32', spawn: failing }), false);
});

test('FR-BGSTAB-032 AC-1: chooseStartPort moves a taken config port on first run and saves it', async () => {
  const dir = tempDir('bg-choose-port-');
  const configPath = path.join(dir, 'config.json5');
  fs.writeFileSync(configPath, '{ server: { port: 2002 } }');
  const taken = new Set([2002, 2003]);
  const deps = { isPortFree: async (port) => !taken.has(port), log: () => {} };

  const moved = await chooseStartPort({ port: 2002, source: 'config', firstRun: true, configPath }, deps);
  assert.deepEqual(moved, { port: 2004, source: 'config', movedFrom: 2002 });
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ server: { port: 2004 } }');

  // Not first run, or the user named the port: keep it, and let startDaemon refuse it.
  fs.writeFileSync(configPath, '{ server: { port: 2002 } }');
  assert.deepEqual(await chooseStartPort({ port: 2002, source: 'config', firstRun: false, configPath }, deps), { port: 2002, source: 'config', movedFrom: null });
  assert.deepEqual(await chooseStartPort({ port: 2002, source: 'cli', firstRun: true, configPath }, deps), { port: 2002, source: 'cli', movedFrom: null });
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{ server: { port: 2002 } }');

  // A free port stays as it is.
  assert.deepEqual(await chooseStartPort({ port: 2005, source: 'config', firstRun: true, configPath }, deps), { port: 2005, source: 'config', movedFrom: null });
});
