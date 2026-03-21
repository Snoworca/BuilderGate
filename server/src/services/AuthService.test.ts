import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from './AuthService.js';
import { CryptoService } from './CryptoService.js';

test('AuthService.updateRuntimeConfig updates password validation and future token duration', () => {
  const cryptoService = new CryptoService('auth-service-test');
  const service = new AuthService({
    password: 'old-password',
    durationMs: 60000,
    maxDurationMs: 86400000,
    jwtSecret: 'jwt-secret',
  }, cryptoService);

  try {
    assert.equal(service.validatePassword('old-password'), true);

    service.updateRuntimeConfig({
      password: cryptoService.encrypt('new-password'),
      durationMs: 120000,
    });

    assert.equal(service.validatePassword('old-password'), false);
    assert.equal(service.validatePassword('new-password'), true);
    assert.equal(service.getSessionDuration(), 120000);

    const { payload } = service.issueToken();
    assert.equal(payload.exp - payload.iat, 120);
  } finally {
    service.destroy();
  }
});
