const assert = require('node:assert/strict');
const test = require('node:test');

const { formatHelp, parseArgs } = require('./cli');

test('parseArgs defaults to daemon mode and preserves existing launch options', () => {
  const parsed = parseArgs([
    '--port',
    '2002',
    '--bootstrap-allow-ip',
    '127.0.0.1, 10.0.0.8',
    '--reset-password',
  ]);

  assert.equal(parsed.mode, 'daemon');
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.cliPort, 2002);
  assert.equal(parsed.port, 2002);
  assert.deepEqual(parsed.bootstrapAllowedIps, ['127.0.0.1', '10.0.0.8']);
  assert.equal(parsed.resetPassword, true);
  assert.equal(parsed.internalApp, false);
  assert.equal(parsed.internalSentinel, false);
  assert.equal(parsed.help, false);
});

test('parseArgs accepts foreground and legacy forground aliases', () => {
  assert.equal(parseArgs(['--foreground']).mode, 'foreground');
  assert.equal(parseArgs(['--forground']).mode, 'foreground');
});

test('parseArgs accepts stop subcommand', () => {
  const parsed = parseArgs(['stop']);

  assert.equal(parsed.command, 'stop');
  assert.equal(parsed.mode, 'stop');
  assert.equal(parsed.help, false);
});

test('parseArgs accepts internal sentinel flag without changing the public mode default', () => {
  const parsed = parseArgs([
    '--internal-sentinel',
    '--internal-sentinel-state',
    'C:/runtime/buildergate.daemon.json',
    '--internal-sentinel-start',
    'attempt-1',
    '-p',
    '65535',
  ]);

  assert.equal(parsed.mode, 'daemon');
  assert.equal(parsed.internalSentinel, true);
  assert.equal(parsed.internalSentinelStatePath, 'C:/runtime/buildergate.daemon.json');
  assert.equal(parsed.internalSentinelStartAttemptId, 'attempt-1');
  assert.equal(parsed.port, 65535);
});

test('parseArgs accepts internal app flag without exposing it as a public mode', () => {
  const parsed = parseArgs(['--internal-app']);

  assert.equal(parsed.mode, 'daemon');
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.internalApp, true);
});

test('parseArgs rejects invalid ports and missing values', () => {
  assert.throws(() => parseArgs(['--port', '1023']), /between 1024 and 65535/);
  assert.throws(() => parseArgs(['--port', '65536']), /between 1024 and 65535/);
  assert.throws(() => parseArgs(['--port', 'abc']), /valid integer/);
  assert.throws(() => parseArgs(['--port']), /requires a port value/);
  assert.throws(() => parseArgs(['--bootstrap-allow-ip']), /requires an IP value/);
  assert.throws(() => parseArgs(['--bootstrap-allow-ip=']), /at least one IP value/);
  assert.throws(() => parseArgs(['--bootstrap-allow-ip', ', ,']), /at least one IP value/);
});

test('parseArgs rejects unknown options instead of silently ignoring them', () => {
  assert.throws(() => parseArgs(['--daemon']), /Unknown option: --daemon/);
  assert.throws(() => parseArgs(['--not-real']), /Unknown option: --not-real/);
  assert.throws(() => parseArgs(['--foreground', 'stop']), /stop command must be the first argument/);
});

test('formatHelp documents daemon default, foreground aliases, stop, dist/bin, and config policy', () => {
  const help = formatHelp({ executableName: 'BuilderGate.exe', packaged: true });

  assert.match(help, /default mode is daemon/i);
  assert.match(help, /--foreground/);
  assert.match(help, /--forground/);
  assert.match(help, /BuilderGate\.exe stop/);
  assert.match(help, /dist[/\\]bin/);
  assert.match(help, /config\.json5 next to the executable/i);
});
