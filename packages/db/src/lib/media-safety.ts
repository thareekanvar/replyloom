/**
 * Media served from R2 is attacker-controlled bytes (any WhatsApp contact can
 * send a "document" with mime text/html, and uploads come from the browser).
 * It's proxied on the app origin, so it must never be rendered as active
 * content there. Shared by the engine's GET /media and the web proxy.
 */

/** Types the browser may render inline. Everything else is forced to download. */
const INLINE_SAFE = /^(image\/(jpeg|png|gif|webp|avif|heic|heif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/i;

/** Upload allowlist for the template/media library. */
const UPLOAD_ALLOWED =
  /^(image\/(jpeg|png|gif|webp)|video\/(mp4|3gpp|quicktime|webm)|audio\/(ogg|mpeg|mp4|aac|amr|wav|x-wav|webm|opus)|application\/(pdf|zip|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[\w.-]+)|text\/(plain|csv))$/i;

export function normalizeMime(mime: string | null | undefined): string {
  return (mime ?? "").split(";")[0].trim().toLowerCase();
}

export function isAllowedUploadMime(mime: string | null | undefined): boolean {
  return UPLOAD_ALLOWED.test(normalizeMime(mime));
}

export function isInlineSafeMime(mime: string | null | undefined): boolean {
  return INLINE_SAFE.test(normalizeMime(mime));
}

/** Hardens a media response in place. Call AFTER copying the stored metadata. */
export function applySafeMediaHeaders(headers: Headers): Headers {
  const mime = normalizeMime(headers.get("Content-Type"));
  headers.set("X-Content-Type-Options", "nosniff");
  // Even if something slips through, a sandboxed document has no origin,
  // can't run script and can't read the app's cookies/storage.
  headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (!isInlineSafeMime(mime)) {
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", "attachment");
  }
  return headers;
}
