import type { BootstrapAllowPolicy } from '../types/auth.types.js';

const LOOPBACK_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

export interface BootstrapAccessEvaluation {
  requestIp: string;
  requesterAllowed: boolean;
  allowPolicy: BootstrapAllowPolicy;
}

export function normalizeBootstrapIpEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('::ffff:')) {
    const mapped = trimmed.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
      return mapped;
    }
  }
  return trimmed;
}

export function parseBootstrapAllowedIpsFromEnv(
  value: string | undefined = process.env.BUILDERGATE_BOOTSTRAP_ALLOWED_IPS,
): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(',').map(normalizeBootstrapIpEntry).filter(Boolean))];
}

export function isLoopbackIp(ip: string | undefined | null): boolean {
  return Boolean(ip && LOOPBACK_IPS.has(normalizeBootstrapIpEntry(ip)));
}

export function evaluateBootstrapAccess(
  requestIp: string | undefined | null,
  configuredAllowedIps: string[] = [],
  envAllowedIps: string[] = [],
): BootstrapAccessEvaluation {
  const normalizedIp = normalizeBootstrapIpEntry(requestIp ?? '');
  const allowedIps = new Set([
    ...configuredAllowedIps.map(normalizeBootstrapIpEntry).filter(Boolean),
    ...envAllowedIps.map(normalizeBootstrapIpEntry).filter(Boolean),
  ]);

  if (isLoopbackIp(normalizedIp)) {
    return {
      requestIp: normalizedIp,
      requesterAllowed: true,
      allowPolicy: 'localhost',
    };
  }

  if (normalizedIp && allowedIps.has(normalizedIp)) {
    return {
      requestIp: normalizedIp,
      requesterAllowed: true,
      allowPolicy: 'allowlist',
    };
  }

  return {
    requestIp: normalizedIp,
    requesterAllowed: false,
    allowPolicy: 'denied',
  };
}
