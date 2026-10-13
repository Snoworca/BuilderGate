const assert = require('node:assert/strict');
const test = require('node:test');

const {
  detectRunningOwnDaemon,
  detectRunningBuilderGateOnPort,
  formatAlreadyRunningLine,
  isBuilderGateHealthBody,
  reportAlreadyRunning,
} = require('./already-running');

// FR-BGSTAB-033. A second start used to print the running daemon's PIDs and then the whole
// start-up banner, so it read as if a new instance had started.

test('FR-BGSTAB-033 AC-1 the message is one English line naming the URL', () => {
  assert.equal(formatAlreadyRunningLine(2002), 'BuilderGate is already running at https://localhost:2002.');
  assert.equal(formatAlreadyRunningLine(2002).includes('\n'), false);
});

test('FR-BGSTAB-033 AC-1 an active own daemon is reported with the port in its state', async () => {
  const result = await detectRunningOwnDaemon({}, {
    inspectExistingDaemon: async () => ({ active: true, status: 'active', state: { port: 2002 } }),
  });
  assert.deepEqual(result, { running: true, port: 2002 });
});

test('FR-BGSTAB-033 AC-1 an inactive or unverifiable own daemon is not reported', async () => {
  for (const inspection of [
    { active: false, status: 'stopped', state: { port: 2002 } },
    { active: false, status: 'unknown', state: { port: 2002 } },
    { active: true, status: 'active', state: { port: null } },
  ]) {
    const result = await detectRunningOwnDaemon({}, { inspectExistingDaemon: async () => inspection });
    assert.deepEqual(result, { running: false }, JSON.stringify(inspection));
  }
});

test('FR-BGSTAB-033 AC-2 a BuilderGate /health body is recognised and others are not', () => {
  assert.equal(isBuilderGateHealthBody({ status: 'ok', https: true, buildId: 'abc', rootsForeign: false }), true);
  assert.equal(isBuilderGateHealthBody({ status: 'ok' }), false);
  assert.equal(isBuilderGateHealthBody({ status: 'down', buildId: 'abc', rootsForeign: false }), false);
  assert.equal(isBuilderGateHealthBody(null), false);
  assert.equal(isBuilderGateHealthBody('ok'), false);
});

test('FR-BGSTAB-033 AC-2 a busy port that answers as BuilderGate is reported', async () => {
  const result = await detectRunningBuilderGateOnPort(2002, {
    isPortFree: async () => false,
    fetchHealth: async () => ({ status: 'ok', buildId: 'x', rootsForeign: true }),
  });
  assert.deepEqual(result, { running: true, port: 2002 });
});

test('FR-BGSTAB-033 AC-2 a free port, another program, or no answer is not reported', async () => {
  const cases = [
    { isPortFree: async () => true, fetchHealth: async () => ({ status: 'ok', buildId: 'x', rootsForeign: false }) },
    { isPortFree: async () => false, fetchHealth: async () => ({ hello: 'world' }) },
    { isPortFree: async () => false, fetchHealth: async () => { throw new Error('ECONNREFUSED'); } },
  ];
  for (const deps of cases) {
    assert.deepEqual(await detectRunningBuilderGateOnPort(2002, deps), { running: false });
  }
});

test('FR-BGSTAB-033 AC-1 AC-3 the report prints one line and opens the browser only with --open', () => {
  const lines = [];
  const opened = [];
  const deps = {
    log: line => lines.push(line),
    hasDefaultBrowser: () => true,
    openBrowser: url => opened.push(url),
  };

  reportAlreadyRunning(2002, { open: false }, deps);
  assert.deepEqual(lines, ['BuilderGate is already running at https://localhost:2002.']);
  assert.deepEqual(opened, []);

  lines.length = 0;
  reportAlreadyRunning(2002, { open: true }, deps);
  assert.deepEqual(lines, ['BuilderGate is already running at https://localhost:2002.']);
  assert.deepEqual(opened, ['https://localhost:2002']);
});

test('FR-BGSTAB-033 AC-3 --open without a default browser still prints only one line', () => {
  const lines = [];
  reportAlreadyRunning(2002, { open: true }, {
    log: line => lines.push(line),
    hasDefaultBrowser: () => false,
    openBrowser: () => assert.fail('must not open'),
  });
  assert.equal(lines.length, 1);
});

// Wiring. `main` cannot be run in a unit test without a real daemon, so the order of the calls
// in it is pinned here by source text: the checks are worth nothing if they run after the work
// they are meant to skip.
test('FR-BGSTAB-033 AC-1 AC-2 start-runtime checks before building, preflight and port choice', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'start-runtime.js'), 'utf8');
  const mainStart = source.indexOf('async function main()');
  assert.notEqual(mainStart, -1);
  const main = source.slice(mainStart);
  const at = needle => {
    const index = main.indexOf(needle);
    assert.notEqual(index, -1, `main must contain ${needle}`);
    return index;
  };
  assert.ok(at('detectRunningOwnDaemon(') < at('ensureDependenciesAndBuild()'),
    'the own-daemon check must run before the dependency build');
  assert.ok(at('detectRunningOwnDaemon(') < at('runStrictConfigPreflight('),
    'the own-daemon check must run before the config preflight');
  assert.ok(at('detectRunningBuilderGateOnPort(') < at('chooseStartPort('),
    'the port check must run before a first run moves to another port');
  assert.ok(at("parsedArgs.command === 'stop'") < at('detectRunningOwnDaemon('),
    'stop must keep working while a daemon runs');
});
