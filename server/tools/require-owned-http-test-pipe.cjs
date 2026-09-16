'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const originalListen = net.Server.prototype.listen;
// Owned local endpoints are named `buildergate-<kind>-<pid>-<uuid>`. The kind
// set is closed: `http` for the local HTTP fixture helper, `ws` for the
// WsRouter restore-metadata harness. Both are unix sockets or named pipes,
// never TCP, so both are forwarded; any other kind is rejected.
// A kind is interpolated into a RegExp, so the closed set is enforced here
// rather than by convention: a kind carrying a metacharacter would silently
// widen the accepted names. Loading fails loudly instead.
const OWNED_ENDPOINT_KINDS = ['http', 'ws'];
for (const kind of OWNED_ENDPOINT_KINDS) {
  if (!/^[a-z0-9]+$/.test(kind)) {
    throw new Error(`B0_INVALID_OWNED_ENDPOINT_KIND: ${JSON.stringify(kind)} is not a literal lowercase alphanumeric kind`);
  }
}
const namePattern = new RegExp(`^buildergate-(?:${OWNED_ENDPOINT_KINDS.join('|')})-${process.pid}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i');
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
    const error = new Error('B0_FORBIDDEN_TCP_LISTEN: test fixtures must listen on their owned local endpoint (buildergate-<kind>-<pid>-<uuid>)');
    error.code = 'B0_FORBIDDEN_TCP_LISTEN';
    throw error;
  }
  return Reflect.apply(originalListen, this, args);
};
