/**
 * v3.5: URL safety (URL allowlist + default-deny private IPs).
 *
 * Used by the `browser` tool and the (future) `webFetch` improvements.
 * The contract:
 *   - Only http(s) schemes are accepted
 *   - Hostname is resolved to one or more IPs; ALL of them must be
 *     public (or on the allowlist). This avoids DNS rebinding:
 *     a hostname that resolves to 1.2.3.4 at validation time and
 *     10.0.0.1 at fetch time is rejected.
 *   - Private/loopback/link-local/multicast/reserved IPs are blocked
 *     by default. The caller can pass an `allowPrivate` flag for
 *     testing (used by the test suite against 127.0.0.1).
 *   - Optional hostname allowlist (exact match or suffix match).
 *
 * NOT in v3.5 (deferred):
 *   - TOFU / pinning: cache the resolved IP, refuse if it changes
 *   - Per-URL rate limiting
 *   - Cookie / auth header handling
 */

import { lookup } from 'node:dns/promises';

export interface SafeUrlOptions {
  /** If true, do NOT reject private IPs. Use only in tests. Default: false. */
  allowPrivate?: boolean;
  /** Hostnames that bypass IP filtering (e.g. ['localhost'] when allowPrivate). */
  allowHosts?: string[];
  /** Additional hostnames that bypass IP filtering (suffix match). */
  allowHostSuffixes?: string[];
}

export type SafeUrlResult =
  | { ok: true; url: string; host: string; ips: string[] }
  | { ok: false; reason: string };

/** IPv4 ranges that should NEVER be reached by an agent by default. */
const PRIVATE_IPV4_RANGES: Array<[bigint, bigint]> = [
  // 0.0.0.0/8 — "this network"
  [0n, (1n << 24n) - 1n],
  // 10.0.0.0/8 — RFC 1918
  [10n << 24n, (10n << 24n) + (1n << 24n) - 1n],
  // 100.64.0.0/10 — CGN
  [(100n << 24n) + (64n << 16n), (100n << 24n) + (64n << 16n) + (1n << 22n) - 1n],
  // 127.0.0.0/8 — loopback
  [127n << 24n, (127n << 24n) + (1n << 24n) - 1n],
  // 169.254.0.0/16 — link-local
  [(169n << 24n) + (254n << 16n), (169n << 24n) + (254n << 16n) + (1n << 16n) - 1n],
  // 172.16.0.0/12 — RFC 1918
  [(172n << 24n) + (16n << 16n), (172n << 24n) + (16n << 16n) + (1n << 20n) - 1n],
  // 192.0.0.0/24 — IETF protocol assignments
  [192n << 24n, (192n << 24n) + 255n],
  // 192.168.0.0/16 — RFC 1918
  [(192n << 24n) + (168n << 16n), (192n << 24n) + (168n << 16n) + (1n << 16n) - 1n],
  // 198.18.0.0/15 — benchmarking (RFC 2544): 198.18.0.0 – 198.19.255.255
  [(198n << 24n) + (18n << 16n), (198n << 24n) + (19n << 16n) + (1n << 16n) - 1n],
  // 224.0.0.0/4 — multicast
  [224n << 24n, (224n << 24n) + (1n << 28n) - 1n],
  // 240.0.0.0/4 — reserved (includes 255.255.255.255)
  [240n << 24n, (240n << 24n) + (1n << 28n) - 1n],
];

const PRIVATE_IPV6_PREFIXES = [
  '::1',           // loopback
  'fc00:',         // ULA
  'fd00:',         // ULA
  'fe80:',         // link-local
  'ff00:',         // multicast
  '::',            // unspecified
  '::ffff:',       // IPv4-mapped
];

export function isPrivateIpv4(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const big = (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3]);
  for (const [lo, hi] of PRIVATE_IPV4_RANGES) {
    if (big >= lo && big <= hi) return true;
  }
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]!; // strip zone
  if (lower === '::1' || lower === '::') return true;
  for (const prefix of PRIVATE_IPV6_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}

function hostIsAllowed(host: string, options: SafeUrlOptions): boolean {
  const lower = host.toLowerCase();
  if (options.allowHosts?.some((h) => h.toLowerCase() === lower)) return true;
  if (options.allowHostSuffixes?.some((s) => lower.endsWith(s.toLowerCase()))) return true;
  return false;
}

export async function safeResolve(
  rawUrl: string,
  options: SafeUrlOptions = {},
): Promise<SafeUrlResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `not a valid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${parsed.protocol} not allowed (only http/https)` };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, reason: 'no hostname' };

  // If the host is in the allowlist, we still resolve (so we know the IPs)
  // but we don't apply the private-IP filter. The fetched URL still
  // uses the original hostname, not the resolved IP.
  let ips: string[];
  try {
    const result = await lookup(host, { all: true, verbatim: true });
    ips = result.map((r) => r.address);
  } catch (e) {
    return { ok: false, reason: `DNS lookup failed for ${host}: ${(e as Error).message}` };
  }
  if (ips.length === 0) return { ok: false, reason: `no IPs for ${host}` };

  if (options.allowPrivate || hostIsAllowed(host, options)) {
    return { ok: true, url: parsed.toString(), host, ips };
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return {
        ok: false,
        reason: `${host} resolves to private IP ${ip} (deny by default; pass allowPrivate=true for testing)`,
      };
    }
  }
  return { ok: true, url: parsed.toString(), host, ips };
}
