const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appendLog, rotateLogIfOversized, LOG_ROTATION } = require('./log.js');

/**
 * The daemon log had no bound. Measured 2026-08-29 on a development machine it
 * reached 3,391,752,904 bytes — the server's stdout is teed into it verbatim,
 * including a periodic telemetry object, and nothing ever truncated or rotated
 * the file.
 *
 * Rotation has to hold two things that a naive size check does not. Renaming
 * must not lose the newest writes, and it must be bounded on both sides: a
 * fixed number of generations, and no growth without limit in their count.
 */

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bg-log-rot-'));
}

function write(logPath, bytes) {
  fs.writeFileSync(logPath, 'x'.repeat(bytes), 'utf8');
}

test('a log under the limit is left alone', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'daemon.log');
  write(logPath, 100);

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 1_000, keep: 2 });

  assert.equal(rotated, false);
  assert.equal(fs.readFileSync(logPath, 'utf8').length, 100);
  assert.equal(fs.existsSync(`${logPath}.1`), false);
});

test('a log at the limit rotates and starts empty', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'daemon.log');
  write(logPath, 1_000);

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 1_000, keep: 2 });

  assert.equal(rotated, true);
  assert.equal(fs.existsSync(logPath), false, 'the current log should be moved aside, not truncated in place');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8').length, 1_000, 'the rotated generation lost its content');
});

test('generations shift and the oldest is dropped', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'daemon.log');

  write(logPath, 1_000);
  rotateLogIfOversized(logPath, { maxBytes: 1_000, keep: 2 });
  fs.writeFileSync(logPath, 'second'.padEnd(1_000, 'y'), 'utf8');
  rotateLogIfOversized(logPath, { maxBytes: 1_000, keep: 2 });
  fs.writeFileSync(logPath, 'third'.padEnd(1_000, 'z'), 'utf8');
  rotateLogIfOversized(logPath, { maxBytes: 1_000, keep: 2 });

  assert.ok(fs.readFileSync(`${logPath}.1`, 'utf8').startsWith('third'), '.1 is not the newest generation');
  assert.ok(fs.readFileSync(`${logPath}.2`, 'utf8').startsWith('second'), '.2 is not the previous generation');
  assert.equal(fs.existsSync(`${logPath}.3`), false, 'generations grew past the keep count');
});

test('a missing log is not an error', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'absent.log');

  assert.equal(rotateLogIfOversized(logPath, { maxBytes: 10, keep: 2 }), false);
  assert.equal(fs.existsSync(logPath), false);
});

test('appendLog rotates on its own and keeps the new line', () => {
  const dir = tempDir();
  const logPath = path.join(dir, 'daemon.log');
  write(logPath, LOG_ROTATION.maxBytes);

  appendLog(logPath, 'after rotation');

  const current = fs.readFileSync(logPath, 'utf8');
  assert.ok(current.includes('after rotation'), 'the line that triggered rotation was lost');
  assert.ok(current.length < LOG_ROTATION.maxBytes, 'the current log did not start fresh');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8').length, LOG_ROTATION.maxBytes);
});

test('the default bound is far below the size this log actually reached', () => {
  // 3,391,752,904 bytes observed. A default that does not comfortably exclude
  // that number would not have prevented it.
  assert.ok(LOG_ROTATION.maxBytes > 0);
  assert.ok(
    LOG_ROTATION.maxBytes * (LOG_ROTATION.keep + 1) < 3_391_752_904 / 10,
    'the total bound is not an order of magnitude below the size observed',
  );
});
