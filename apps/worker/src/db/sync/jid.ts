// LID <-> phone-number JID resolution.
//
// WhatsApp (via Baileys) can address the same contact under two different
// JID forms -- the real phone JID (`<number>@s.whatsapp.net`) and an
// opaque `@lid` -- depending on which event delivered it and whether the
// lid<->phone mapping had already been learned yet. These helpers resolve
// a `@lid` back to the phone JID wherever we have enough information to.
import {  eq, and, inArray, contacts } from "@workspace/db";
import type {Db} from "@workspace/db";

/** Check if a JID is in @lid format (WhatsApp Linked ID) */
export function isLidJid(jid: string | undefined | null): boolean {
  if (!jid) return false;
  return jid.endsWith("@lid");
}

/**
 * Resolve a LID JID to phone-number JID (@s.whatsapp.net).
 * Strategy (same as WA-AKG):
 *   1. Check contacts table for a matching lid -> jid mapping
 *   2. Check contacts table where jid matches the lid (stored as primary jid)
 *   3. Use remoteJidAlt from message key if available
 *   4. Return original JID as fallback
 */
export async function resolveToPhoneJid(
  db: Db,
  waSessionId: string,
  jid: string,
  inlineAlt?: string | null
): Promise<string> {
  // NOTE: lookups 2 and 3 below used to filter only on `lid`/`jid` with no
  // `waSessionId` in the WHERE clause at all, even though it's right here
  // as a parameter. `contacts` only has composite indexes that lead with
  // waSessionId (contacts_session_lid_idx / contacts_session_jid_idx), so
  // an unscoped eq() on lid/jid alone can't use either as a prefix and
  // forces a full scan of the ENTIRE contacts table -- across every
  // workspace in this shared D1 database, not just this session's. This
  // function runs on essentially every inbound/outbound message and every
  // group-participant resolution, so a single freshly-connected session
  // processing its recent history (lots of @lid-addressed messages, per
  // the LID/phone-JID duality documented in findOrCreateContact) could
  // trigger hundreds of these full-table scans back to back -- almost
  // certainly the single largest driver of D1 rows_read in this codebase.
  if (!jid || !isLidJid(jid)) return jid;

  // 1. Use inline remoteJidAlt if provided
  if (inlineAlt && !isLidJid(inlineAlt)) return inlineAlt;

  // 2. Look up by lid column
  const byLid = await db
    .select({ jid: contacts.jid, phoneNumber: contacts.phoneNumber })
    .from(contacts)
    .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.lid, jid)))
    .get();

  if (byLid) {
    if (byLid.jid && !isLidJid(byLid.jid)) return byLid.jid;
    if (byLid.phoneNumber) return `${byLid.phoneNumber}@s.whatsapp.net`;
  }

  // 3. Look up by jid column (contact may have been stored with lid as primary jid)
  const byJid = await db
    .select({
      jid: contacts.jid,
      lid: contacts.lid,
      phoneNumber: contacts.phoneNumber,
    })
    .from(contacts)
    .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.jid, jid)))
    .get();

  if (byJid) {
    if (byJid.lid && !isLidJid(byJid.lid) && byJid.lid !== jid) return byJid.lid;
    if (byJid.phoneNumber) return `${byJid.phoneNumber}@s.whatsapp.net`;
  }

  // 4. Fallback: return original
  return jid;
}

/**
 * Batch-resolve multiple LID JIDs to phone JIDs in one DB query.
 * Returns a Map<originalJid, resolvedJid>.
 */
export async function batchResolveToPhoneJid(
  db: Db,
  waSessionId: string,
  jids: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const lids = jids.filter((j) => isLidJid(j));

  // Non-LIDs pass through unchanged
  jids.filter((j) => !isLidJid(j)).forEach((j) => result.set(j, j));

  if (lids.length === 0) return result;

  // Single batch query for all LIDs
  const rows = await db
    .select({
      lid: contacts.lid,
      jid: contacts.jid,
      phoneNumber: contacts.phoneNumber,
    })
    .from(contacts)
    .where(and(eq(contacts.waSessionId, waSessionId), inArray(contacts.lid, lids)));

  // Build lookup: lid -> phone JID
  const lidToPhone = new Map<string, string>();
  for (const row of rows) {
    if (row.lid && row.jid && !isLidJid(row.jid)) {
      lidToPhone.set(row.lid, row.jid);
    } else if (row.lid && row.phoneNumber) {
      lidToPhone.set(row.lid, `${row.phoneNumber}@s.whatsapp.net`);
    }
  }

  for (const lid of lids) {
    result.set(lid, lidToPhone.get(lid) ?? lid);
  }

  return result;
}

/**
 * Extract phone number from a Baileys contact object.
 * Baileys Contact.phoneNumber is the PN JID (e.g. "19999999999@s.whatsapp.net").
 */
export function extractPhoneNumber(contact: any): string | null {
  // Baileys Contact.phoneNumber is the PN JID — extract the numeric part
  if (contact.phoneNumber) {
    const match = String(contact.phoneNumber).match(/^(\d+)/);
    if (match) return match[1];
  }
  // If id is a phone JID (not LID), extract the number
  if (contact.id && !isLidJid(contact.id)) {
    const match = contact.id.match(/^(\d+):?\d*@/);
    if (match) return match[1];
  }
  return null;
}
