/** SSRF & DNS-rebinding guard for user-supplied outbound URLs (webhooks, agent tools). */
export type SafeUrlOk = { ok: true; url: URL; resolvedIps?: string[] };
export type SafeUrlErr = { ok: false; error: string };

export interface SafeUrlDnsOptions {
  /** Custom fetch implementation for DoH queries (used in unit tests). */
  dnsFetch?: typeof fetch;
  /** Minimum acceptable DNS TTL in seconds to mitigate automated rebinding (default: 5). */
  minTtlSeconds?: number;
  /** Timeout in milliseconds for the DoH lookup (default: 3000). */
  timeoutMs?: number;
}

const BLOCKED_TLDS = new Set([
  "local",
  "localhost",
  "internal",
  "corp",
  "home",
  "intranet",
  "lan",
  "arpa",
  "invalid",
  "onion",
]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

/** Wildcard DNS services commonly abused for SSRF & DNS rebinding. */
const REBINDING_DOMAINS = [
  "nip.io",
  "sslip.io",
  "xip.io",
  "rbndr.us",
  "1u.ms",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "traefik.me",
  "lacolhost.com",
  "burpcollaborator.net",
  "oastify.com",
];

/**
 * Parses a dotted-quad IPv4 string into 4 octets, or returns null if not an IPv4 literal.
 */
export function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/**
 * Returns true if the 4 IPv4 octets fall in any RFC 6890 special-purpose,
 * private, loopback, link-local, CGNAT, documentation, benchmarking, or multicast range.
 */
export function isPrivateOrReservedIpv4Octets([a, b, c, _d]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("This" network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918 private)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (RFC 6598 CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / Cloud IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918 private)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918 private)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 Multicast + 240.0.0.0/4 Reserved/Broadcast
  return false;
}

/**
 * Parses an IPv6 address (with optional `::` compression and optional trailing IPv4 dotted-quad)
 * into 8 16-bit words, or returns null if invalid.
 */
export function parseIpv6Words(raw: string): Uint16Array | null {
  const cleaned = raw.replace(/^\[|\]$/g, "").toLowerCase();
  // Reject zone indices (e.g. fe80::1%eth0) as invalid/unsafe
  if (cleaned.includes("%")) return null;

  let addr = cleaned;
  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1) into two hex words
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4Octets = parseIpv4Octets(addr.slice(lastColon + 1));
    if (!v4Octets) return null;
    const hi = ((v4Octets[0] << 8) | v4Octets[1]).toString(16);
    const lo = ((v4Octets[2] << 8) | v4Octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (part: string): number[] | null => {
    if (part === "") return [];
    const segs = part.split(":");
    const out: number[] = [];
    for (const s of segs) {
      if (!/^[\da-f]{1,4}$/.test(s)) return null;
      out.push(parseInt(s, 16));
    }
    return out;
  };

  const words = new Uint16Array(8);
  if (doubleColonParts.length === 2) {
    const left = parseSegmentList(doubleColonParts[0]);
    const right = parseSegmentList(doubleColonParts[1]);
    if (!left || !right) return null;
    if (left.length + right.length >= 8) return null;
    for (let i = 0; i < left.length; i++) words[i] = left[i];
    const rightStart = 8 - right.length;
    for (let i = 0; i < right.length; i++) words[rightStart + i] = right[i];
  } else {
    const all = parseSegmentList(addr);
    if (!all || all.length !== 8) return null;
    for (let i = 0; i < 8; i++) words[i] = all[i];
  }

  return words;
}

/**
 * Checks if an IPv6 address (parsed into 8 16-bit words) is in any non-global range,
 * including loopback, unspecified, ULA, link-local, multicast, IPv4-mapped, NAT64, 6to4, or Teredo.
 */
export function isPrivateOrReservedIpv6Words(w: Uint16Array): boolean {
  const isAllZeroPrefix6 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;

  // Unspecified (::/128) or Loopback (::1/128)
  if (isAllZeroPrefix6 && w[5] === 0 && w[6] === 0 && (w[7] === 0 || w[7] === 1)) {
    return true;
  }

  // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96 with non-zero v4)
  if (isAllZeroPrefix6 && (w[5] === 0xffff || w[5] === 0)) {
    const octets: [number, number, number, number] = [
      (w[6] >> 8) & 0xff,
      w[6] & 0xff,
      (w[7] >> 8) & 0xff,
      w[7] & 0xff,
    ];
    return isPrivateOrReservedIpv4Octets(octets);
  }

  // IPv4-translated (::ffff:0:0:0/96 -> 0:0:0:0:ffff:0:w6:w7)
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) {
    const octets: [number, number, number, number] = [
      (w[6] >> 8) & 0xff,
      w[6] & 0xff,
      (w[7] >> 8) & 0xff,
      w[7] & 0xff,
    ];
    return isPrivateOrReservedIpv4Octets(octets);
  }

  // NAT64 well-known prefix (64:ff9b::/96 and 64:ff9b:1::/48)
  if (w[0] === 0x0064 && w[1] === 0xff9b) {
    return true;
  }

  // 6to4 (2002::/16) — embeds an IPv4 address in w[1] and w[2]
  if (w[0] === 0x2002) {
    const octets: [number, number, number, number] = [
      (w[1] >> 8) & 0xff,
      w[1] & 0xff,
      (w[2] >> 8) & 0xff,
      w[2] & 0xff,
    ];
    return isPrivateOrReservedIpv4Octets(octets);
  }

  // Teredo (2001:0000::/32), Benchmarking (2001:0002::/48), Orchid (2001:10::/28, 2001:20::/28), Documentation (2001:db8::/32)
  if (w[0] === 0x2001) {
    if (w[1] === 0x0000) return true; // Teredo
    if (w[1] === 0x0002 && w[2] === 0x0000) return true; // Benchmarking
    if ((w[1] & 0xfff0) === 0x0010 || (w[1] & 0xfff0) === 0x0020) return true; // Orchid v1/v2
    if (w[1] === 0x0db8) return true; // Documentation
  }

  // Unique Local (fc00::/7 -> fc00..fdff)
  if ((w[0] & 0xfe00) === 0xfc00) return true;

  // Link-Local (fe80::/10 -> fe80..febf) and deprecated Site-Local (fec0::/10)
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true;

  // Multicast (ff00::/8)
  if ((w[0] & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * Returns true if `ip` (either IPv4 or IPv6 string) is in any private, loopback,
 * link-local, or reserved range, or if it cannot be parsed as a valid IP.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const trimmed = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIpv4Octets(trimmed);
  if (v4) return isPrivateOrReservedIpv4Octets(v4);
  const v6 = parseIpv6Words(trimmed);
  if (v6) return isPrivateOrReservedIpv6Words(v6);
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  if (!hostname) return true;
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return true;
  }
  const tld = hostname.split(".").at(-1) ?? "";
  if (BLOCKED_TLDS.has(tld)) {
    return true;
  }
  for (const domain of REBINDING_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a user-supplied URL against static SSRF targets: IP literals in
 * private/loopback/link-local/RFC-6890 ranges, IPv6 literals, reserved TLDs,
 * known wildcard DNS rebinding domains, and non-HTTP(S) schemes.
 *
 * For pre-flight DNS resolution against DNS rebinding on custom domains, call
 * `assertSafeOutboundUrlWithDns`.
 */
export function assertSafeOutboundUrl(raw: string): SafeUrlOk | SafeUrlErr {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http/https URLs are allowed" };
  }

  if (url.username || url.password) {
    return { ok: false, error: "URL credentials are not allowed" };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!hostname) {
    return { ok: false, error: "Invalid URL hostname" };
  }

  // Block IPv6 literals by presence of colons (catches [::1], [::ffff:127.0.0.1], etc.)
  const withoutBrackets = hostname.replace(/^\[|\]$/g, "");
  if (withoutBrackets.includes(":")) {
    return { ok: false, error: "IPv6 literals are not allowed" };
  }

  // Check IPv4 literals (WHATWG URL normalizes decimal/hex/octal IPs to dotted-quad)
  const v4 = parseIpv4Octets(hostname);
  if (v4) {
    if (isPrivateOrReservedIpv4Octets(v4)) {
      return { ok: false, error: "URL targets a private or link-local IP address" };
    }
    return { ok: true, url };
  }

  if (isBlockedHostname(hostname)) {
    return { ok: false, error: "URL targets a reserved/private host" };
  }

  return { ok: true, url };
}

interface DohAnswer {
  name?: string;
  type: number;
  TTL?: number;
  data: string;
}

interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

const MAX_DNS_CACHE_ENTRIES = 256;
const MAX_DNS_CACHE_TTL_MS = 60_000;
const dnsCache = new Map<string, { resolvedIps: string[]; expiresAt: number }>();

/**
 * Validates an outbound URL with both static checks (`assertSafeOutboundUrl`)
 * and live DNS-over-HTTPS (`A` + `AAAA`) resolution via Cloudflare 1.1.1.1 to
 * block DNS rebinding attacks (domains resolving to private/loopback/metadata IPs
 * or returning ultra-low TTL records).
 *
 * Verified public resolutions are cached in-memory up to the minimum observed
 * record TTL (capped at 60s) so webhook bursts / retry sweeps stay well within
 * Cloudflare Workers' 50-subrequest invocation budget.
 */
export async function assertSafeOutboundUrlWithDns(
  raw: string,
  options: SafeUrlDnsOptions = {},
): Promise<SafeUrlOk | SafeUrlErr> {
  const base = assertSafeOutboundUrl(raw);
  if (!base.ok) return base;

  const hostname = base.url.hostname.toLowerCase().replace(/\.+$/, "");
  // If the hostname is already a verified public IPv4 literal, no DNS lookup is required.
  if (parseIpv4Octets(hostname)) {
    return { ok: true, url: base.url, resolvedIps: [hostname] };
  }

  const dnsFetch = options.dnsFetch ?? fetch;
  const minTtlSeconds = options.minTtlSeconds ?? 5;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const useCache = !options.dnsFetch && minTtlSeconds === 5;

  if (useCache) {
    const cached = dnsCache.get(hostname);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return { ok: true, url: base.url, resolvedIps: cached.resolvedIps };
      }
      dnsCache.delete(hostname);
    }
  }

  const queryType = async (type: "A" | "AAAA"): Promise<DohResponse> => {
    const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    const res = await dnsFetch(endpoint, {
      headers: { Accept: "application/dns-json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`DoH HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    return json && typeof json === "object" ? json : {};
  };

  let aResp: DohResponse;
  let aaaaResp: DohResponse;
  try {
    [aResp, aaaaResp] = await Promise.all([queryType("A"), queryType("AAAA")]);
  } catch {
    return { ok: false, error: "Failed to verify hostname DNS records" };
  }

  const answers = [...(aResp.Answer ?? []), ...(aaaaResp.Answer ?? [])];
  const resolvedIps: string[] = [];
  let minObservedTtl = 60;

  for (const ans of answers) {
    const data = ans.data.trim().replace(/\.+$/, "").toLowerCase();
    // CNAME record (type 5): ensure the canonical target is not a blocked internal/rebinding host
    if (ans.type === 5) {
      if (isBlockedHostname(data)) {
        return { ok: false, error: "URL CNAME targets a reserved/private host" };
      }
      continue;
    }

    // A (type 1) or AAAA (type 28)
    if (ans.type === 1 || ans.type === 28) {
      if (ans.type === 1 && !parseIpv4Octets(data)) {
        return { ok: false, error: "Malformed DNS A record" };
      }
      if (ans.type === 28 && !parseIpv6Words(data)) {
        return { ok: false, error: "Malformed DNS AAAA record" };
      }
      if (isPrivateOrReservedIp(data)) {
        return { ok: false, error: "URL hostname resolves to a private or reserved IP address" };
      }
      if (typeof ans.TTL === "number") {
        if (ans.TTL < minTtlSeconds) {
          return {
            ok: false,
            error: `URL hostname has a suspiciously low DNS TTL (${ans.TTL}s < ${minTtlSeconds}s; potential DNS rebinding)`,
          };
        }
        if (ans.TTL < minObservedTtl) {
          minObservedTtl = ans.TTL;
        }
      }
      resolvedIps.push(data);
    }
  }

  if (resolvedIps.length === 0) {
    return { ok: false, error: "URL hostname did not resolve to any public IP address" };
  }

  if (useCache) {
    if (dnsCache.size >= MAX_DNS_CACHE_ENTRIES) {
      const oldestKey = dnsCache.keys().next().value;
      if (oldestKey !== undefined) dnsCache.delete(oldestKey);
    }
    const ttlMs = Math.min(Math.max(minObservedTtl * 1000, minTtlSeconds * 1000), MAX_DNS_CACHE_TTL_MS);
    dnsCache.set(hostname, { resolvedIps, expiresAt: Date.now() + ttlMs });
  }

  return { ok: true, url: base.url, resolvedIps };
}
