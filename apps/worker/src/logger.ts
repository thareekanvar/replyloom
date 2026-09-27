// Structured logger for the worker. Wraps pino with a JSON transport
// suitable for Cloudflare Workers log drain or any structured log consumer.
import pino from "pino";

let _logger: pino.Logger | null = null;

/**
 * Returns a singleton structured logger. On Cloudflare Workers, pino's
 * default transport writes JSON to stdout, which Cloudflare's log drain
 * picks up. In local dev, pino-pretty is used if available.
 */
export function getLogger(): pino.Logger {
  if (_logger) return _logger;

  _logger = pino({
    level: "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  });

  return _logger;
}

/**
 * Create a child logger with a module tag. Usage:
 *   const log = scopedLogger("broadcast");
 *   log.info({ campaignId }, "starting campaign");
 */
export function scopedLogger(name: string): pino.Logger {
  return getLogger().child({ module: name });
}
