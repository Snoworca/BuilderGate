'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const forwarded = [];
// The self-check intentionally substitutes the captured original method. No
// operating-system bind can occur even if a guard assertion regresses.
net.Server.prototype.listen = function (...args) { forwarded.push({ server: this, args }); return this; };
require('./require-owned-http-test-pipe.cjs');
const server = new net.Server();
const endpointFor = (name) => (process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`));
const basename = `buildergate-http-${process.pid}-${randomUUID()}`;
const owned = endpointFor(basename);
// The owned-endpoint convention is keyed by fixture kind, not by the HTTP
// fixture alone: the WsRouter restore-metadata harness owns a `ws` endpoint
// under the same pid+uuid discipline. The kind set is closed.
const ownedWs = endpointFor(`buildergate-ws-${process.pid}-${randomUUID()}`);
const rejected = [0, 2222, 2001, 2002, '0', '2222', '127.0.0.1', undefined, null,
  {}, { port: 0 }, { port: 2222 }, { path: owned },
  `\\\\.\\pipe\\foreign-${randomUUID()}`, `\\\\remote\\pipe\\${basename}`,
  path.join(os.tmpdir(), 'foreign.sock'), `${owned}/../foreign`,
  endpointFor(`buildergate-http-${process.pid}-invalid`),
  // A kind outside the closed set stays forbidden.
  endpointFor(`buildergate-agent-${process.pid}-${randomUUID()}`),
  // A well-formed `ws` name owned by a different process stays forbidden.
  endpointFor(`buildergate-ws-${process.pid + 1}-${randomUUID()}`),
  // A `ws` name whose uuid segment is malformed stays forbidden.
  endpointFor(`buildergate-ws-${process.pid}-invalid`),
];
for (const input of rejected) assert.throws(() => server.listen(input), error => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
assert.equal(forwarded.length, 0, 'no forbidden form reaches the captured original listen');
const callback = () => {};
assert.equal(server.listen(owned, callback), server);
assert.equal(server.listen(ownedWs, callback), server);
assert.deepEqual(forwarded, [
  { server, args: [owned, callback] },
  { server, args: [ownedWs, callback] },
]);
assert.equal(server.listening, false, 'the no-bind self-check never opens a real endpoint');
console.log(JSON.stringify({ rejected: rejected.length, validForwarded: forwarded.length, actualBinds: 0 }));
