const fs = require('fs');
const path = require('path');

const SENSITIVE_KEY_PATTERN = /(password|secret|token|shutdownToken|jwtSecret|otpCode|totpCode|verificationCode|otp)/i;
const SENSITIVE_KEY_SOURCE = 'password|secret|token|shutdownToken|jwtSecret|otpCode|totpCode|verificationCode|otp';

function maskSecretText(value) {
  return String(value)
    .replace(
      new RegExp(`(["']?)(${SENSITIVE_KEY_SOURCE})\\1(\\s*[:=]\\s*)(["'])([^"']*)(\\4)`, 'gi'),
      (_match, keyQuote, key, separator, valueQuote) => `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`,
    )
    .replace(
      new RegExp(`(["'])(${SENSITIVE_KEY_SOURCE})\\1(\\s*[:=]\\s*)([^"',\\s}]+)`, 'gi'),
      (_match, keyQuote, key, separator) => `${keyQuote}${key}${keyQuote}${separator}[REDACTED]`,
    )
    .replace(
      new RegExp(`\\b(${SENSITIVE_KEY_SOURCE})(\\s*[:=]\\s*)([^"',\\s}]+)`, 'gi'),
      (_match, key, separator) => `${key}${separator}[REDACTED]`,
    );
}

function maskObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => maskObject(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const masked = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      masked[key] = '[REDACTED]';
    } else {
      masked[key] = maskObject(entry);
    }
  }

  return masked;
}

function ensureLogDir(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
}

function appendLog(logPath, message) {
  ensureLogDir(path.dirname(logPath));
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${maskSecretText(message)}\n`, 'utf8');
}

module.exports = {
  appendLog,
  ensureLogDir,
  maskObject,
  maskSecretText,
};
