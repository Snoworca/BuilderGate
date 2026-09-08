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
const basename = `buildergate-http-${process.pid}-${randomUUID()}`;
const owned = process.platform === 'win32' ? `\\\\.\\pipe\\${basename}` : path.join(os.tmpdir(), `${basename}.sock`);
const rejected = [0, 2222, 2001, 2002, '0', '2222', '127.0.0.1', undefined, null,
  {}, { port: 0 }, { port: 2222 }, { path: owned },
  `\\\\.\\pipe\\foreign-${randomUUID()}`, `\\\\remote\\pipe\\${basename}`,
  path.join(os.tmpdir(), 'foreign.sock'), `${owned}/../foreign`,
  process.platform === 'win32' ? `\\\\.\\pipe\\buildergate-http-${process.pid}-invalid` : path.join(os.tmpdir(), `buildergate-http-${process.pid}-invalid.sock`),
];
for (const input of rejected) assert.throws(() => server.listen(input), error => error.code === 'B0_FORBIDDEN_TCP_LISTEN');
assert.equal(forwarded.length, 0, 'no forbidden form reaches the captured original listen');
const callback = () => {};
assert.equal(server.listen(owned, callback), server);
assert.deepEqual(forwarded, [{ server, args: [owned, callback] }]);
assert.equal(server.listening, false, 'the no-bind self-check never opens a real endpoint');
console.log(JSON.stringify({ rejected: rejected.length, validForwarded: forwarded.length, actualBinds: 0 }));
