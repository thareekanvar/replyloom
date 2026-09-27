// Contact upsert/lookup, keyed phone-number-first so the same real person
// never ends up as two different contact rows just because one event
// addressed them by @lid and another by phone JID.
import {
  
  eq,
  and,
  or,
  isNull,
  contacts,
  conversations,
  messages,
  notes,
  contactTags,
  deals,
  groupMembers,
  broadcastRecipients,
  sql
} from "@workspace/db";
import type {Db} from "@workspace/db";
import { isLidJid, extractPhoneNumber } from "./jid";
import { TtlCache } from "../../ttl-cache";

export interface ContactUpsertData {
  jid: string;
  lid?: string | null;
  name?: string | null;
  notify?: string | null;
  phoneNumber?: string | null;
  avatarUrl?: string | null;
  verifiedName?: string | null;
}

/**
 * Upsert a contact with both LID and phone JID mapping.
 * Called from contacts.upsert handler to maintain the mapping table.
 */
export async function upsertContactMapping(db: Db, waSessionId: string, workspaceId: string, data: ContactUpsertData) {
  // Routed through the same phone-number-first resolver used by message
  // sync (see findOrCreateContact below) so a contacts.upsert event and an
  // incoming/outgoing message for the same real person always land on the
  // same contact row, however the JID they carry happens to differ.
  await findOrCreateContact(db, workspaceId, waSessionId, data);
}

/**
 * Finds the contact for this (session, person), preferring — in order —
 * a match by phone number, then by @lid, then by exact jid, and reuses
 * that single row rather than inserting a new one when a match is found
 * under a different jid/lid.
 *
 * Why this exists: WhatsApp (via Baileys) can address the *same* contact
 * under two different JID forms — the real phone JID
 * (`<number>@s.whatsapp.net`) and an opaque `@lid` — depending on which
 * event delivered it and whether the lid<->phone mapping had already been
 * learned yet. Before this resolver, `contacts` (and therefore
 * `conversations`, which is unique per `(waSessionId, contactId)`) was
 * keyed on the exact jid string, so an incoming message that arrived
 * under `@lid` before the mapping was known, and an outgoing message sent
 * to the resolved phone JID, created two separate contact rows — and so
 * two separate conversations — for one person. Phone number is the one
 * identity that's stable across that churn, so it's the primary key here.
 */
export async function findOrCreateContact(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  data: ContactUpsertData
): Promise<{ id: string }> {
  const phoneNumber = data.phoneNumber ?? (isLidJid(data.jid) ? null : extractPhoneNumber({ id: data.jid }));
  const lid = data.lid ?? (isLidJid(data.jid) ? data.jid : null);
  const displayName = data.name || data.notify || undefined;

  // 1. Phone number — the durable identity — wins if we have one.
  let existing = phoneNumber
    ? await db
        .select({ id: contacts.id, jid: contacts.jid, lid: contacts.lid })
        .from(contacts)
        .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.phoneNumber, phoneNumber)))
        .get()
    : undefined;

  // 2. Next best: the @lid this event carries, if we've seen it before.
  if (!existing && lid) {
    existing = await db
      .select({ id: contacts.id, jid: contacts.jid, lid: contacts.lid })
      .from(contacts)
      .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.lid, lid)))
      .get();
  }

  // 3. Fall back to an exact jid match (covers group participants, and
  // the case where we don't yet know a phone number or lid at all).
  if (!existing) {
    existing = await db
      .select({ id: contacts.id, jid: contacts.jid, lid: contacts.lid })
      .from(contacts)
      .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.jid, data.jid)))
      .get();
  }

  // 4. Reverse phone-number lookup: a contact may have been stored with a
  //    LID as its primary JID (before the phone mapping was learned), so
  //    none of the above lookups match. Query the phone-number column
  //    directly, or fall back to a JID LIKE match for the phone JID form.
  if (!existing && phoneNumber) {
    existing = await db
      .select({ id: contacts.id, jid: contacts.jid, lid: contacts.lid })
      .from(contacts)
      .where(
        and(
          eq(contacts.waSessionId, waSessionId),
          or(eq(contacts.phoneNumber, phoneNumber), eq(contacts.jid, `${phoneNumber}@s.whatsapp.net`))
        )
      )
      .get();
  }

  if (existing) {
    const updateData: Record<string, any> = { updatedAt: new Date() };
    // Upgrade a lid-only row to the real phone jid the moment we learn it.
    if (phoneNumber && data.jid !== existing.jid && !isLidJid(data.jid)) {
      updateData.jid = data.jid;
    }
    if (phoneNumber) updateData.phoneNumber = phoneNumber;
    if (lid && !existing.lid) updateData.lid = lid;
    if (displayName) updateData.name = displayName;
    if (data.verifiedName) updateData.verifiedName = data.verifiedName;
    if (data.avatarUrl) updateData.avatarUrl = data.avatarUrl;
    await db.update(contacts).set(updateData).where(eq(contacts.id, existing.id));
    return { id: existing.id };
  }

  const inserted = await db
    .insert(contacts)
    .values({
      workspaceId,
      waSessionId,
      jid: data.jid,
      lid,
      phoneNumber,
      name: displayName,
      verifiedName: data.verifiedName,
      avatarUrl: data.avatarUrl,
    })
    .onConflictDoNothing()
    .returning({ id: contacts.id })
    .get() as { id: string } | undefined;

  if (inserted) return inserted;

  // Extremely rare race: a concurrent call inserted the same
  // (waSessionId, jid) row between our lookup and our insert above.
  const raced = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.jid, data.jid)))
    .get();
  if (raced) return raced;

  throw new Error(`findOrCreateContact: failed to insert or find contact for jid=${data.jid}`);
}

/**
 * Returns true if the contact for the given JID (or LID) on this session
 * has been blocked. A blocked contact's incoming messages are silently
 * dropped — no conversation is created, no auto-reply fires.
 */
// Checked for every inbound message; a block/unblock takes effect within
// BLOCKED_TTL_MS (the session DO also invalidates on its own block calls).
const BLOCKED_TTL_MS = 30_000;
const blockedCache = new TtlCache<boolean>(BLOCKED_TTL_MS);

export function invalidateBlockedCache(waSessionId: string, jid?: string) {
  if (jid) blockedCache.invalidate(`${waSessionId}|${jid}`);
  else blockedCache.invalidatePrefix(`${waSessionId}|`);
}

export async function isContactBlocked(db: Db, waSessionId: string, jid: string): Promise<boolean> {
  return blockedCache.get(`${waSessionId}|${jid}`, () => loadContactBlocked(db, waSessionId, jid));
}

async function loadContactBlocked(db: Db, waSessionId: string, jid: string): Promise<boolean> {
  // Check by JID first, then by LID (same lookup order as findOrCreateContact).
  const row = await db
    .select({ blocked: contacts.blocked })
    .from(contacts)
    .where(
      and(
        eq(contacts.waSessionId, waSessionId),
        or(eq(contacts.jid, jid), and(isNull(contacts.jid), eq(contacts.lid, jid)))
      )
    )
    .get();
  return row?.blocked === true;
}

/**
 * Folds `dupId` into `keepId`: repoints every foreign key that pointed at
 * the duplicate contact (its direct conversation + that conversation's
 * messages, notes, tags, deals, campaign links, group memberships) onto
 * the keeper, then deletes the now-empty duplicate row.
 *
 * `conversations` is unique per (waSessionId, contactId), so if BOTH
 * contacts already have their own direct conversation, those two threads
 * are merged first (dup's messages moved onto the keeper's conversation)
 * before the dup conversation is dropped -- otherwise the plain UPDATE
 * below would violate that unique index.
 */
async function mergeContacts(db: Db, waSessionId: string, keepId: string, dupId: string): Promise<void> {
  if (keepId === dupId) return;

  const [keepConvo, dupConvo] = await Promise.all([
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.waSessionId, waSessionId), eq(conversations.contactId, keepId)))
      .get(),
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.waSessionId, waSessionId), eq(conversations.contactId, dupId)))
      .get(),
  ]);

  if (dupConvo) {
    if (keepConvo) {
      // Both sides already have a thread for this session -- merge dup's
      // messages onto the keeper's thread. "OR IGNORE" so the extremely
      // unlikely case of two identical wa_message_ids landing in each
      // thread just leaves that one row behind on the (about to be
      // deleted) dup conversation instead of throwing.
      await db.run(
        sql`UPDATE OR IGNORE ${messages} SET conversation_id = ${keepConvo.id} WHERE conversation_id = ${dupConvo.id}`
      );
      // Roll the dup thread's last-message preview forward onto the
      // keeper if it's actually newer, same forward-only guard used
      // elsewhere for lastMessageAt.
      await db.run(sql`
        UPDATE ${conversations} AS keep
        SET
          last_message_at = (SELECT last_message_at FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id}),
          last_body = (SELECT last_body FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id}),
          last_type = (SELECT last_type FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id}),
          last_direction = (SELECT last_direction FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id}),
          unread_count = keep.unread_count + (SELECT unread_count FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id})
        WHERE keep.id = ${keepConvo.id}
          AND (SELECT last_message_at FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id}) IS NOT NULL
          AND (
            keep.last_message_at IS NULL
            OR keep.last_message_at < (SELECT last_message_at FROM ${conversations} AS dup WHERE dup.id = ${dupConvo.id})
          )
      `);
      // Any leftover (conflicting) message rows go with it -- extremely
      // rare edge case, documented rather than silently losing the thread.
      await db.delete(conversations).where(eq(conversations.id, dupConvo.id));
    } else {
      // Keeper has no thread yet -- just hand the dup's thread over.
      await db.update(conversations).set({ contactId: keepId }).where(eq(conversations.id, dupConvo.id));
    }
  }

  // Group memberships: onDelete is "set null", not cascade, but repoint
  // rather than orphan them.
  await db.update(groupMembers).set({ contactId: keepId }).where(eq(groupMembers.contactId, dupId));

  // Notes and deals cascade-delete with their contact -- move them first
  // or they're gone the moment the dup contact row is deleted below.
  await db.update(notes).set({ contactId: keepId }).where(eq(notes.contactId, dupId));
  await db.update(deals).set({ contactId: keepId }).where(eq(deals.contactId, dupId));
  await db.update(broadcastRecipients).set({ contactId: keepId }).where(eq(broadcastRecipients.contactId, dupId));

  // contact_tags has a composite (contactId, tagId) primary key -- drop
  // any tag the keeper already has before repointing the rest, so the
  // move never collides with an existing row.
  await db.run(sql`
    DELETE FROM ${contactTags}
    WHERE contact_id = ${dupId}
      AND tag_id IN (SELECT tag_id FROM ${contactTags} WHERE contact_id = ${keepId})
  `);
  await db.update(contactTags).set({ contactId: keepId }).where(eq(contactTags.contactId, dupId));

  await db.delete(contacts).where(eq(contacts.id, dupId));
}

/**
 * Handles Baileys' `lid-mapping.update` event -- the moment WhatsApp
 * actually reveals that a given `@lid` and phone JID are the same person.
 *
 * Before this: a contact first seen only by `@lid` (common on newer
 * accounts/history sync) had no phone number recorded, so
 * findOrCreateContact's phone-number-first lookup could never find it
 * again once a later message addressed the same person by their real
 * phone JID -- it just created a second contact (and a second
 * conversation) instead. `resolveToPhoneJid` already had the read side of
 * this mapping wired up; nothing was ever populating it, because this
 * event was never subscribed to.
 *
 * This both records the mapping (so future messages resolve correctly)
 * and, if a duplicate lid-only / phone-only pair of contacts already
 * exists from before the mapping was known, merges them into one so the
 * CRM stops showing the same person as two separate conversations.
 */
export async function syncLidMapping(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  mapping: { lid: string; pn: string }
): Promise<void> {
  const { lid, pn } = mapping;
  if (!lid || !pn || !isLidJid(lid) || isLidJid(pn)) return;

  const phoneNumber = extractPhoneNumber({ id: pn });

  const [lidContact, pnContact] = await Promise.all([
    db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.lid, lid))).get(),
    db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.waSessionId, waSessionId),
          phoneNumber ? or(eq(contacts.phoneNumber, phoneNumber), eq(contacts.jid, pn)) : eq(contacts.jid, pn)
        )
      )
      .get(),
  ]);

  if (lidContact && pnContact && lidContact.id !== pnContact.id) {
    // Two separate rows for the same person -- keep the phone-keyed one
    // (it's the durable identity) and fold the lid-only one into it.
    await mergeContacts(db, waSessionId, pnContact.id, lidContact.id);
    await db
      .update(contacts)
      .set({ lid, phoneNumber: phoneNumber ?? undefined, updatedAt: new Date() })
      .where(eq(contacts.id, pnContact.id));
    return;
  }

  if (pnContact) {
    await db
      .update(contacts)
      .set({ lid, phoneNumber: phoneNumber ?? undefined, updatedAt: new Date() })
      .where(eq(contacts.id, pnContact.id));
    return;
  }

  if (lidContact) {
    await db
      .update(contacts)
      .set({ jid: pn, phoneNumber: phoneNumber ?? undefined, updatedAt: new Date() })
      .where(eq(contacts.id, lidContact.id));
    return;
  }

  // Neither side exists yet -- nothing to merge or update; the mapping
  // will simply be picked up by resolveToPhoneJid/findOrCreateContact the
  // next time either JID shows up on a message or contacts.upsert.
}

// ── Bulk path for connect-time syncs ────────────────────────────────────

type IndexedContact = {
  id: string;
  jid: string;
  lid: string | null;
  phoneNumber: string | null;
  name: string | null;
  verifiedName: string | null;
  avatarUrl: string | null;
};

/**
 * In-memory view of one session's contacts for a bulk sync, with the same
 * lookup precedence as findOrCreateContact (phone -> lid -> jid -> phone
 * JID form). Loaded once (keyset pages of 5,000) instead of 1-4 indexed
 * lookups per synced contact.
 */
class SessionContactIndex {
  private byPhone = new Map<string, IndexedContact>();
  private byLid = new Map<string, IndexedContact>();
  private byJid = new Map<string, IndexedContact>();

  static async load(db: Db, waSessionId: string) {
    const idx = new SessionContactIndex();
    let after = "";
    for (;;) {
      const page = await db
        .select({
          id: contacts.id,
          jid: contacts.jid,
          lid: contacts.lid,
          phoneNumber: contacts.phoneNumber,
          name: contacts.name,
          verifiedName: contacts.verifiedName,
          avatarUrl: contacts.avatarUrl,
        })
        .from(contacts)
        .where(and(eq(contacts.waSessionId, waSessionId), sql`${contacts.id} > ${after}`))
        .orderBy(contacts.id)
        .limit(5000)
        .all();
      for (const c of page) idx.add(c);
      if (page.length < 5000) break;
      after = page[page.length - 1].id;
    }
    return idx;
  }

  add(c: IndexedContact) {
    if (c.phoneNumber && !this.byPhone.has(c.phoneNumber)) this.byPhone.set(c.phoneNumber, c);
    if (c.lid && !this.byLid.has(c.lid)) this.byLid.set(c.lid, c);
    this.byJid.set(c.jid, c);
  }

  find(phoneNumber: string | null, lid: string | null, jid: string) {
    return (
      (phoneNumber ? this.byPhone.get(phoneNumber) : undefined) ??
      (lid ? this.byLid.get(lid) : undefined) ??
      this.byJid.get(jid) ??
      (phoneNumber ? this.byJid.get(`${phoneNumber}@s.whatsapp.net`) : undefined)
    );
  }
}

/**
 * Bulk equivalent of calling findOrCreateContact for every item (plus,
 * optionally, ensuring a direct conversation for each), used by the
 * connect-time syncs (address book, contacts.upsert batches, history chats)
 * that used to do 2-5 sequential D1 round trips per contact.
 *
 * - Same resolution + field-upgrade rules as findOrCreateContact.
 * - Contacts whose stored fields already match are skipped entirely (the
 *   old path rewrote every row on every sync just to bump updated_at).
 * - Writes go out in db.batch chunks; a chunk that fails falls back to the
 *   one-by-one path so a single bad row can't sink the sync.
 */
export async function bulkUpsertContacts(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  items: (ContactUpsertData & { conversation?: { lastMessageAt: Date | null } })[]
): Promise<{ created: number; updated: number; unchanged: number; failed: number }> {
  const idx = await SessionContactIndex.load(db, waSessionId);
  const stats = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  type Pending = { statements: any[]; item: (typeof items)[number] };
  let chunk: Pending[] = [];

  const flush = async () => {
    if (chunk.length === 0) return;
    const current = chunk;
    chunk = [];
    const statements = current.flatMap((p) => p.statements);
    if (statements.length === 0) return;
    try {
      await db.batch(statements as [any, ...any[]]);
    } catch {
      for (const p of current) {
        try {
          const contact = await findOrCreateContact(db, workspaceId, waSessionId, p.item);
          if (p.item.conversation) {
            await db
              .insert(conversations)
              .values({ workspaceId, waSessionId, kind: "direct", contactId: contact.id, lastMessageAt: p.item.conversation.lastMessageAt })
              .onConflictDoNothing({ target: [conversations.waSessionId, conversations.contactId] });
          }
        } catch {
          stats.failed++;
        }
      }
    }
  };

  for (const item of items) {
    const phoneNumber = item.phoneNumber ?? (isLidJid(item.jid) ? null : extractPhoneNumber({ id: item.jid }));
    const lid = item.lid ?? (isLidJid(item.jid) ? item.jid : null);
    const displayName = item.name || item.notify || undefined;
    const statements: any[] = [];
    let contactId: string;

    const existing = idx.find(phoneNumber, lid, item.jid);
    if (existing) {
      contactId = existing.id;
      const changes: Partial<IndexedContact> = {};
      if (phoneNumber && item.jid !== existing.jid && !isLidJid(item.jid)) changes.jid = item.jid;
      if (phoneNumber && existing.phoneNumber !== phoneNumber) changes.phoneNumber = phoneNumber;
      if (lid && !existing.lid) changes.lid = lid;
      if (displayName && existing.name !== displayName) changes.name = displayName;
      if (item.verifiedName && existing.verifiedName !== item.verifiedName) changes.verifiedName = item.verifiedName;
      if (item.avatarUrl && existing.avatarUrl !== item.avatarUrl) changes.avatarUrl = item.avatarUrl;
      if (Object.keys(changes).length > 0) {
        statements.push(db.update(contacts).set({ ...changes, updatedAt: new Date() }).where(eq(contacts.id, existing.id)));
        Object.assign(existing, changes);
        idx.add(existing);
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    } else {
      contactId = crypto.randomUUID();
      statements.push(
        db
          .insert(contacts)
          .values({
            id: contactId,
            workspaceId,
            waSessionId,
            jid: item.jid,
            lid,
            phoneNumber,
            name: displayName,
            verifiedName: item.verifiedName,
            avatarUrl: item.avatarUrl,
          })
          .onConflictDoNothing()
      );
      idx.add({
        id: contactId,
        jid: item.jid,
        lid,
        phoneNumber,
        name: displayName ?? null,
        verifiedName: item.verifiedName ?? null,
        avatarUrl: item.avatarUrl ?? null,
      });
      stats.created++;
    }

    if (item.conversation) {
      // Resolve the contact by (session, jid) inside SQL for new rows, so a
      // concurrent insert of the same jid (live message) still links up.
      const contactRef = existing
        ? sql`${contactId}`
        : sql`(SELECT id FROM contacts WHERE wa_session_id = ${waSessionId} AND jid = ${item.jid})`;
      const lastMessageAt = item.conversation.lastMessageAt
        ? Math.floor(item.conversation.lastMessageAt.getTime() / 1000)
        : null;
      statements.push(
        db.run(sql`
          INSERT INTO conversations (id, workspace_id, wa_session_id, kind, contact_id, last_message_at)
          SELECT ${crypto.randomUUID()}, ${workspaceId}, ${waSessionId}, 'direct', ${contactRef}, ${lastMessageAt}
          WHERE ${contactRef} IS NOT NULL
          ON CONFLICT (wa_session_id, contact_id) DO NOTHING`)
      );
    }

    chunk.push({ statements, item });
    if (chunk.length >= 40) await flush();
  }
  await flush();
  return stats;
}
