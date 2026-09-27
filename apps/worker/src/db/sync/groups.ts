// Group metadata + membership sync, from groups.upsert,
// groupFetchAllParticipating, and messaging-history.set's group chats.
import {  eq, and, sql, groups, groupMembers, contacts } from "@workspace/db";
import type {Db} from "@workspace/db";
import { isLidJid, extractPhoneNumber } from "./jid";
import { findOrCreateContact } from "./contacts";

/**
 * Upsert group metadata from Baileys' groups.upsert event.
 * Populates group name, participant count, and ensures the group row exists.
 */
export async function upsertGroupMetadata(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  groupData: {
    jid: string;
    name?: string | null;
    participantCount?: number | null;
  }
): Promise<{ id: string }> {
  const inserted = await db
    .insert(groups)
    .values({
      workspaceId,
      waSessionId,
      jid: groupData.jid,
      name: groupData.name ?? null,
      participantCount: groupData.participantCount ?? 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [groups.waSessionId, groups.jid],
      set: {
        name: groupData.name ?? sql`${groups.name}`,
        participantCount: groupData.participantCount ?? sql`${groups.participantCount}`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: groups.id })
    .get() as { id: string } | undefined;

  if (inserted) return inserted;

  // Fallback: look up by JID
  const existing = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.waSessionId, waSessionId), eq(groups.jid, groupData.jid)))
    .get();
  if (existing) return existing;

  throw new Error(`upsertGroupMetadata: failed for jid=${groupData.jid}`);
}

/**
 * Sync group members from Baileys group metadata.
 * Each participant is upserted into group_members, linked to their contact
 * record when available.
 */
export async function upsertGroupMembers(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  groupId: string,
  // Baileys' GroupParticipant is `Contact & { admin, isAdmin, isSuperAdmin }`
  // -- i.e. every participant already carries the same profile fields
  // (name, notify, verifiedName, phoneNumber, lid, imgUrl) that
  // contacts.upsert events use, not just `id`/`admin`. This signature used
  // to only declare (and therefore only forward) `id`/`admin`, so every
  // group-synced contact was created with nothing but a bare jid -- no
  // number, no name, no avatar -- even when Baileys handed all of that
  // over right here. Widened to accept (and below, actually use) the rest
  // of the Contact shape.
  participants: Array<{
    id: string;
    admin?: string | null;
    lid?: string | null;
    phoneNumber?: string | null;
    name?: string | null;
    notify?: string | null;
    verifiedName?: string | null;
    imgUrl?: string | null;
  }>
): Promise<void> {
  if (!participants.length) return;

  // Re-syncing a group whose members are already known used to cost ~6 D1
  // queries per participant (LID resolve + findOrCreateContact's lookups and
  // its always-on UPDATE + the member upsert) -- ~6k for a 1,000-member
  // group, every time. Now: one query for current members, one bulk LID
  // resolve, then work only for new participants / role changes, all
  // member writes batched. findOrCreateContact still runs for genuinely
  // new participants, so phone-first dedupe/merge behaviour is unchanged.
  const existing = new Map(
    (
      await db
        .select({ jid: groupMembers.jid, contactId: groupMembers.contactId, role: groupMembers.role })
        .from(groupMembers)
        .where(and(eq(groupMembers.waSessionId, waSessionId), eq(groupMembers.groupId, groupId)))
        .all()
    ).map((m) => [m.jid, m])
  );
  const lidMap = await resolveLidsBulk(
    db,
    waSessionId,
    participants.map((p) => p.id).filter((id): id is string => !!id && isLidJid(id))
  );

  const writes: any[] = [];
  const currentJids: string[] = [];
  for (const p of participants) {
    if (!p.id) continue;
    const jid = isLidJid(p.id) ? (lidMap.get(p.id) ?? p.id) : p.id;
    currentJids.push(jid);
    const role = p.admin === "admin" || p.admin === "superadmin" ? p.admin : "member";
    const known = existing.get(jid);
    if (known?.contactId) {
      if (known.role !== role) {
        writes.push(
          db
            .update(groupMembers)
            .set({ role })
            .where(and(eq(groupMembers.waSessionId, waSessionId), eq(groupMembers.groupId, groupId), eq(groupMembers.jid, jid)))
        );
      }
      continue;
    }

    // New participant (or one never linked to a contact): full resolution.
    // Forward the full profile Baileys gave us (same fields/precedence as
    // syncContactUpsert) instead of creating a bare-jid stub contact.
    const contact = await findOrCreateContact(db, workspaceId, waSessionId, {
      jid,
      lid: p.lid || null,
      phoneNumber: extractPhoneNumber(p),
      name: p.name || p.notify || p.verifiedName || undefined,
      notify: p.notify || undefined,
      verifiedName: p.verifiedName || undefined,
      avatarUrl: p.imgUrl || null,
    });
    writes.push(
      db
        .insert(groupMembers)
        .values({ workspaceId, waSessionId, groupId, contactId: contact.id, jid, role })
        .onConflictDoUpdate({
          target: [groupMembers.waSessionId, groupMembers.groupId, groupMembers.jid],
          set: { contactId: contact.id, role },
        })
    );
  }

  // People who left the group: the participant list is complete, so any
  // stored member not in it is stale (smart lists target group_members).
  writes.push(
    db.run(sql`
      DELETE FROM group_members
      WHERE wa_session_id = ${waSessionId} AND group_id = ${groupId}
        AND jid NOT IN (SELECT value FROM json_each(${JSON.stringify(currentJids)}))`)
  );
  for (let i = 0; i < writes.length; i += 50) {
    await db.batch(writes.slice(i, i + 50) as [any, ...any[]]);
  }

  // Update participant count on the group
  const count = participants.length;
  await db.update(groups).set({ participantCount: count, updatedAt: new Date() }).where(eq(groups.id, groupId));
}

/**
 * Bulk version of resolveToPhoneJid's DB lookups (by `lid` column, then by
 * `jid` column) for many LIDs at once -- 2 queries instead of 2 per LID.
 * LIDs with no mapping are absent from the result (caller keeps the LID).
 */
async function resolveLidsBulk(db: Db, waSessionId: string, lids: string[]) {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(lids));
  for (let i = 0; i < unique.length; i += 2000) {
    const chunk = JSON.stringify(unique.slice(i, i + 2000));
    const byLid = await db
      .select({ lid: contacts.lid, jid: contacts.jid, phone: contacts.phoneNumber })
      .from(contacts)
      .where(and(eq(contacts.waSessionId, waSessionId), sql`${contacts.lid} IN (SELECT value FROM json_each(${chunk}))`))
      .all();
    for (const r of byLid) {
      if (!r.lid || out.has(r.lid)) continue;
      if (r.jid && !isLidJid(r.jid)) out.set(r.lid, r.jid);
      else if (r.phone) out.set(r.lid, `${r.phone}@s.whatsapp.net`);
    }
    const byJid = await db
      .select({ jid: contacts.jid, lid: contacts.lid, phone: contacts.phoneNumber })
      .from(contacts)
      .where(and(eq(contacts.waSessionId, waSessionId), sql`${contacts.jid} IN (SELECT value FROM json_each(${chunk}))`))
      .all();
    for (const r of byJid) {
      if (out.has(r.jid)) continue;
      if (r.lid && !isLidJid(r.lid) && r.lid !== r.jid) out.set(r.jid, r.lid);
      else if (r.phone) out.set(r.jid, `${r.phone}@s.whatsapp.net`);
    }
  }
  return out;
}
