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

// #54: two legitimate loopback spellings were rejected. Both are fail-CLOSED -- the predicate
// refused access rather than granting it -- so nothing was ever wrongly let in. The defect is
// an undocumented gap in a security predicate that also guards bootstrap access, which is the
// kind of gap that gets discovered by someone's environment rather than by a test.
//
//   ::FFFF:127.0.0.1    IPv4-mapped IPv6 with UPPERCASE hex. RFC 4291 hex is case-insensitive;
//                       the old prefix test was a case-sensitive startsWith.
//   0:0:0:0:0:0:0:1     ::1 written out. The same address, not abbreviated.
//
// Normalising here rather than widening LOOPBACK_IPS is deliberate: this function also
// normalises the operator's allowlist, so an operator who writes either spelling in
// BUILDERGATE_BOOTSTRAP_ALLOWED_IPS now matches a peer that reports the other one.
export function normalizeBootstrapIpEntry(value: string): string {
  const trimmed = value.trim();
  const mappedPrefix = /^::ffff:/i;
  if (mappedPrefix.test(trimmed)) {
    const mapped = trimmed.replace(mappedPrefix, '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
      return mapped;
    }
  }
  // Fully expanded IPv6 loopback. Only this one address is collapsed, not general IPv6
  // abbreviation: a normaliser that tried to canonicalise every IPv6 form would be a second,
  // weaker implementation of something the platform already does, and getting it subtly wrong
  // inside a security predicate is worse than not having it.
  if (/^0{1,4}(:0{1,4}){6}:0{0,3}1$/i.test(trimmed)) {
    return '::1';
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
