import { describe, expect, it } from "vitest";
import { applySafeMediaHeaders, isAllowedUploadMime, isInlineSafeMime, assertSafeOutboundUrl } from "@workspace/db";
import { scrubSentryEvent } from "@workspace/db/sentry-scrub";

describe("media safety", () => {
  it("allowlists uploads", () => {
    expect(isAllowedUploadMime("image/png")).toBe(true);
    expect(isAllowedUploadMime("application/pdf")).toBe(true);
    expect(isAllowedUploadMime("text/html")).toBe(false);
    expect(isAllowedUploadMime("image/svg+xml")).toBe(false);
    expect(isAllowedUploadMime("application/javascript")).toBe(false);
    expect(isAllowedUploadMime("")).toBe(false);
  });

  it("forces active content to download, sandboxed + nosniff", () => {
    const h = applySafeMediaHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8" }));
    expect(h.get("Content-Type")).toBe("application/octet-stream");
    expect(h.get("Content-Disposition")).toBe("attachment");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Content-Security-Policy")).toContain("sandbox");
    expect(isInlineSafeMime("image/svg+xml")).toBe(false);
  });

  it("keeps images/audio/video inline", () => {
    const h = applySafeMediaHeaders(new Headers({ "Content-Type": "image/jpeg" }));
    expect(h.get("Content-Type")).toBe("image/jpeg");
    expect(h.get("Content-Disposition")).toBeNull();
    expect(isInlineSafeMime("audio/ogg; codecs=opus")).toBe(true);
  });
});

describe("SSRF guard extras", () => {
  it("blocks CGNAT and 0.0.0.0/8", () => {
    expect(assertSafeOutboundUrl("https://100.64.0.1/x").ok).toBe(false);
    expect(assertSafeOutboundUrl("https://0.0.0.0/x").ok).toBe(false);
    expect(assertSafeOutboundUrl("http://2130706433/").ok).toBe(false); // 127.0.0.1 in decimal
    expect(assertSafeOutboundUrl("https://100.200.0.1/x").ok).toBe(true);
  });
});

describe("sentry scrubbing", () => {
  it("drops cookies/auth and masks phones + emails", () => {
    const ev = scrubSentryEvent({
      request: { cookies: { a: "b" }, data: "body", headers: { authorization: "Bearer x", "user-agent": "ua" } },
      user: { id: "u1", email: "a@b.com", ip_address: "1.2.3.4" },
      message: "failed sending to +971 50 123 4567 for a@b.com",
      extra: { text: "hello", count: 3 },
    });
    expect(ev.request.cookies).toBeUndefined();
    expect(ev.request.data).toBeUndefined();
    expect(ev.request.headers.authorization).toBe("[redacted]");
    expect(ev.user).toEqual({ id: "u1" });
    expect(ev.message).not.toContain("4567");
    expect(ev.message).not.toContain("a@b.com");
    expect(ev.extra.text).toBe("[redacted]");
  });
});
