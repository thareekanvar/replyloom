import { describe, it, expect } from "vitest";
import { assertSafeOutboundUrl } from "../security";

describe("assertSafeOutboundUrl", () => {
  it("accepts valid HTTPS URLs", () => {
    const result = assertSafeOutboundUrl("https://api.example.com/webhook");
    expect(result.ok).toBe(true);
  });

  it("accepts valid HTTP URLs", () => {
    const result = assertSafeOutboundUrl("http://example.com/api");
    // HTTP is allowed scheme, but check it passes
    expect(result.ok).toBe(true);
  });

  it("rejects non-HTTP schemes", () => {
    expect(assertSafeOutboundUrl("ftp://example.com").ok).toBe(false);
    expect(assertSafeOutboundUrl("file:///etc/passwd").ok).toBe(false);
    expect(assertSafeOutboundUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("rejects localhost", () => {
    const result = assertSafeOutboundUrl("https://localhost/api");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("reserved/private");
  });

  it("rejects private IPv4 addresses", () => {
    expect(assertSafeOutboundUrl("https://10.0.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://172.16.0.1/admin").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://192.168.1.1/admin").ok).toBe(false);
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

  it("rejects reserved TLDs", () => {
    expect(assertSafeOutboundUrl("https://myapp.local/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://service.internal/api").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://host.corp/api").ok).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(assertSafeOutboundUrl("not-a-url").ok).toBe(false);
    expect(assertSafeOutboundUrl("").ok).toBe(false);
  });

  it("normalizes trailing dots in hostname", () => {
    const result = assertSafeOutboundUrl("https://example.com./api");
    expect(result.ok).toBe(true);
  });
});
