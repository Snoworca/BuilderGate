const https = require('https');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readHeader(headers, name) {
  if (!headers) {
    return undefined;
  }

  return normalizeHeaderValue(headers[name] ?? headers[name.toLowerCase()]);
}

function parseInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function matchesHealthIdentity(response, state) {
  if (!response || response.statusCode !== 200 || !state) {
    return false;
  }

  const body = response.body && typeof response.body === 'object' ? response.body : {};
  const pid = parseInteger(body.pid ?? readHeader(response.headers, 'x-buildergate-pid'));
  const stateGeneration = parseInteger(
    body.stateGeneration ?? readHeader(response.headers, 'x-buildergate-state-generation'),
  );
  const startAttemptId = String(
    body.startAttemptId ?? readHeader(response.headers, 'x-buildergate-start-attempt-id') ?? '',
  );

  if (pid !== state.appPid) {
    return false;
  }

  return startAttemptId === state.startAttemptId || stateGeneration === state.stateGeneration;
}

function fetchHealth(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = chunks.join('');
        let body = {};
        if (text.trim()) {
          try {
            body = JSON.parse(text);
          } catch {
            body = { raw: text };
          }
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timed out while polling https://127.0.0.1:${port}/health`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForReadiness({
  port,
  state,
  timeoutMs = 30000,
  intervalMs = 500,
  fetchHealth: fetchHealthFn = fetchHealth,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let observedHealthWithoutIdentity = false;

  do {
    try {
      const response = await fetchHealthFn(port, { timeoutMs: Math.min(intervalMs, 1000) });
      if (matchesHealthIdentity(response, state)) {
        return { ok: true, response };
      }
      if (response?.statusCode === 200) {
        observedHealthWithoutIdentity = true;
      }
    } catch (error) {
      lastError = error;
    }

    if (Date.now() < deadline) {
      await sleep(intervalMs);
    }
  } while (Date.now() < deadline);

  const reason = observedHealthWithoutIdentity
    ? 'readiness identity mismatch'
    : `readiness timeout${lastError ? `: ${lastError.message}` : ''}`;
  return { ok: false, reason };
}

module.exports = {
  fetchHealth,
  matchesHealthIdentity,
  waitForReadiness,
};
