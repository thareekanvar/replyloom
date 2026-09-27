/**
 * Best-effort phone number "purification" for WhatsApp sending.
 *
 * We deliberately avoid pulling in a full E.164 library (libphonenumber-js
 * etc.) rather than adding a new dependency for one helper. WhatsApp's own
 * JID format only needs "the digits a WhatsApp client would dial" — not
 * full E.164 validation — so this strips everything that isn't a digit,
 * folds a leading international "00" or "+" the same way, and rejects
 * anything that's clearly not a real, sendable number (too short, too
 * long, all zeros).
 */

export interface NormalizedPhone {
  /** Bare digits, no "+", no punctuation — this is what WhatsApp JIDs use. */
  digits: string
  /** Digits prefixed with "+", for display. */
  e164: string
  /** `${digits}@s.whatsapp.net` — the direct-message JID Baileys expects. */
  jid: string
}

export interface PhoneNormalizationError {
  ok: false
  raw: string
  reason: string
}

export type PhoneNormalizationResult = ({ ok: true } & NormalizedPhone) | PhoneNormalizationError

const MIN_DIGITS = 8
const MAX_DIGITS = 15

/**
 * Normalize a raw, human-entered phone number into WhatsApp-sendable digits.
 *
 * @param raw the raw string, e.g. "+1 (234) 567-8901", "0044 7700 900123"
 * @param defaultCountryCallingCode digits-only country calling code (e.g. "1", "44")
 *   to prepend when a number has no country code and no leading "+"/"00".
 *   Pass undefined to require an explicit country code on every number.
 */
export function normalizePhoneNumber(
  raw: string | null | undefined,
  defaultCountryCallingCode?: string
): PhoneNormalizationResult {
  // Widened on purpose: callers hand us CSV/UI input whose shape is only
  // "string-ish" at the type level.
  const value = raw ?? ""
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, raw: value, reason: "Empty" }

  let hasCountryCode = trimmed.startsWith("+")
  let digits = trimmed.replace(/[^\d]/g, "")

  // "00" international-dialing prefix (common outside North America).
  if (!hasCountryCode && digits.startsWith("00")) {
    digits = digits.slice(2)
    hasCountryCode = true
  }

  if (!digits) return { ok: false, raw: value, reason: "No digits found" }

  if (!hasCountryCode && defaultCountryCallingCode) {
    const cc = defaultCountryCallingCode.replace(/\D/g, "")
    // Only treat it as a local number if it doesn't already look like it
    // has enough digits to include a country code itself.
    if (digits.length <= 10) {
      digits = cc + digits.replace(/^0+/, "")
      hasCountryCode = true
    }
  }

  // A stray leading trunk "0" pasted right after (or instead of) a country
  // code — strip it if the number is implausibly long without it.
  if (digits.length > MAX_DIGITS && digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "")
  }

  if (digits.length < MIN_DIGITS) return { ok: false, raw: value, reason: "Too short to be a real phone number" }
  if (digits.length > MAX_DIGITS) return { ok: false, raw: value, reason: "Too long to be a real phone number" }
  if (/^0+$/.test(digits)) return { ok: false, raw: value, reason: "All zeros" }

  return {
    ok: true,
    digits,
    e164: `+${digits}`,
    jid: `${digits}@s.whatsapp.net`,
  }
}

/** Convenience for call sites that just want the clean digits or null. */
export function purifyPhoneNumber(raw: string | null | undefined, defaultCountryCallingCode?: string): string | null {
  const result = normalizePhoneNumber(raw, defaultCountryCallingCode)
  return result.ok ? result.digits : null
}
