// FR-MSG-008 AC-3/AC-5 (contract §7): the transport of the add-by-address flow.
// - createContactRequestRawHandler: /mcp/contact-request on the MCP listener (no key; the
//   listener's address guard still applies).
// - httpsContactClient: the requester's HTTPS call. The remote is not known yet, so its
//   certificate is not verified; its SHA-256 is reported instead and pinned on first use (TOFU).
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { normalizeFingerprint } from '../peer/peerLinkSettings.js';
import type { ContactHttp, ContactRequestCall } from './contacts.js';

const CONTACT_REQUEST_PATH = '/mcp/contact-request';
const MAX_BODY_BYTES = 4 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export function createContactRequestRawHandler(options: {
  handle: (call: ContactRequestCall) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** The MCP listener's address guard: a denial code, or null when the address may come in. */
  checkAccess: (request: IncomingMessage) => string | null;
}): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://contact');
    if (url.pathname !== CONTACT_REQUEST_PATH && !url.pathname.startsWith(`${CONTACT_REQUEST_PATH}/`)) return false;
    const denied = options.checkAccess(request);
    if (denied) {
      request.resume();
      writeJson(response, 403, { ok: false, code: denied });
      return true;
    }
    void readSmallBody(request).then(async (text) => {
      if (text === undefined) {
        writeJson(response, 413, { ok: false, code: 'BODY_TOO_LARGE' });
        return;
      }
      const answer = await options.handle({
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: parseJson(text),
        remoteAddress: request.socket.remoteAddress ?? '',
      });
      writeJson(response, answer.status, answer.body);
    }).catch((error: unknown) => {
      console.warn('[Messenger] contact request failed:', error instanceof Error ? error.message : String(error));
      if (!response.headersSent) writeJson(response, 500, { ok: false, code: 'INTERNAL_ERROR' });
    });
    return true;
  };
}

export const httpsContactClient: ContactHttp = (input) => new Promise((settle) => {
  // Review M3: whatever happens (end, error, a destroyed oversized answer), the promise settles once.
  let settled = false;
  const resolve = (answer: Awaited<ReturnType<ContactHttp>>) => {
    if (settled) return;
    settled = true;
    settle(answer);
  };
  const unreachable = () => resolve({ status: 0, body: {}, fingerprint: '' });
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  const request = https.request(input.url, {
    method: input.method,
    rejectUnauthorized: false,
    timeout: REQUEST_TIMEOUT_MS,
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (response) => {
    const socket = response.socket as Partial<TLSSocket>;
    const presented = socket.getPeerCertificate?.()?.fingerprint256;
    const fingerprint = presented ? normalizeFingerprint(presented) ?? '' : '';
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_ANSWER_BYTES) {
        unreachable();
        response.destroy();
      }
    });
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: parseJson(text), fingerprint }));
    response.on('error', unreachable);
    response.on('close', unreachable);
  });
  request.on('timeout', () => request.destroy());
  request.on('error', unreachable);
  request.end(payload);
});

function readSmallBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let text = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      if (tooLarge) return;
      text += chunk;
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) tooLarge = true;
    });
    request.on('end', () => resolve(tooLarge ? undefined : text));
    request.on('error', reject);
  });
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}
