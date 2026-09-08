'use strict';
// Test-only: replace both OS entrypoints before the guard captures listen.
const assert = require('node:assert/strict');
const net = require('node:net');
const threads = require('node:worker_threads');
const events = [];
function record(event) {
  events.push(event);
  threads.parentPort?.postMessage({ b1Probe: event });
}
global.__b1WorkerProbeEvents = events;
net.Server.prototype.listen = function (...args) {
  record({ type: 'forwarded-fake-listen', endpoint: args[0] });
  assert.equal(this.listening, false);
  return this;
};
net.Socket.prototype.connect = function (endpoint, callback) {
  record({ type: 'stubbed-native-connect', endpoint });
  if (typeof callback === 'function') queueMicrotask(() => callback.call(this));
  return this;
};
require('./require-exclusive-runtime-port.cjs');
const guardedListen = net.Server.prototype.listen;
// Negative overloads still originate in the real dependency Worker entry.
net.Server.prototype.listen = function (...args) {
  const endpoint = args[0];
  switch (process.env.BUILDERGATE_WORKER_SELFTEST_CASE) {
    case 'mismatch': args = [endpoint + '-different']; break;
    case 'options-path': args = [{ path: endpoint }]; break;
    case 'fd': args = [{ fd: 1, path: endpoint }]; break;
    case 'handle': args = [{ handle: { path: endpoint } }]; break;
    case '_handle': args = [{ port: 2222, _handle: { path: endpoint } }]; break;
    case 'tcp-denied': args = [2002]; break;
    case 'tcp-allowed': args = [2222]; break;
  }
  return Reflect.apply(guardedListen, this, args);
};
