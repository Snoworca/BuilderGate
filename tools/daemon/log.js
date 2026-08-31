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

/**
 * Bound for the runtime log. The server's stdout is teed into it verbatim,
 * including a periodic telemetry object, so an unbounded file grows without any
 * upper limit — 3.4 GB observed on a development machine before this existed.
 * The total kept is `maxBytes * (keep + 1)`.
 */
const LOG_ROTATION = Object.freeze({ maxBytes: 32 * 1024 * 1024, keep: 3 });

/**
 * Moves the log aside once it reaches the limit, keeping a bounded number of
 * older generations. Renaming rather than truncating means a reader holding the
 * old path keeps a consistent file, and the caller's next write starts a fresh
 * one.
 *
 * Never throws: a log that cannot be rotated must not stop the thing that was
 * trying to write to it.
 */
function rotateLogIfOversized(logPath, options = {}) {
  const maxBytes = options.maxBytes ?? LOG_ROTATION.maxBytes;
  const keep = options.keep ?? LOG_ROTATION.keep;

  let size;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  try {
    // Drop the generation that would fall off the end, then shift the rest up.
    fs.rmSync(`${logPath}.${keep}`, { force: true });
    for (let generation = keep - 1; generation >= 1; generation -= 1) {
      const from = `${logPath}.${generation}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${logPath}.${generation + 1}`);
    }
    fs.renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}

function appendLog(logPath, message) {
  ensureLogDir(path.dirname(logPath));
  rotateLogIfOversized(logPath);
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${maskSecretText(message)}\n`, 'utf8');
}

module.exports = {
  LOG_ROTATION,
  appendLog,
  ensureLogDir,
  maskObject,
  maskSecretText,
  rotateLogIfOversized,
};
