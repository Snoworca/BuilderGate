'use strict';
// REL-BGSTAB-001: test-process listener restriction, never a production default.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const threads = require('node:worker_threads');
const profile = process.env.BUILDERGATE_TEST_LISTEN_PROFILE;
if (profile !== 'fixture' && profile !== 'app') {
  throw new Error('B1_INVALID_LISTEN_PROFILE: profile must be fixture or app');
}
const logPath = process.env.BUILDERGATE_TEST_LISTEN_LOG;
const originalListen = net.Server.prototype.listen;

function ownedPtyWorkerPipe() {
  if (profile !== 'app' || process.platform !== 'win32' || threads.isMainThread) return null;
  const pipe = threads.workerData?.conoutPipeName;
  if (typeof pipe !== 'string' || typeof process.argv[1] !== 'string') return null;
  const entry = path.resolve(__dirname, '../node_modules/node-pty/lib/worker/conoutSocketWorker.js');
  if (!fs.existsSync(entry) || !fs.existsSync(process.argv[1])
    || fs.realpathSync(entry).toLowerCase() !== fs.realpathSync(process.argv[1]).toLowerCase()) return null;
  const winpty = /^\\\\\.\\pipe\\winpty-conout-[1-9]\d*-[1-9]\d*-[0-9a-f]{1,16}(?:-[0-9a-f]{32})?$/.test(pipe);
  const conptyPrefix = '\\\\.\\pipe\\conpty-';
  let conpty = false;
  if (pipe.startsWith(conptyPrefix) && pipe.endsWith('-out')) {
    const text = pipe.slice(conptyPrefix.length, -4);
    const number = Number(text);
    conpty = Number.isFinite(number) && number >= 0 && number < 10000000 && String(number) === text;
  }
  return winpty || conpty ? `${pipe}-worker` : null;
}

net.Server.prototype.listen = function (...args) {
  // Worker argv is populated after preloads; check its entry at the bind boundary.
  const workerPipe = ownedPtyWorkerPipe();
  const endpoint = args[0];
  let port = endpoint;
  let ambiguous = false;
  if (endpoint !== null && typeof endpoint === 'object') {
    ambiguous = 'path' in endpoint || 'fd' in endpoint || 'handle' in endpoint || '_handle' in endpoint;
    const descriptor = Object.getOwnPropertyDescriptor(endpoint, 'port');
    port = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }
  const workerAllowed = workerPipe !== null && endpoint === workerPipe && args.length === 1;
  const tcpAllowed = !ambiguous && (port === 2222 || port === '2222'
    || (profile === 'app' && (port === 2221 || port === '2221')));
  const allowed = workerAllowed || tcpAllowed;
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify({
      event: workerAllowed ? 'forward-owned-pty-worker-listen'
        : allowed ? 'forward-permitted-tcp-listen' : 'reject-before-bind',
      pid: process.pid, profile,
      port: workerAllowed ? null : typeof port === 'number' || typeof port === 'string' ? port : null,
      ...(workerAllowed ? { pipe: endpoint, threadId: threads.threadId } : {}),
    })}\n`, 'utf8');
  }
  if (!allowed) {
    const error = new Error('B1_FORBIDDEN_LISTEN: endpoint is outside the fixed test profile');
    error.code = 'B1_FORBIDDEN_LISTEN';
    throw error;
  }
  return Reflect.apply(originalListen, this, args);
};
