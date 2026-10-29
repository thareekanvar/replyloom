import { describe, it, expect } from "vitest";
import {
  assertSafeOutboundUrl,
  assertSafeOutboundUrlWithDns,
  isPrivateOrReservedIp,
} from "../security";

describe("assertSafeOutboundUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    const result = assertSafeOutboundUrl("https://api.example.com/webhook");
    expect(result.ok).toBe(true);
  });

  it("accepts valid HTTP URLs", () => {
    const result = assertSafeOutboundUrl("http://example.com/api");
    expect(result.ok).toBe(true);
  });

  it("rejects non-HTTP schemes", () => {
    expect(assertSafeOutboundUrl("ftp://example.com").ok).toBe(false);
    expect(assertSafeOutboundUrl("file:///etc/passwd").ok).toBe(false);
    expect(assertSafeOutboundUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("rejects embedded URL credentials", () => {
    expect(assertSafeOutboundUrl("https://user:pass@example.com/webhook").ok).toBe(false);
  });

  it("rejects localhost and cloud metadata hostnames", () => {
    const result = assertSafeOutboundUrl("https://localhost/api");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("reserved/private");
    expect(assertSafeOutboundUrl("https://sub.localhost/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("http://metadata.google.internal/computeMetadata/v1/").ok).toBe(false);
    expect(assertSafeOutboundUrl("http://metadata/computeMetadata/v1/").ok).toBe(false);
  });

  it("rejects private and RFC 6890 special-purpose IPv4 addresses", () => {
    expect(assertSafeOutboundUrl("https://10.0.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://172.16.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://192.168.1.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://192.0.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://192.0.2.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://198.18.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://198.51.100.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://203.0.113.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://224.0.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://255.255.255.255/admin").ok).toBe(false);
  });

  it("rejects loopback addresses", () => {
    expect(assertSafeOutboundUrl("https://127.0.0.1/admin").ok).toBe(false);
  });

  it("rejects link-local addresses", () => {
    expect(assertSafeOutboundUrl("https://169.254.169.254/metadata").ok).toBe(false);
  });

  it("rejects IPv6 literals", () => {
    expect(assertSafeOutboundUrl("https://[::1]/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://[::ffff:127.0.0.1]/admin").ok).toBe(false);
  });

  it("rejects reserved TLDs and wildcard DNS rebinding domains", () => {
    expect(assertSafeOutboundUrl("https://myapp.local/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://service.internal/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://host.corp/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://127.0.0.1.nip.io/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://169.254.169.254.sslip.io/latest/meta-data").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://7f000001.c0a80101.rbndr.us/hook").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://sub.localtest.me/hook").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://sub.lvh.me/hook").ok).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(assertSafeOutboundUrl("not-a-url").ok).toBe(false);
    expect(assertSafeOutboundUrl("").ok).toBe(false);
  });

  it("normalizes trailing dots in hostname", () => {
    const result = assertSafeOutboundUrl("https://example.com./api");
    expect(result.ok).toBe(true);
    expect(assertSafeOutboundUrl("https://localhost./api").ok).toBe(false);
  });
});

describe("isPrivateOrReservedIp (IPv4 & 128-bit IPv6)", () => {
  it("identifies private/reserved IPv6 addresses including IPv4-mapped, NAT64, 6to4, and Teredo", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("::")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456:789a::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
    expect(isPrivateOrReservedIp("ff02::1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIp("64:ff9b::127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("2002:7f00:0001::1")).toBe(true); // 6to4 wrapping 127.0.0.1
    expect(isPrivateOrReservedIp("2001:db8::1")).toBe(true); // documentation
    expect(isPrivateOrReservedIp("2001:0000:4136:e378:8000:63bf:3fff:fdd2")).toBe(true); // Teredo
  });

  it("allows global unicast IPv4 and IPv6 addresses", () => {
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrReservedIp("::ffff:93.184.216.34")).toBe(false);
  });
});

describe("assertSafeOutboundUrlWithDns (DoH DNS rebinding defense)", () => {
  function mockDohFetch(recordsByType: { A?: { type: number; TTL?: number; data: string }[]; AAAA?: { type: number; TTL?: number; data: string }[] }): typeof fetch {
    return async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const type = url.searchParams.get("type") as "A" | "AAAA";
      const Answer = recordsByType[type] ?? [];
      return new Response(JSON.stringify({ Status: 0, Answer }), {
        status: 200,
        headers: { "Content-Type": "application/dns-json" },
      });
    };
  }

  it("allows a hostname that resolves to public A/AAAA records with healthy TTL", async () => {
    const res = await assertSafeOutboundUrlWithDns("https://hooks.example.org/notify", {
      dnsFetch: mockDohFetch({
        A: [{ type: 1, TTL: 300, data: "93.184.216.34" }],
        AAAA: [{ type: 28, TTL: 300, data: "2606:2800:220:1:248:1893:25c8:1946" }],
      }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.resolvedIps).toEqual([
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]);
    }
  });

  it("blocks a hostname whose A record resolves to a private or metadata IP", async () => {
    const loop = await assertSafeOutboundUrlWithDns("https://rebind.attacker.example/hook", {
      dnsFetch: mockDohFetch({
        A: [{ type: 1, TTL: 60, data: "127.0.0.1" }],
      }),
    });
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.error).toContain("private or reserved IP");

    const imds = await assertSafeOutboundUrlWithDns("https://imds.attacker.example/hook", {
      dnsFetch: mockDohFetch({
        A: [{ type: 1, TTL: 60, data: "169.254.169.254" }],
      }),
    });
    expect(imds.ok).toBe(false);
  });

  it("blocks a hostname whose AAAA record resolves to IPv6 loopback or IPv4-mapped loopback", async () => {
    const v6Loop = await assertSafeOutboundUrlWithDns("https://v6.attacker.example/hook", {
      dnsFetch: mockDohFetch({
        AAAA: [{ type: 28, TTL: 60, data: "::ffff:127.0.0.1" }],
      }),
    });
    expect(v6Loop.ok).toBe(false);
    if (!v6Loop.ok) expect(v6Loop.error).toContain("private or reserved IP");
  });

  it("blocks dual-record round-robin DNS rebinding (one public IP + one private IP)", async () => {
    const dual = await assertSafeOutboundUrlWithDns("https://dual.attacker.example/hook", {
      dnsFetch: mockDohFetch({
        A: [
          { type: 1, TTL: 300, data: "93.184.216.34" },
          { type: 1, TTL: 300, data: "10.0.0.42" },
        ],
      }),
    });
    expect(dual.ok).toBe(false);
  });

  it("blocks ultra-low TTL records indicative of automated DNS rebinding", async () => {
    const lowTtl = await assertSafeOutboundUrlWithDns("https://ttl0.attacker.example/hook", {
      dnsFetch: mockDohFetch({
        A: [{ type: 1, TTL: 1, data: "93.184.216.34" }],
      }),
    });
    expect(lowTtl.ok).toBe(false);
    if (!lowTtl.ok) expect(lowTtl.error).toContain("low DNS TTL");
  });

  it("blocks CNAME chains targeting internal/rebinding hosts", async () => {
    const cname = await assertSafeOutboundUrlWithDns("https://alias.attacker.example/hook", {
      dnsFetch: mockDohFetch({
        A: [
          { type: 5, TTL: 300, data: "internal.service.local." },
          { type: 1, TTL: 300, data: "93.184.216.34" },
        ],
      }),
    });
    expect(cname.ok).toBe(false);
    if (!cname.ok) expect(cname.error).toContain("CNAME");
  });

  it("blocks unresolvable hostnames (NXDOMAIN / empty Answer)", async () => {
    const nx = await assertSafeOutboundUrlWithDns("https://nonexistent.example.org/hook", {
      dnsFetch: mockDohFetch({}),
    });
    expect(nx.ok).toBe(false);
    if (!nx.ok) expect(nx.retryable).toBe(true);
  });

  it("marks a failed DoH lookup as retryable, not unsafe", async () => {
    const down = await assertSafeOutboundUrlWithDns("https://hooks.example.org/notify", {
      dnsFetch: async () => new Response("unavailable", { status: 503 }),
    });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.retryable).toBe(true);
  });

  it("does not mark a private-IP result as retryable", async () => {
    const res = await assertSafeOutboundUrlWithDns("https://rebind.attacker.example/hook", {
      dnsFetch: mockDohFetch({ A: [{ type: 1, TTL: 60, data: "10.0.0.1" }] }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.retryable).toBeUndefined();
  });
});
