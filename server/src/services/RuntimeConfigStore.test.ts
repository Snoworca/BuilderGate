import test from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../types/config.types.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';

function createConfigFixture(): Config {
  return {
    server: {
      port: 4242,
    },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      maxBufferSize: 65536,
      shell: 'auto',
    },
    session: {
      idleDelayMs: 200,
    },
    security: {
      cors: {
        allowedOrigins: ['https://example.com'],
        credentials: true,
        maxAge: 86400,
      },
    },
    auth: {
      password: 'enc(secret)',
      durationMs: 1800000,
      maxDurationMs: 86400000,
      jwtSecret: 'enc(jwt)',
    },
    fileManager: {
      maxFileSize: 1048576,
      maxCodeFileSize: 524288,
      maxDirectoryEntries: 10000,
      blockedExtensions: ['.exe', '.dll'],
      blockedPaths: ['.ssh', '.aws'],
      cwdCacheTtlMs: 1000,
    },
    twoFactor: {
      externalOnly: false,
      email: {
        enabled: true,
        address: 'admin@example.com',
        otpLength: 6,
        otpExpiryMs: 300000,
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          auth: {
            user: 'admin@example.com',
            password: 'enc(smtp)',
          },
          tls: {
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          },
        },
      },
    },
  };
}

test('RuntimeConfigStore builds a redacted editable snapshot', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'win32');
  const snapshot = store.getSnapshot();

  assert.equal(store.isEditable('auth.durationMs'), true);
  assert.equal(store.isEditable('server.port'), false);
  assert.equal(snapshot.values.auth.durationMs, 1800000);
  assert.equal(snapshot.values.twoFactor.email.smtp.auth.user, 'admin@example.com');
  assert.equal('password' in snapshot.values.twoFactor.email.smtp.auth, false);
  assert.equal(snapshot.capabilities['auth.password'].writeOnly, true);
  assert.equal(snapshot.capabilities['twoFactor.email.smtp.auth.password'].writeOnly, true);
  assert.equal(snapshot.secretState.authPasswordConfigured, true);
  assert.equal(snapshot.secretState.smtpPasswordConfigured, true);
  assert.ok(snapshot.excludedSections.includes('ssl.*'));
  assert.ok(snapshot.excludedSections.includes('fileManager.maxCodeFileSize'));
});

test('RuntimeConfigStore marks platform-specific capabilities and merges editable patches', () => {
  const store = new RuntimeConfigStore(createConfigFixture(), 'linux');
  const capabilities = store.getFieldCapabilities();

  assert.equal(capabilities['pty.useConpty'].available, false);
  assert.equal(capabilities['pty.useConpty'].reason, 'Windows-only PTY backend');
  assert.deepEqual(capabilities['pty.shell'].options, ['auto', 'bash']);

  const merged = store.mergeEditablePatch({
    auth: {
      durationMs: 3600000,
      currentPassword: 'ignored',
      newPassword: 'ignored',
      confirmPassword: 'ignored',
    },
    twoFactor: {
      email: {
        address: 'ops@example.com',
        smtp: {
          auth: {
            user: 'ops@example.com',
            password: 'secret',
          },
        },
      },
    },
    fileManager: {
      blockedExtensions: ['.ps1'],
    },
  });

  assert.equal(merged.auth.durationMs, 3600000);
  assert.equal(merged.twoFactor.email.address, 'ops@example.com');
  assert.equal(merged.twoFactor.email.smtp.auth.user, 'ops@example.com');
  assert.deepEqual(merged.fileManager.blockedExtensions, ['.ps1']);
});
