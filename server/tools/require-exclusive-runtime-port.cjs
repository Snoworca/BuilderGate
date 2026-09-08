'use strict';
// REL-BGSTAB-001: test-process listener restriction, never a production default.
const net = require('node:net');
const fs = require('node:fs');
const profile = process.env.BUILDERGATE_TEST_LISTEN_PROFILE;
if (profile !== 'fixture' && profile !== 'app') {
  throw new Error('B1_INVALID_LISTEN_PROFILE: profile must be fixture or app');
}
const logPath = process.env.BUILDERGATE_TEST_LISTEN_LOG;
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function (...args) {
  const endpoint = args[0];
  let port = endpoint;
  let ambiguous = false;
  if (endpoint !== null && typeof endpoint === 'object') {
    ambiguous = 'path' in endpoint || 'fd' in endpoint || 'handle' in endpoint || '_handle' in endpoint;
    const descriptor = Object.getOwnPropertyDescriptor(endpoint, 'port');
    port = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }
  const allowed = !ambiguous && (port === 2222 || port === '2222'
    || (profile === 'app' && (port === 2221 || port === '2221')));
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify({
      event: allowed ? 'forward-permitted-tcp-listen' : 'reject-before-bind',
      pid: process.pid, profile,
      port: typeof port === 'number' || typeof port === 'string' ? port : null,
    })}\n`, 'utf8');
  }
  if (!allowed) {
    const error = new Error('B1_FORBIDDEN_LISTEN: endpoint is outside the fixed test profile');
    error.code = 'B1_FORBIDDEN_LISTEN';
    throw error;
  }
  return Reflect.apply(originalListen, this, args);
};
