/**
 * Strips credentials and personal data from Sentry events before upload.
 * Message bodies, phone numbers, cookies and auth headers must never leave
 * the Worker via error reports. Framework-agnostic (web server + client).
 */
const SECRET_KEYS = /(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|secret|password|passwd|session|body|text|caption|phone|email)/i;
const PHONE = /\+?\d[\d\s-]{8,}\d/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function scrubString(v: string): string {
  return v.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function scrubSentryEvent<T>(input: T): T {
   
  const event = input as any
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) event.request.headers = scrub(event.request.headers);
    if (typeof event.request.query_string === "string") event.request.query_string = "[redacted]";
  }
  if (event.user) event.user = { id: event.user.id };
  if (event.extra) event.extra = scrub(event.extra);
  if (event.contexts) event.contexts = scrub(event.contexts);
  if (event.message) event.message = scrubString(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === "string") ex.value = scrubString(ex.value);
  }
  for (const b of event.breadcrumbs ?? []) {
    if (typeof b.message === "string") b.message = scrubString(b.message);
    if (b.data) b.data = scrub(b.data);
  }
  return input;
}
