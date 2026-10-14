// FR-BGSTAB-034: whether a request may log in without a password because it comes from this
// computer. The socket address alone is not enough:
//   - a reverse proxy on this computer makes every remote visitor look like loopback, so any
//     forwarding header refuses;
//   - a page on another site can make the browser send a request here (DNS rebinding, or a plain
//     cross-site fetch), so the Host and any Origin must also name this computer.
import { isLoopbackIp } from './bootstrapAccessPolicy.js';

export type LocalLoginRefusal = 'disabled' | 'remote-address' | 'proxied' | 'host' | 'origin';

export interface LocalLoginRequest {
  enabled: boolean;
  remoteAddress: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip'];

function header(headers: LocalLoginRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The hostname of a Host header value: `localhost:2222` → `localhost`, `[::1]:2222` → `[::1]`. */
function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  return trimmed.replace(/:\d+$/, '');
}

function isLocalOrigin(origin: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false; // includes the opaque origin "null"
  }
}

export function evaluateLocalLogin(request: LocalLoginRequest): { allowed: true } | { allowed: false; reason: LocalLoginRefusal } {
  if (!request.enabled) return { allowed: false, reason: 'disabled' };
  if (!isLoopbackIp(request.remoteAddress)) return { allowed: false, reason: 'remote-address' };
  if (PROXY_HEADERS.some((name) => header(request.headers, name) !== undefined)) {
    return { allowed: false, reason: 'proxied' };
  }
  const host = header(request.headers, 'host');
  if (!host || !LOCAL_HOSTNAMES.has(hostnameOf(host))) return { allowed: false, reason: 'host' };
  const origin = header(request.headers, 'origin');
  if (origin !== undefined && !isLocalOrigin(origin)) return { allowed: false, reason: 'origin' };
  return { allowed: true };
}
