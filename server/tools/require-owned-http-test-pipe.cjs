'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const originalListen = net.Server.prototype.listen;
const namePattern = new RegExp(`^buildergate-http-${process.pid}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i');
function ownedEndpoint(value) {
  if (typeof value !== 'string') return false;
  if (process.platform === 'win32') {
    const prefix = '\\\\.\\pipe\\';
    return value.startsWith(prefix) && namePattern.test(value.slice(prefix.length));
  }
  return path.isAbsolute(value)
    && path.dirname(value) === path.resolve(os.tmpdir())
    && value.endsWith('.sock')
    && namePattern.test(path.basename(value).slice(0, -5));
}
net.Server.prototype.listen = function (...args) {
  const allowed = ownedEndpoint(args[0]);
  if (process.env.BUILDERGATE_B0_GUARD_LOG) {
    fs.appendFileSync(process.env.BUILDERGATE_B0_GUARD_LOG, `${JSON.stringify({
      event: allowed ? 'forward-owned-local-listen' : 'reject-before-tcp-bind',
      firstType: typeof args[0],
      first: typeof args[0] === 'number' || typeof args[0] === 'string' ? args[0] : null,
    })}\n`, 'utf8');
  }
  if (!allowed) {
    const error = new Error('B0_FORBIDDEN_TCP_LISTEN: HTTP fixtures must use their owned local endpoint');
    error.code = 'B0_FORBIDDEN_TCP_LISTEN';
    throw error;
  }
  return Reflect.apply(originalListen, this, args);
};
