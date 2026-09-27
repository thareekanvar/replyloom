/** SSRF guard for user-supplied outbound URLs (webhooks, agent tools). */
type SafeUrlOk = { ok: true; url: URL };
type SafeUrlErr = { ok: false; error: string };

const PRIVATE_IP_RE =
  /^(0\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|::1|fc[\da-f]{2}:|fd[\da-f]{2}:)$/i;

const BLOCKED_TLDS = new Set(["local", "localhost", "internal", "corp", "home", "intranet"]);

/**
 * Validates a user-supplied URL against SSRF targets: IP literals in
 * private/loopback/link-local ranges, reserved TLDs, and non-HTTP(S)
 * schemes. Returns the parsed URL on success so callers can use it
 * normalised, or an error string on failure.
 *
 * Note: hostname→IP resolution is not possible in a Cloudflare Worker, so a
 * hostname that resolves to a private IP is a known residual risk.
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

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  // Block bare "localhost"
  if (hostname === "localhost") {
    return { ok: false, error: "URL targets a reserved/private host" };
  }

  // Block private IP literals (IPv4 + limited IPv6)
  if (PRIVATE_IP_RE.test(hostname)) {
    return { ok: false, error: "URL targets a private or link-local IP address" };
  }

  // Block IPv6 literals by presence of colons (catches [::1] etc.)
  const withoutBrackets = hostname.replace(/^\[|\]$/g, "");
  if (withoutBrackets.includes(":")) {
    return { ok: false, error: "IPv6 literals are not allowed" };
  }

  // Block reserved TLDs
  const tld = hostname.split(".").at(-1) ?? "";
  if (BLOCKED_TLDS.has(tld)) {
    return { ok: false, error: "URL targets a reserved/private host" };
  }

  return { ok: true, url };
}
