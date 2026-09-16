'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
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
  // A well-formed owned name outside the owned directory stays forbidden. On
  // win32 the guard has no directory clause, so there this case is carried by
  // the `^` anchor instead; it is kept on both lanes so the corpus is uniform.
  WIN32
    ? `\\\\.\\pipe\\sub\\buildergate-http-${process.pid}-${randomUUID()}`
    : path.join('/etc', `buildergate-http-${process.pid}-${randomUUID()}.sock`),
  // Kinds outside the closed set stay forbidden whether the widening comes from
  // the kind array or from the pattern template around it. `htt`/`httpx`/`ws2`
  // bracket the accepted tokens so a relaxed alternation is visible.
  ...['zz', 'htt', 'httpx', 'ws2', 'w', 'h'].map(
    (kind) => endpointFor(`buildergate-${kind}-${process.pid}-${randomUUID()}`)),
  // The separator between kind and pid is required, so an optional-separator
  // pattern is visible here.
  endpointFor(`buildergate-http${process.pid}-${randomUUID()}`),
  // Nine arbitrary characters followed by a well-formed owned basename. The
  // win32 branch slices exactly the named-pipe prefix length off the value
  // before matching, so dropping the prefix check would let this through.
  `${'P'.repeat(9)}buildergate-http-${process.pid}-${randomUUID()}`,
];
// The `.sock` suffix clause exists only on the posix branch; on win32 the
// named-pipe namespace carries no extension, so this case is posix-only. The
// substitute extension is deliberately five characters long, the same width
// the guard strips, so the case fails on the suffix clause alone rather than
// on the name pattern.
if (!WIN32) {
  rejected.push(path.join(os.tmpdir(), `buildergate-http-${process.pid}-${randomUUID()}.sxck`));
  // The owned directory is tmpdir itself, not a descendant of it and not a
  // directory whose path merely starts with it.
  rejected.push(path.join(os.tmpdir(), 'sub', `buildergate-http-${process.pid}-${randomUUID()}.sock`));
  rejected.push(path.join(`${path.resolve(os.tmpdir())}-sibling`, `buildergate-http-${process.pid}-${randomUUID()}.sock`));
  // The guard strips a fixed five-character suffix rather than everything from
  // the first dot, so an owned name carrying an extra dotted segment is not an
  // owned name.
  rejected.push(path.join(os.tmpdir(), `buildergate-http-${process.pid}-${randomUUID()}.evil.sock`));
}
for (const input of rejected) assert.throws(() => server.listen(input), error => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
// `listen()` with no argument binds a random TCP port in node, so the guard must
// reject arity zero and not only an explicitly bad first argument.
assert.throws(() => server.listen(), (error) => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
// Only the first argument names the endpoint, so nothing in a later argument may
// widen the decision. A guard reading the whole argument list would be invisible
// to a corpus that only ever passes one argument.
assert.throws(() => server.listen(2222, { allowTcp: true }), (error) => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
assert.throws(() => server.listen({ port: 2222, allowTcp: true }), (error) => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
// The fixture the guard exists to contain is an `http.Server`, not a bare
// `net.Server`. Both inherit the patched method, but a guard that discriminated
// by subject class would be invisible to a corpus built on one class alone.
const httpServer = http.createServer();
assert.throws(() => httpServer.listen(2222), (error) => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
assert.throws(() => httpServer.listen(), (error) => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
assert.equal(forwarded.length, 0, 'no forbidden form reaches the captured original listen');
const callback = () => {};
assert.equal(server.listen(owned, callback), server);
assert.equal(server.listen(ownedWs, callback), server);
const httpOwned = endpointFor(`buildergate-http-${process.pid}-${randomUUID()}`);
assert.equal(httpServer.listen(httpOwned, callback), httpServer);
assert.deepEqual(forwarded, [
  { server, args: [owned, callback] },
  { server, args: [ownedWs, callback] },
  { server: httpServer, args: [httpOwned, callback] },
]);
assert.equal(server.listening, false, 'the no-bind self-check never opens a real endpoint');
assert.equal(httpServer.listening, false, 'the no-bind self-check never opens a real endpoint');
// `rejected` and `forwardedToCapturedOriginal` are counted from the corpus and
// from the calls that reached the substituted original. `openHandles` is read
// back off the socket, but it is a guard rail rather than a measurement of the
// guard: `listen` is substituted before the guard loads, so no code path here
// can bind and the value cannot be true. The caller that wants proof the guard
// was actually exercised should set BUILDERGATE_B0_GUARD_LOG and count the
// events the guard itself appends.
console.log(JSON.stringify({
  platform: process.platform,
  // `rejected` counts the corpus array; the five cases outside it (zero-arity
  // listen, two later-argument forms and two http.Server rejections) are counted
  // separately so the wrapper can pin both.
  rejected: rejected.length,
  rejectedOutsideCorpus: 5,
  forwardedToCapturedOriginal: forwarded.length,
  openHandles: server.listening || httpServer.listening,
}));
