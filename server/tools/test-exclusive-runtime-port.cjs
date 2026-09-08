'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// REL-BGSTAB-001 / B1 operating safety: replace the original listen BEFORE
// requiring the future preload. Even a missing or broken guard cannot OS-bind.
const guardPath = path.join(__dirname, 'require-exclusive-runtime-port.cjs');

function probe(scenario) {
  const net = require('node:net');
  const forwarded = [];
  const sentinel = Object.freeze({ fakeListenReturn: true });
  net.Server.prototype.listen = function (...args) {
    forwarded.push({ receiver: this, args });
    return sentinel;
  };
  assert.ok(fs.existsSync(guardPath), 'B1 requires the exclusive-runtime-port preload before its contracts can run');
  if (scenario === 'invalid-profile') {
    assert.throws(() => require(guardPath), /profile/i, 'a missing/invalid profile must reject preload startup');
    assert.equal(forwarded.length, 0);
    return { rejectedProfile: true, forwarded: 0, actualBinds: 0 };
  }
  require(guardPath);
  const server = new net.Server();
  const callback = () => assert.fail('the fake original listen never runs callbacks');
  const profile = process.env.BUILDERGATE_TEST_LISTEN_PROFILE;
  const allowed = profile === 'app' ? [2222, 2221] : [2222];
  let rejected = 0;
  if (scenario === 'allowed') {
    for (const port of allowed) {
      for (const args of [
        [port], [port, callback], [String(port), callback],
        [port, '127.0.0.1', callback], [port, '::1', 16, callback],
        [{ port }, callback], [{ port: String(port), host: '127.0.0.1', backlog: 16 }, callback],
      ]) {
        const prior = forwarded.length;
        assert.equal(server.listen(...args), sentinel, 'preserve the original return value');
        assert.equal(forwarded.length, prior + 1, 'forward exactly once');
        assert.equal(forwarded.at(-1).receiver, server, 'preserve receiver');
        assert.equal(forwarded.at(-1).args.length, args.length);
        args.forEach((argument, index) => assert.equal(forwarded.at(-1).args[index], argument,
          'forward original objects/callbacks without rewriting the overload'));
      }
    }
  } else if (scenario === 'denied') {
    const blockedPorts = [0, 2001, 2002, 3333, 5173, 2223, 65535, ...(profile === 'fixture' ? [2221] : [])];
    const denied = blockedPorts.flatMap(port => [[port, callback], [String(port), callback], [{ port }, callback], [{ port: String(port) }, callback]]);
    for (const malformed of [-1, 2222.5, NaN, Infinity, null, true, '2222oops', ' 2222', '2222.0', '02222', '']) {
      denied.push([malformed, callback], [{ port: malformed }, callback]);
    }
    denied.push([], [undefined], [callback], ['127.0.0.1'], ['localhost'], ['::1'], [{}],
      [{ host: '127.0.0.1' }], [{ fd: 1 }], [{ handle: {} }],
      [{ path: '/tmp/b1-unowned.sock' }], ['\\\\.\\pipe\\b1-unowned'], ['/tmp/b1-unowned.sock'],
      [{ port: 2222, path: '/tmp/conflict.sock' }], [{ port: 2222, fd: 1 }],
      [{ port: 2222, handle: {} }], [{ port: 2222, path: '\\\\.\\pipe\\b1-conflict', fd: 1 }],
      // Native Node listen selects options._handle before the outer options.
      [{ port: 2222, _handle: { port: 2002 } }],
      [{ port: 2222, _handle: { path: '/tmp/b1-bypass.sock' } }],
      [Object.assign(Object.create({ _handle: { port: 2002 } }), { port: 2222 })],
      [Object.assign(Object.create({ _handle: { path: '/tmp/b1-bypass.sock' } }), { port: 2222 })]);
    for (const args of denied) {
      assert.throws(() => server.listen(...args), 'deny an unsupported endpoint before the captured original');
      rejected += 1;
      assert.equal(forwarded.length, 0, 'no denied input may reach the original listen');
    }
  } else if (scenario === 'profile-frozen') {
    process.env.BUILDERGATE_TEST_LISTEN_PROFILE = 'app';
    assert.throws(() => server.listen(2221), 'a fixture preload must not broaden when its environment changes');
    assert.equal(forwarded.length, 0);
  } else if (scenario === 'logging') {
    server.listen(2222, callback);
    assert.throws(() => server.listen(3333));
    assert.equal(forwarded.length, 1);
    const log = fs.readFileSync(process.env.BUILDERGATE_TEST_LISTEN_LOG, 'utf8');
    assert.match(log, /2222/, 'optional audit log records allowed endpoint');
    assert.match(log, /3333/, 'optional audit log records denied endpoint');
  } else {
    assert.fail(`unknown self-test scenario: ${scenario}`);
  }
  assert.equal(server.listening, false, 'all forwarding uses the fake original; no real listener');
  return { profile, scenario, rejected, forwarded: forwarded.length, actualBinds: 0 };
}

if (process.argv[2] === '--probe') {
  console.log(JSON.stringify(probe(process.argv[3])));
} else {
  function run(profile, scenario, logPath) {
    const env = { ...process.env };
    // Avoid any inherited preload running before the fake listen is installed.
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    delete env.BUILDERGATE_TEST_LISTEN_PROFILE;
    delete env.BUILDERGATE_TEST_LISTEN_LOG;
    if (profile !== undefined) env.BUILDERGATE_TEST_LISTEN_PROFILE = profile;
    if (logPath !== undefined) env.BUILDERGATE_TEST_LISTEN_LOG = logPath;
    const child = spawnSync(process.execPath, [__filename, '--probe', scenario], {
      env, encoding: 'utf8', windowsHide: true, shell: false,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.actualBinds, 0);
    return result;
  }
  for (const profile of ['fixture', 'app']) {
    test(`B1 ${profile} forwards permitted numeric/string/options overloads unchanged without binding`, () => {
      const result = run(profile, 'allowed');
      assert.equal(result.forwarded, profile === 'app' ? 14 : 7);
    });
    test(`B1 ${profile} rejects protected, random, malformed and ambiguous endpoints before binding`, () => {
      const result = run(profile, 'denied');
      assert.ok(result.rejected >= 60, 'exercise the complete endpoint-denial corpus');
      assert.equal(result.forwarded, 0);
    });
  }
  for (const profile of [undefined, '', 'other', 'APP', 'fixture ']) {
    test(`B1 invalid profile ${JSON.stringify(profile)} fails closed at preload startup`, () => {
      assert.equal(run(profile, 'invalid-profile').rejectedProfile, true);
    });
  }
  test('B1 fixture profile cannot widen after preload', () => {
    run('fixture', 'profile-frozen');
  });
  test('B1 optional log records both allowed and denied endpoints without networking', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-b1-guard-test-'));
    try { run('app', 'logging', path.join(directory, 'listen.jsonl')); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
