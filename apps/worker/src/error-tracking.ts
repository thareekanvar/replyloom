// Error tracking via Sentry + pino.
//
// The Worker export in index.ts is wrapped with Sentry.withSentry(), so
// unhandled errors in fetch/queue/scheduled are captured automatically.
// captureError() below is the explicit hook for catch blocks where the
// error is handled (a JSON 500 is returned) and would otherwise never
// reach the SDK — call it alongside (or instead of) a plain pino log so
// the error is both logged locally and reported to Sentry with context.
//
// DSN: hardcoded to match apps/web (Sentry DSNs are public — they only
// allow event ingestion, and this same value already ships in the web
// client bundle via router.tsx).

import * as Sentry from "@sentry/cloudflare";
import { scopedLogger } from "./logger";

const log = scopedLogger("error-tracking");

export interface ErrorContext {
  /** Which module/handler caught the error */
  module?: string;
  /** Workspace id, if known at the catch site */
  workspaceId?: string;
  /** WhatsApp session id, if relevant */
  waSessionId?: string;
  /** Any extra structured data for debugging */
  extra?: Record<string, unknown>;
}

/**
 * Report an error to pino (local logs) and Sentry (aggregation/alerting).
 *
 * Call this in `catch` blocks so the error is both logged locally *and*
 * sent to Sentry — unhandled throws are already captured by the
 * Sentry.withSentry() wrapper on the Worker export; this is for errors
 * that are caught and converted to a response.
 */
export function captureError(err: unknown, ctx: ErrorContext = {}) {
  const error = err instanceof Error ? err : new Error(String(err));

  log.error(
    {
      err: error,
      module: ctx.module,
      workspaceId: ctx.workspaceId,
      waSessionId: ctx.waSessionId,
      ...ctx.extra,
    },
    error.message,
  );

  Sentry.withScope((scope) => {
    if (ctx.module) scope.setTag("module", ctx.module);
    if (ctx.workspaceId) scope.setExtra("workspaceId", ctx.workspaceId);
    if (ctx.waSessionId) scope.setExtra("waSessionId", ctx.waSessionId);
    if (ctx.extra) scope.setExtras(ctx.extra);
    Sentry.captureException(error);
  });
}
