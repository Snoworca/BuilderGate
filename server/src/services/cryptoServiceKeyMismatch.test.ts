import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CryptoService } from './CryptoService.js';

/**
 * FR-BGSTAB-030 AC-3.
 *
 * Measured 2026-09-20: `config.json5` encrypted under WSL could not be read by
 * the same checkout started from cmd.exe, because the master key source is
 * `hostname-platform-arch` (index.ts) and only `os.platform()` differed —
 * `linux` against `win32`. Same machine, same file, same build.
 *
 * What surfaced was `Decryption failed: Unsupported state or unable to
 * authenticate data`, thrown from inside AuthService during startup. That is
 * node's crypto text for a failed GCM auth tag, and it is true of a corrupted
 * value, a truncated value and a value encrypted under a different key alike.
 * It does not say which, and the one that actually happens is the last.
 *
 * So the fix is not to change the key — that would invalidate every config in
 * existence — but to make the failure legible. The service knows what it
 * derived its key from; the error should say so.
 */

const WSL_SOURCE = 'DESKTOP-EXAMPLE-linux-x64';
const WINDOWS_SOURCE = 'DESKTOP-EXAMPLE-win32-x64';

test('FR-BGSTAB-030 AC-3 a value encrypted under another key source names the mismatch', () => {
  const encryptedUnderWsl = new CryptoService(WSL_SOURCE, { keySourceLabel: WSL_SOURCE })
    .encrypt('some-secret-value');

  const windows = new CryptoService(WINDOWS_SOURCE, { keySourceLabel: WINDOWS_SOURCE });

  let message = '';
  try {
    windows.decrypt(encryptedUnderWsl);
    assert.fail('decrypting a value from a different key source must not succeed');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  // The reader has to be able to act. Naming what THIS process derived its key
  // from is what turns "decryption failed" into "you are running the wrong
  // platform for this file".
  assert.match(
    message,
    /key/i,
    `the error must point at the key as the likely cause, got: ${message}`,
  );
  assert.ok(
    message.includes(WINDOWS_SOURCE),
    `the error must name the key source this process derived, got: ${message}`,
  );
});

test('FR-BGSTAB-030 AC-3 the plaintext never appears in the failure', () => {
  const secret = 'PLAINTEXT-THAT-MUST-NOT-LEAK';
  const encrypted = new CryptoService(WSL_SOURCE, { keySourceLabel: WSL_SOURCE }).encrypt(secret);
  const windows = new CryptoService(WINDOWS_SOURCE, { keySourceLabel: WINDOWS_SOURCE });

  try {
    windows.decrypt(encrypted);
    assert.fail('expected a decryption failure');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(!message.includes(secret), 'the failure leaked the plaintext');
    assert.ok(!message.includes(encrypted), 'the failure echoed the ciphertext');
  }
});

test('FR-BGSTAB-030 AC-3 a malformed value is not blamed on the key', () => {
  // Boundary control. If every failure said "wrong key", the message would be
  // as uninformative as the one it replaced — it would just be wrong in a new
  // direction, and this is the case where the key is fine.
  const service = new CryptoService(WSL_SOURCE, { keySourceLabel: WSL_SOURCE });

  let message = '';
  try {
    service.decrypt('not-encrypted-at-all');
    assert.fail('expected a failure for a value that is not in enc(...) form');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert.ok(
    !/different key|key source/i.test(message),
    `a malformed value must not be reported as a key mismatch, got: ${message}`,
  );
});

test('FR-BGSTAB-030 AC-3 a round trip under one key source still works', () => {
  const service = new CryptoService(WSL_SOURCE, { keySourceLabel: WSL_SOURCE });
  assert.equal(service.decrypt(service.encrypt('round-trip')), 'round-trip');
});

test('FR-BGSTAB-030 AC-3 the label is optional, so existing callers keep working', () => {
  const service = new CryptoService(WSL_SOURCE);
  assert.equal(service.decrypt(service.encrypt('no-label')), 'no-label');

  const other = new CryptoService(WINDOWS_SOURCE);
  assert.throws(() => other.decrypt(service.encrypt('no-label')), /Decryption failed/);
});
