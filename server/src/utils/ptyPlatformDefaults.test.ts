import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getBootstrapPtyDefaults,
  normalizePtyConfigForPlatform,
  normalizeRawConfigForPlatform,
} from './ptyPlatformPolicy.js';

/**
 * CON-BGSTAB-002 — the default is the platform's NATIVE pseudo-terminal, on
 * every OS. User direction 2026-09-21.
 *
 * Linux and macOS have had real PTYs for decades and node-pty goes straight to
 * them; there is no second mechanism to choose between. Windows had none until
 * ConPTY, which is the reason winpty exists at all — it drives a hidden console
 * window and scrapes it. ConPTY is the Windows member of the same family as the
 * Unix PTY, so "native pseudo-terminal everywhere" resolves to ConPTY there.
 *
 * This is a DEFAULT, not a forced value. `windowsPowerShellBackend` keeps its
 * three options and a deployment that sets `winpty` still gets winpty; what
 * changes is only what an unset key means.
 */

test('CON-BGSTAB-002 AC-1 Windows defaults to ConPTY, and PowerShell inherits it', () => {
  const defaults = getBootstrapPtyDefaults('win32');

  assert.equal(defaults.useConpty, true);
  // `inherit` rather than an explicit 'conpty': PowerShell follows the global
  // choice instead of being carved out, so there is one switch to reason about.
  // An explicit 'winpty' here would also make a working winpty a precondition
  // for PowerShell on a fresh install, via assertPowerShellWinptyAvailable().
  assert.equal(defaults.windowsPowerShellBackend, 'inherit');
});

test('CON-BGSTAB-002 AC-1 a Windows config missing both keys receives those defaults', () => {
  // The path that decides a running deployment's value: loadConfig normalises
  // the raw config BEFORE zod sees it (config.ts), so a key absent from
  // config.json5 is filled here, not by the schema default.
  const normalized = normalizeRawConfigForPlatform({ pty: {} }, 'win32') as {
    pty: { useConpty: unknown; windowsPowerShellBackend: unknown };
  };

  assert.equal(normalized.pty.useConpty, true);
  assert.equal(normalized.pty.windowsPowerShellBackend, 'inherit');
});

test('CON-BGSTAB-002 AC-2 an explicit value still wins over the default', () => {
  // A default is a default. The point of setting one is the unset case; a
  // deployment that has chosen otherwise must keep its choice, or this is a
  // forced value wearing a default's name.
  const normalized = normalizeRawConfigForPlatform(
    { pty: { useConpty: false, windowsPowerShellBackend: 'winpty' } },
    'win32',
  ) as { pty: { useConpty: unknown; windowsPowerShellBackend: unknown } };

  assert.equal(normalized.pty.useConpty, false);
  assert.equal(normalized.pty.windowsPowerShellBackend, 'winpty');
});

test('CON-BGSTAB-002 AC-3 non-Windows carries no Windows backend at all', () => {
  // Boundary control. `useConpty` and `windowsPowerShellBackend` name Windows
  // mechanisms; node-pty has neither concept elsewhere and uses the kernel PTY.
  // If either leaked off Windows the config would be describing a backend that
  // does not exist on that host.
  for (const platform of ['linux', 'darwin'] as const) {
    const defaults = getBootstrapPtyDefaults(platform);
    assert.equal(defaults.useConpty, false, `${platform} must not carry ConPTY`);
    assert.equal(defaults.windowsPowerShellBackend, 'inherit', `${platform} must stay inherit`);

    const normalized = normalizePtyConfigForPlatform(
      { useConpty: true, windowsPowerShellBackend: 'winpty' },
      platform,
    );
    assert.equal(normalized.useConpty, false);
    assert.equal(normalized.windowsPowerShellBackend, 'inherit');
  }
});

test('CON-BGSTAB-002 AC-4 a fresh install is created with those values', async () => {
  // The path a new deployment actually takes: `ensureConfigExists` writes a
  // config from the bootstrap template before anything reads it, so what a
  // fresh install starts with is decided by the template renderer, not by the
  // normaliser that fills a key later.
  const { renderBootstrapConfigTemplate } = await import('./configTemplate.js');

  const windows = renderBootstrapConfigTemplate('win32');
  assert.match(windows, /useConpty:\s*true/);
  assert.match(windows, /windowsPowerShellBackend:\s*"inherit"/);

  const linux = renderBootstrapConfigTemplate('linux');
  assert.match(linux, /useConpty:\s*false/);
  assert.match(linux, /windowsPowerShellBackend:\s*"inherit"/);
});

test('CON-BGSTAB-002 AC-4 the ConPTY default is not silently undone by the schema', () => {
  // zod defaults `useConpty` to false, platform-agnostically. That is fine only
  // because normalizeRawConfigForPlatform runs FIRST and has already filled the
  // Windows value — the schema never sees an unset key on win32. If that order
  // ever reversed, a Windows deployment would quietly drop to winpty, so this
  // pins the order's observable consequence rather than the order itself.
  const normalized = normalizeRawConfigForPlatform({}, 'win32') as {
    pty: { useConpty: unknown };
  };
  assert.equal(normalized.pty.useConpty, true);
});
