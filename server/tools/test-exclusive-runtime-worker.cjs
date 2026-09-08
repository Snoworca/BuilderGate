'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');

// REL-BGSTAB-001 / B1: actual dependency Worker, but no OS bind or native pipe connection.
const preload = path.join(__dirname, 'exclusive-runtime-worker-test-preload.cjs');
const entry = require.resolve('node-pty/lib/worker/conoutSocketWorker.js');
const nativePid = process.pid + 100000; // native agent PID is not the Node PID.
const conoutBase = `\\\\.\\pipe\\winpty-conout-${nativePid}-2-1dc211a412abcd`;
const conout = conoutBase + '-0123456789abcdef0123456789abcdef';
function environment(profile, scenario, log) {
  const env = { ...process.env, NODE_OPTIONS: '', BUILDERGATE_TEST_LISTEN_PROFILE: profile,
    BUILDERGATE_WORKER_SELFTEST_CASE: scenario };
  delete env.BUILDERGATE_TEST_LISTEN_LOG;
  if (log) env.BUILDERGATE_TEST_LISTEN_LOG = log;
  return env;
}
async function probe({ profile = 'app', scenario = '', workerData = { conoutPipeName: conout }, otherEntry = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildergate-b1-worker-test-'));
  const log = path.join(dir, 'guard.jsonl');
  try {
    let filename = entry;
    if (otherEntry) {
      filename = path.join(dir, 'conoutSocketWorker.js');
      fs.writeFileSync(filename, "const {workerData}=require('node:worker_threads');require('node:net').createServer().listen(workerData.conoutPipeName+'-worker');", 'utf8');
    }
    const result = await new Promise(resolve => {
      const messages = []; let error;
      const worker = new Worker(filename, { workerData, env: environment(profile, scenario, log), execArgv: ['--require', preload] });
      worker.on('message', message => messages.push(message));
      worker.once('error', value => { error = { code: value.code, message: value.message }; });
      worker.once('exit', code => resolve({ code, error, messages }));
    });
    return { ...result, audit: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function forwards(result) { return result.messages.filter(m => m?.b1Probe?.type === 'forwarded-fake-listen'); }
function rejected(result) {
  assert.equal(result.error?.code, 'B1_FORBIDDEN_LISTEN');
  assert.equal(result.code, 1);
  assert.equal(forwards(result).length, 0, 'forbidden worker inputs never reach even the fake original');
  assert.equal(result.messages.includes(1), false, 'real dependency must not report READY after rejection');
}

for (const [label, pipe] of [
  ['WinPTY random suffix', conout], ['WinPTY without optional random suffix', conoutBase],
  ...['0', '1234567.125', '1e-7', '9999999.999999998'].map(number => [`ConPTY ${number}`, `\\\\.\\pipe\\conpty-${number}-out`]),
]) {
test(`B1 real node-pty app Worker forwards its exact IPC endpoint ${label}`, async () => {
  const result = await probe({ workerData: { conoutPipeName: pipe } });
  if (process.platform !== 'win32') { rejected(result); return; }
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0, 'worker exits naturally with only fake network operations');
  assert.deepEqual(forwards(result).map(m => m.b1Probe.endpoint), [pipe + '-worker']);
  assert.deepEqual(result.messages.filter(m => m?.b1Probe?.type === 'stubbed-native-connect').map(m => m.b1Probe.endpoint), [pipe]);
  assert.equal(result.messages.filter(m => m === 1).length, 1, 'actual dependency posts READY once');
  assert.equal(result.audit.length, 1);
  assert.match(result.audit[0].event, /worker/i, 'accepted IPC has a distinct audit event');
  assert.notEqual(result.audit[0].event, 'forward-permitted-tcp-listen');
  assert.ok(JSON.stringify(result.audit[0]).includes(pipe.split('\\').at(-1) + '-worker'), 'audit identifies the exact accepted endpoint');
});
}
test('B1 real node-pty Worker cannot use IPC in fixture profile', async () => rejected(await probe({ profile: 'fixture' })));
test('B1 same basename outside the checkout dependency entry cannot claim Worker IPC', async () => rejected(await probe({ otherEntry: true })));
for (const scenario of ['mismatch', 'options-path', 'fd', 'handle', '_handle', 'tcp-denied']) {
  test(`B1 real Worker rejects ${scenario} endpoint without network operations`, async () => rejected(await probe({ scenario })));
}
for (const value of [undefined, null, 1, '', conout + '-worker', conout.replace('winpty-conout', 'other-conout'),
  conout.replace('\\\\.\\pipe\\', '\\\\remote\\pipe\\'), conout.replace(String(nativePid), 'not-a-pid'),
  conout.replace('1dc211a412abcd', 'nonhex'), conout.replace('-2-', '-0-'),
  conout.replace('0123456789abcdef0123456789abcdef', '1234'), conout + '/../../foreign',
  ...['-1', '-0', '10000000', 'Infinity', 'NaN', '01', '1.0', ' 1', '1e7'].map(number => `\\\\.\\pipe\\conpty-${number}-out`),
  '\\\\.\\pipe\\conpty-123-in', '\\\\.\\pipe\\conpty-123-out-worker']) {
  test(`B1 Worker rejects malformed conout data ${JSON.stringify(value)}`, async () => {
    rejected(await probe({ workerData: value === undefined ? {} : { conoutPipeName: value } }));
  });
}
test('B1 Worker keeps the existing app TCP2222 rule unchanged', async () => {
  const result = await probe({ scenario: 'tcp-allowed' });
  assert.equal(result.error, undefined); assert.equal(result.code, 0);
  assert.deepEqual(forwards(result).map(m => m.b1Probe.endpoint), [2222]);
  assert.equal(result.audit[0].event, 'forward-permitted-tcp-listen');
});
test('B1 main thread cannot claim a native-looking Worker IPC endpoint', () => {
  const code = `const assert=require('node:assert/strict');const server=require('node:net').createServer();assert.throws(()=>server.listen(${JSON.stringify(conout + '-worker')}),e=>e.code==='B1_FORBIDDEN_LISTEN');assert.equal(global.__b1WorkerProbeEvents.length,0);console.log('main-thread-denied');`;
  const result = spawnSync(process.execPath, ['--require', preload, '-e', code], {
    env: environment('app', ''), encoding: 'utf8', windowsHide: true, shell: false,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'main-thread-denied');
});
