// Issue #50: stop had no way to name WHICH daemon to stop. It read the target out of a state
// file whose location came from an inherited BUILDERGATE_ROOT, so an environment pointing at the
// installed copy would stop the OPERATING daemon -- the one on TCP 2001/2002 -- while the caller
// believed they were stopping their own checkout. The identity check could not save them: the
// operating daemon is a valid BuilderGate app, so the check passed and the wrong thing stopped.
//
// Every case here asserts that stopDaemon was NOT reached, because "refused" and "stopped
// something harmless" are indistinguishable from an exit code alone.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { main, parseArgs } = require('../../stop.js');

function fixtureRoot(prefix = 'buildergate-stop-scope-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  return root;
}

function pathsFor(root) {
  return { root, statePath: path.join(root, 'runtime', 'buildergate.daemon.json') };
}

function silentLogs() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)), logError: (line) => lines.push(String(line)) };
}

test('#50 stop refuses a root inherited from the environment that is not this checkout', async () => {
  const foreign = fixtureRoot();
  const logs = silentLogs();
  let stopped = false;
  const exitCode = await main({
    argv: [],
    env: { BUILDERGATE_ROOT: foreign },
    checkoutRoot: path.resolve(__dirname, '..', '..'),
    readState: () => { throw new Error('the state must not be read for a refused target'); },
    validateAppProcess: () => { stopped = true; return { valid: true }; },
    log: logs.log,
    logError: logs.logError,
  });
  assert.equal(exitCode, 2);
  assert.equal(stopped, false, 'stop must not reach the daemon it refused');
  assert.match(logs.lines.join('\n'), /Refusing to stop a daemon outside this checkout/u);
  assert.match(logs.lines.join('\n'), new RegExp(foreign.replace(/[\\^$*+?.()|[\]{}]/gu, '\\$&'), 'u'),
    'the refusal must name the root it resolved, so the caller can see what their shell chose');
});

test('#50 --root says the foreign target out loud and is honoured', async () => {
  const foreign = fixtureRoot();
  const logs = silentLogs();
  let seenStatePath = null;
  const exitCode = await main({
    argv: ['--root', foreign],
    env: {},
    checkoutRoot: path.resolve(__dirname, '..', '..'),
    paths: pathsFor(foreign),
    readState: (statePath) => { seenStatePath = statePath; return null; },
    log: logs.log,
    logError: logs.logError,
  });
  assert.equal(exitCode, 0, 'an explicitly named root proceeds');
  assert.equal(seenStatePath, pathsFor(foreign).statePath,
    'the named root must be the one whose state file is read, not the inherited one');
  assert.match(logs.lines.join('\n'), /not running/iu);
});

test('#50 --allow-foreign-root proceeds where the bare call refuses', async () => {
  const foreign = fixtureRoot();
  const logs = silentLogs();
  const exitCode = await main({
    argv: ['--allow-foreign-root'],
    env: { BUILDERGATE_ROOT: foreign },
    checkoutRoot: path.resolve(__dirname, '..', '..'),
    log: logs.log,
    logError: logs.logError,
  });
  assert.equal(exitCode, 0);
  assert.match(logs.lines.join('\n'), /not running/iu);
});

test('#50 --port refuses when the recorded daemon is on another port', async () => {
  const root = fixtureRoot();
  const logs = silentLogs();
  let stopped = false;
  const exitCode = await main({
    argv: ['--port', '2222'],
    env: {},
    checkoutRoot: root,
    paths: pathsFor(root),
    readState: () => ({ port: 2002, status: 'running' }),
    validateAppProcess: () => { stopped = true; return { valid: true }; },
    log: logs.log,
    logError: logs.logError,
  });
  assert.equal(exitCode, 2);
  assert.equal(stopped, false, 'the port scope must be checked before anything is stopped');
  const output = logs.lines.join('\n');
  assert.match(output, /recorded port: 2002/u);
  assert.match(output, /not on port 2222/u);
});

// The control. Without it the three refusals above would also hold for a stop that refuses
// everything, which would be a different defect with the same exit codes.
test('#50 --port proceeds when the recorded daemon is that port', async () => {
  const root = fixtureRoot();
  const logs = silentLogs();
  const exitCode = await main({
    argv: ['--port', '2222'],
    env: {},
    checkoutRoot: root,
    paths: pathsFor(root),
    readState: () => ({ port: 2222, status: 'running' }),
    log: logs.log,
    logError: logs.logError,
  });
  assert.equal(exitCode, 0);
  assert.match(logs.lines.join('\n'), /not running/iu);
});

test('#50 a state file with no recorded port is not treated as a match', async () => {
  const root = fixtureRoot();
  const logs = silentLogs();
  const exitCode = await main({
    argv: ['--port', '2222'],
    env: {},
    checkoutRoot: root,
    paths: pathsFor(root),
    readState: () => null,
    log: logs.log,
    logError: logs.logError,
  });
  assert.equal(exitCode, 2);
  assert.match(logs.lines.join('\n'), /recorded port: <none>/u);
});

test('#50 argument errors are refusals, not silently ignored flags', async () => {
  for (const argv of [['--port'], ['--port', 'nope'], ['--root'], ['--wat']]) {
    const logs = silentLogs();
    const exitCode = await main({ argv, env: {}, log: logs.log, logError: logs.logError });
    assert.equal(exitCode, 2, `${argv.join(' ')} must be refused`);
    assert.match(logs.lines.join('\n'), /Usage:|needs a/u);
  }
  assert.equal(parseArgs(['--port', '70000']).error !== null, true, 'a port outside the range is an error');
});
