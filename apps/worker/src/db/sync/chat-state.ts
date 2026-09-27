// Chat-level flags (archived/muted) synced from WhatsApp via chatModify.
import {  eq, and, conversations, contacts, groups } from "@workspace/db";
import type {Db} from "@workspace/db";

/** Update conversation archive/mute state. */
export async function updateConversationChatState(
  db: Db,
  workspaceId: string,
  waSessionId: string,
  remoteJid: string,
  update: { archived?: boolean; muted?: boolean }
): Promise<void> {
  const isGroup = remoteJid.endsWith("@g.us");
  if (isGroup) {
    const group = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.waSessionId, waSessionId), eq(groups.jid, remoteJid)))
      .get();
    if (!group) return;
    await db
      .update(conversations)
      .set(update)
      .where(and(eq(conversations.waSessionId, waSessionId), eq(conversations.groupId, group.id)));
  } else {
    // Find conversation by contact JID
    const contact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.waSessionId, waSessionId), eq(contacts.jid, remoteJid)))
      .get();
    if (!contact) return;
    await db
      .update(conversations)
      .set(update)
      .where(and(eq(conversations.waSessionId, waSessionId), eq(conversations.contactId, contact.id)));
  }
}
