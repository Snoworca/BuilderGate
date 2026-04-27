const assert = require('node:assert/strict');
const test = require('node:test');

const { maskObject, maskSecretText } = require('./log');

test('maskSecretText redacts tokens and secrets in diagnostic output', () => {
  const masked = maskSecretText('shutdownToken=abc123 jwtSecret: "jwt" secret="totp" password: "pw"');

  assert.doesNotMatch(masked, /abc123|jwt"|totp"|pw"/);
  assert.match(masked, /\[REDACTED\]/);
});

test('maskSecretText redacts JSON-style quoted secrets', () => {
  const masked = maskSecretText('{"shutdownToken":"abc123","jwtSecret":"jwt","password":"pw","otpCode":"123456","totpCode":"234567","verificationCode":"345678","otp":456789}');

  assert.doesNotMatch(masked, /abc123|"jwt"|"pw"|123456|234567|345678|456789/);
  assert.match(masked, /"shutdownToken":"\[REDACTED\]"/);
  assert.match(masked, /"otpCode":"\[REDACTED\]"/);
  assert.match(masked, /"otp":\[REDACTED\]/);
});

test('maskObject recursively redacts sensitive keys', () => {
  const masked = maskObject({
    ok: 'visible',
    shutdownToken: 'hide-me',
    nested: {
      jwtSecret: 'hide-me-too',
    },
  });

  assert.equal(masked.ok, 'visible');
  assert.equal(masked.shutdownToken, '[REDACTED]');
  assert.equal(masked.nested.jwtSecret, '[REDACTED]');
});
