'use strict';

const https = require('node:https');

/**
 * FR-BGSTAB-033. A second start while BuilderGate already runs says so in one line and exits.
 * It used to print the running daemon's PIDs and then the whole start-up banner, so it read as
 * if a new instance had started.
 */

const HEALTH_TIMEOUT_MS = 1500;

function formatAlreadyRunningLine(port) {
  return `BuilderGate is already running at https://localhost:${port}.`;
}

/** This data root's own daemon, from its state file. No config is needed for this check. */
async function detectRunningOwnDaemon(paths, deps) {
  const inspection = await deps.inspectExistingDaemon(paths);
  const port = inspection?.state?.port;
  if (inspection?.active && Number.isInteger(port)) {
    return { running: true, port };
  }
  return { running: false };
}

/** What `/health` answers on a BuilderGate server, and nothing else is likely to. */
function isBuilderGateHealthBody(body) {
  return Boolean(body)
    && typeof body === 'object'
    && body.status === 'ok'
    && typeof body.buildId === 'string'
    && typeof body.rootsForeign === 'boolean';
}

function fetchHealth(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const request = https.get({
      host: 'localhost',
      port,
      path: '/health',
      // The local server uses a self-signed certificate by default.
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 64 * 1024) request.destroy(new Error('health response too large'));
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('health request timed out')));
    request.on('error', reject);
  });
}

/** A BuilderGate from another data root (portable, source checkout, MSI) on the same port. */
async function detectRunningBuilderGateOnPort(port, deps = {}) {
  const isPortFree = deps.isPortFree;
  if (await isPortFree(port)) return { running: false };
  try {
    const body = await (deps.fetchHealth ?? fetchHealth)(port);
    return isBuilderGateHealthBody(body) ? { running: true, port } : { running: false };
  } catch {
    return { running: false };
  }
}

/** One line, and the browser when it was asked for (FR-BGSTAB-032 AC-3). Nothing else. */
function reportAlreadyRunning(port, { open }, deps) {
  deps.log(formatAlreadyRunningLine(port));
  if (open && deps.hasDefaultBrowser()) {
    deps.openBrowser(`https://localhost:${port}`);
  }
}

module.exports = {
  detectRunningBuilderGateOnPort,
  detectRunningOwnDaemon,
  fetchHealth,
  formatAlreadyRunningLine,
  isBuilderGateHealthBody,
  reportAlreadyRunning,
};
