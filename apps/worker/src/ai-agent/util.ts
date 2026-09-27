/**
 * Bare digits from a WhatsApp JID (e.g. "19999999999@s.whatsapp.net" -> "19999999999").
 * Group JIDs and LID JIDs return null — callers then just have no phone to scope on.
 */
export function customerPhoneFromJid(jid?: string): string | null {
  if (!jid) return null;
  if (jid.includes("@g.us") || jid.includes("@lid") || jid.includes("@newsletter")) return null;
  const match = jid.match(/^(\d+)/);
  return match ? match[1] : null;
}