/**
 * IP classification shared by the SSRF gate and by unit tests.
 *
 * The rules live in one place on purpose: the previous version had the same
 * address logic inlined in `unsafePushUrl`, so the "does this block CGNAT?"
 * question could only be answered by reading a 60-line function, and a fix in
 * one branch (IPv6 brackets) did not reach the other (DNS lookups).
 */
import { isIP } from 'node:net';

/**
 * Why `address` must not be used as a server-side request target, or `null`
 * when it is a public address. The message is user-facing: it is logged as the
 * rejection reason.
 */
export function privateAddressReason(address: string): string | null {
  const host = address.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'empty address';

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'localhost is not an allowed push target';
  }

  const version = isIP(host);

  if (version === 6) {
    // IPv4-mapped/-compatible forms reach the same hosts through an IPv6
    // literal, so classify the embedded v4 address too.
    const mapped = host.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return privateAddressReason(mapped[1]);

    if (host === '::1' || host === '::') {
      return 'IPv6 loopback/unspecified is not an allowed push target';
    }
    if (/^f[cd]/.test(host)) return 'IPv6 unique-local (fc00::/7) is not an allowed push target';
    if (/^fe[89ab]/.test(host)) return 'IPv6 link-local (fe80::/10) is not an allowed push target';
    if (/^ff/.test(host)) return 'IPv6 multicast is not an allowed push target';
    return null;
  }

  if (version !== 4) return null; // a hostname: the caller resolves and re-checks

  const octets = host.split('.').map(Number);
  const [a, b] = octets;
  if (a === 10) return 'RFC1918 private (10/8) is not an allowed push target';
  if (a === 127) return 'loopback (127/8) is not an allowed push target';
  if (a === 0) return 'unspecified (0/8) is not an allowed push target';
  if (a === 169 && b === 254) return 'link-local (169.254/16) is not an allowed push target';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private (172.16/12) is not an allowed push target';
  if (a === 192 && b === 168) return 'RFC1918 private (192.168/16) is not an allowed push target';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT (100.64/10) is not an allowed push target';
  if (a === 192 && b === 0 && octets[2] === 0) return 'IETF protocol assignments (192.0.0/24) are not allowed';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking range (198.18/15) is not allowed';
  if (a >= 224) return 'multicast/reserved (224/4 and above) is not allowed';
  return null;
}

/** Convenience boolean form. */
export function isPrivateAddress(address: string): boolean {
  return privateAddressReason(address) !== null;
}
