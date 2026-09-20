import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeGlobalPtyBackend } from './ptyPlatformPolicy.js';

/**
 * CON-BGSTAB-002 AC-5. The startup banner must not name a backend the platform
 * does not have.
 *
 * Measured 2026-09-21: the banner was `config.pty.useConpty ? 'ConPTY' : 'winpty'`,
 * a two-way choice between two WINDOWS backends, printed on every platform. On
 * Linux `useConpty` is forced false by normalizePtyConfigForPlatform, so the
 * banner read `Global PTY: winpty` on a host that has no winpty at all — winpty
 * is a Windows shim that drives a hidden console, and Linux has had real PTYs
 * since long before either Windows mechanism existed. A WSL run in this session
 * printed exactly that line and it was copied into a report as if it meant
 * something.
 */

test('CON-BGSTAB-002 AC-5 Windows reports the backend it actually selected', () => {
  assert.equal(describeGlobalPtyBackend('win32', true), 'ConPTY');
  assert.equal(describeGlobalPtyBackend('win32', false), 'winpty');
});

test('CON-BGSTAB-002 AC-5 other platforms report their native pty, not a Windows shim', () => {
  for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
    const label = describeGlobalPtyBackend(platform, false);
    assert.ok(
      !/winpty|ConPTY/i.test(label),
      `${platform} must not be described with a Windows backend, got: ${label}`,
    );
    assert.match(label, /pty/i, `${platform} should still say what it uses, got: ${label}`);
  }
});

test('CON-BGSTAB-002 AC-5 a stray useConpty off Windows cannot change the label', () => {
  // The flag is forced false off Windows, but the banner must not depend on that
  // staying true somewhere else: it is a Windows-only concept, so it has no say
  // here regardless of its value.
  assert.equal(
    describeGlobalPtyBackend('linux', true),
    describeGlobalPtyBackend('linux', false),
  );
});
