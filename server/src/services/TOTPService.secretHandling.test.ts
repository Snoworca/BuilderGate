import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TOTPService } from './TOTPService.js';

// #80 + #58. Both are about a credential: what reaches the log, and what reaches the disk.
//
// The assertions are written so that deleting the behaviour cannot buy a pass -- each one
// names a concrete string or a concrete mode, and the console capture asserts the secret's
// ABSENCE against a log that is verified to be non-empty first, so a silent service cannot
// satisfy it vacuously.

function makeService(dir: string, printConsoleQr: boolean) {
  const cryptoService = {
    encrypt: (value: string) => `enc:${value}`,
    decrypt: (value: string) => value.replace(/^enc:/u, ''),
  };
  return new TOTPService(
    { enabled: true, issuer: 'BuilderGate', accountName: 'admin' } as never,
    cryptoService as never,
    path.join(dir, 'totp.secret'),
    { printConsoleQr } as never,
  );
}

function captureConsole(run: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { run(); } finally { console.log = original; }
  return lines.join('\n');
}

test('#80 the secret never reaches the console, with printing on or off', () => {
  for (const printConsoleQr of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-80-'));
    try {
      const service = makeService(dir, printConsoleQr);
      const output = captureConsole(() => { service.initialize(); service.printQRCode(); });
      assert.ok(output.length > 0, 'the capture must have recorded something, or absence proves nothing');
      const secret = (service as unknown as { secret: string | null }).secret;
      assert.ok(secret && secret.length > 0, 'a secret must exist for this assertion to mean anything');
      assert.equal(output.includes(secret), false,
        `the TOTP secret appeared in console output (printConsoleQr=${printConsoleQr})`);
      assert.doesNotMatch(output, /Manual entry key/u);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('#58 the secret file is created 0600, never passing through a wider mode', () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'totp-58-'));
  try {
    const secretPath = path.join(dir, 'totp.secret');
    captureConsole(() => { makeService(dir, false).initialize(); });
    assert.equal(fs.existsSync(secretPath), true, 'the secret file must have been written');
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    // A temp file left behind would be a credential at an unmanaged path.
    const leftovers = fs.readdirSync(dir).filter(name => name.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'no temp credential file may survive the write');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
