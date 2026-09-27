/**
 * Broadcasts at or above this many eligible recipients require the sender
 * to type the exact recipient count to confirm. Enforced server-side in
 * createCampaign too, so a client can't skip it.
 */
export const TYPE_TO_CONFIRM_THRESHOLD = 25

/** Per-recipient variables that make each broadcast message differ. */
export const PERSONALIZATION_VARIABLES = ["name", "firstName", "phone"] as const

const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/**
 * Identical text blasted to many numbers is one of the clearest spam
 * signatures WhatsApp detects, so every broadcast must reference at least
 * one per-recipient variable. Enforced client- and server-side.
 */
export function isPersonalized(text: string | null | undefined): boolean {
  if (!text) return false
  for (const m of text.matchAll(VARIABLE_RE)) {
    if ((PERSONALIZATION_VARIABLES as readonly string[]).includes(m[1])) return true
  }
  return false
}

export const PERSONALIZATION_REQUIRED_MESSAGE =
  "Personalize the message -- include {{name}}, {{firstName}} or {{phone}} so each recipient gets a different text."

/** Max pending (not yet sent) scheduled 1:1 messages per workspace. */
export const MAX_PENDING_SCHEDULED_PER_WORKSPACE = 25
