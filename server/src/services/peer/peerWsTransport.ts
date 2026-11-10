// FR-MCP-016 (#233): the WebSocket transport of the MCP peer link. The dialer side opens
// wss://.../mcp/peer and checks the certificate fingerprint before anything is sent; the
// acceptor side takes upgrades on the MCP listener. The protocol itself is peerLinkManager.ts.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import WebSocket, { WebSocketServer } from 'ws';
import type { PeerDialHandlers, PeerLinkManager, PeerSocket } from './peerLinkManager.js';
import { isAllowedPeerUrl, isLoopbackHost, normalizeFingerprint, type PeerLinkEntry } from './peerLinkSettings.js';

export const PEER_LINK_PATH = '/mcp/peer';
/** FR-MCP-016 AC-7. */
export const PEER_MAX_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * FR-MCP-016 AC-1/AC-2, FR-MCP-024 AC-3/AC-4: opens the link. Ordinary CA verification is off; the
 * certificate is judged on the upgrade response, before onOpen -- so before hello carries the key.
 * A pinned link is closed when the certificate differs; an unpinned one reports the certificate
 * through onCertificate so it is remembered (trust on first use). Throws PEER_URL_NOT_ALLOWED for
 * ws:// to a host that is not loopback.
 */
export function dialPeerWebSocket(link: PeerLinkEntry, handlers: PeerDialHandlers): PeerSocket {
  if (!isAllowedPeerUrl(link.url)) {
    throw new Error('PEER_URL_NOT_ALLOWED');
  }
  const pinned = link.tlsFingerprintSha256;
  const ws = new WebSocket(link.url, {
    maxPayload: PEER_MAX_FRAME_BYTES,
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    rejectUnauthorized: false,
  });
  let reported = false;
  let lastError: string | undefined;
  const reportClose = (reason: string) => {
    if (reported) return;
    reported = true;
    handlers.onClose(reason);
  };
  ws.on('upgrade', (response) => {
    const socket = response.socket as Partial<TLSSocket>;
    if (typeof socket.getPeerCertificate !== 'function') return; // ws:// to loopback: no certificate
    const presentedRaw = socket.getPeerCertificate()?.fingerprint256;
    const presented = presentedRaw ? normalizeFingerprint(presentedRaw) : undefined;
    if (!presented || (pinned !== undefined && presented !== pinned)) {
      reportClose('PEER_TLS_FINGERPRINT_MISMATCH');
      ws.terminate();
      return;
    }
    if (pinned === undefined) handlers.onCertificate?.(presented);
  });
  ws.on('open', () => {
    if (!reported) handlers.onOpen();
  });
  ws.on('message', (data, isBinary) => {
    if (!reported) handlers.onText(isBinary ? '' : String(data));
  });
  ws.on('error', (error) => {
    lastError = (error as NodeJS.ErrnoException).code ?? error.message;
  });
  ws.on('close', (code) => reportClose(lastError ?? `closed ${code}`));
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => {
      reported = true;
      ws.close();
    },
  };
}

/** FR-MCP-016 AC-5: a plain-HTTP MCP listener takes links only from loopback. */
export function peerUpgradeAllowed(transportSecurity: string, remoteAddress: string): boolean {
  if (transportSecurity !== 'none') return true;
  const address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
  return isLoopbackHost(address);
}

/**
 * The acceptor side: returns an upgrade handler for the MCP listener. It answers true when it took
 * the request (the peer path), false for any other path so the caller can refuse it.
 */
export function createPeerUpgradeHandler(options: {
  manager: Pick<PeerLinkManager, 'accept'>;
  isAllowed: (request: IncomingMessage) => boolean;
}): (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean {
  const wss = new WebSocketServer({ noServer: true, maxPayload: PEER_MAX_FRAME_BYTES });
  return (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://peer').pathname;
    if (path !== PEER_LINK_PATH) return false;
    if (!options.isAllowed(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return true;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const handlers = options.manager.accept({
        send: (text) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(text);
        },
        close: () => ws.close(),
      }, {
        remoteAddress: request.socket.remoteAddress ?? '',
        headers: request.headers,
      });
      ws.on('message', (data, isBinary) => handlers.onText(isBinary ? '' : String(data)));
      ws.on('close', () => handlers.onClose());
      // ws closes the socket itself after an error (1009 for an oversized frame); only keep it from throwing.
      ws.on('error', () => {});
    });
    return true;
  };
}
