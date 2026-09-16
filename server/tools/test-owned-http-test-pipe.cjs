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
const WIN32 = process.platform === 'win32';
// Both endpoint shapes are built through the platform branch the guard uses,
// so every case below exercises the branch that is live on this platform.
const endpointFor = (name) => (WIN32 ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`));
const basename = `buildergate-http-${process.pid}-${randomUUID()}`;
const owned = endpointFor(basename);
// The owned-endpoint convention is keyed by fixture kind, not by the HTTP
// fixture alone: the WsRouter restore-metadata harness owns a `ws` endpoint
// under the same pid+uuid discipline. The kind set is closed.
const ownedWs = endpointFor(`buildergate-ws-${process.pid}-${randomUUID()}`);
const rejected = [0, 2222, 2001, 2002, '0', '2222', '127.0.0.1', undefined, null,
  {}, { port: 0 }, { port: 2222 }, { path: owned },
  endpointFor(`foreign-${randomUUID()}`),
  `\\\\remote\\pipe\\${basename}`,
  endpointFor('foreign'),
  `${owned}/../foreign`,
  endpointFor(`buildergate-http-${process.pid}-invalid`),
  // A kind outside the closed set stays forbidden.
  endpointFor(`buildergate-agent-${process.pid}-${randomUUID()}`),
  // A well-formed `ws` name owned by a different process stays forbidden.
  endpointFor(`buildergate-ws-${process.pid + 1}-${randomUUID()}`),
  // A `ws` name whose uuid segment is malformed stays forbidden.
  endpointFor(`buildergate-ws-${process.pid}-invalid`),
  // Anchors: an owned name embedded in a longer basename stays forbidden at
  // either end. Without `^` or `$` on the name pattern these would be accepted.
  endpointFor(`evil-buildergate-http-${process.pid}-${randomUUID()}`),
  endpointFor(`buildergate-ws-${process.pid}-${randomUUID()}-evil`),
  // A well-formed owned name outside the owned directory stays forbidden.
  WIN32
    ? `\\\\.\\pipe\\sub\\buildergate-http-${process.pid}-${randomUUID()}`
    : path.join('/etc', `buildergate-http-${process.pid}-${randomUUID()}.sock`),
];
// The `.sock` suffix clause exists only on the posix branch; on win32 the
// named-pipe namespace carries no extension, so this case is posix-only. The
// substitute extension is deliberately five characters long, the same width
// the guard strips, so the case fails on the suffix clause alone rather than
// on the name pattern.
if (!WIN32) rejected.push(path.join(os.tmpdir(), `buildergate-http-${process.pid}-${randomUUID()}.sxck`));
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
// Every field below is measured. `forwardedToCapturedOriginal` counts the calls
// that reached the substituted original; `openHandles` is read back off the
// socket. Neither is a constant asserting the property it reports.
console.log(JSON.stringify({
  platform: process.platform,
  rejected: rejected.length,
  forwardedToCapturedOriginal: forwarded.length,
  openHandles: server.listening,
}));
