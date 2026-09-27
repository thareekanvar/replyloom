import * as Sentry from "@sentry/cloudflare";
import handler from "@tanstack/react-start/server-entry";
import { scrubSentryEvent } from "@workspace/db/sentry-scrub";

type AppEnv = Env & {
  WEB_RATE_LIMITER?: RateLimit;
  AUTH_RATE_LIMITER?: RateLimit;
  SENTRY_DSN?: string;
};

// Credential / email-sending endpoints of Better Auth (mounted at /api/auth).
const AUTH_SENSITIVE = /^\/api\/auth\/(sign-in|sign-up|forget-password|request-password-reset|reset-password|send-verification-email|change-password|change-email)/;

/**
 * Enforced on every dynamic response. The full CSP ships as Report-Only
 * first: TanStack Start's hydration needs inline scripts, and an enforced
 * script policy that's even slightly off takes the whole app down. Promote
 * it to enforced once it's been clean in the browser console for a while.
 */
function securityHeaders(env: AppEnv): Record<string, string> {
  const engine = String((env as any).VITE_ENGINE_URL || "").replace(/\/+$/, "");
  const engineWs = engine.replace(/^http/, "ws");
  const connect = ["'self'", engine, engineWs, "https://*.ingest.sentry.io", "https://*.ingest.de.sentry.io", "https://*.ingest.us.sentry.io"].filter(Boolean).join(" ");
  return {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=()",
    // Enforced: the directives that can't break hydration.
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
    "Content-Security-Policy-Report-Only": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: https:`,
      `media-src 'self' blob: ${engine}`.trim(),
      "font-src 'self' data:",
      `connect-src ${connect}`,
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
    ].join("; "),
  };
}

function tooMany(retryAfter = 60) {
  return new Response(JSON.stringify({ error: "Too many requests. Please slow down and try again shortly." }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) },
  });
}

async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false; // binding missing (tests / misconfig) -> fail open
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false; // never let the limiter itself cause an outage
  }
}

const app = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    if (request.method === "POST" && AUTH_SENSITIVE.test(url.pathname)) {
      if (await limited(env.AUTH_RATE_LIMITER, `auth:${ip}`)) return tooMany();
    }
    if (url.pathname.startsWith("/_serverFn") || url.pathname.startsWith("/api/")) {
      if (await limited(env.WEB_RATE_LIMITER, `web:${ip}`)) return tooMany();
    }

    // @ts-expect-error - handler is not typed as a Cloudflare handler
    const response: Response = await handler.fetch(request, env, ctx);
    if (response.status === 101 || response.webSocket) return response;

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(securityHeaders(env))) {
      if (!headers.has(k)) headers.set(k, v);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default Sentry.withSentry(
  (env: AppEnv) => ({
    // Opt-in: `wrangler secret put SENTRY_DSN`. Unset -> Sentry stays disabled.
    dsn: env.SENTRY_DSN,
    // 100% tracing adds a span + upload to every request/queue message;
    // 10% keeps performance visibility at a fraction of the overhead.
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
  }),
  app,
);
