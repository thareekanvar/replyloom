// Broadcast anti-spam: contact-list ownership resolution + campaign
// eligibility, kept as one shared module so apps/web (list management UI)
// and apps/worker (campaign start / send-path enforcement) can never
// disagree about who a campaign is allowed to message.
// Design doc: claude/broadcast-anti-spam-design-2026-09-23.md (project docs).
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  contacts,
  contactLists,
  contactListMembers,
  workspaceBroadcastSettings,
} from "../schema";

// A workspace's own settings can raise its ceiling, but never past this --
// otherwise a careless or compromised admin account could remove the
// safety rail entirely. Not exposed in any UI as a configurable value.
export const ANTI_BAN_HARD_MAX_CEILING = 2000;
export const DEFAULT_RECIPIENT_CEILING = 500;
export const ALLOWED_COOLDOWN_DAYS = [2, 3, 7, 14] as const;
export const DEFAULT_COOLDOWN_DAYS = 7;

// Session warm-up tiers: a freshly connected number gets a much lower daily
// cap than one that's been healthy for weeks. Multiplies
// BROADCAST_DAILY_SEND_LIMIT. Keyed by days-since-session-created.
export const WARM_UP_TIERS: { maxAgeDays: number; multiplier: number }[] = [
  { maxAgeDays: 3, multiplier: 0.1 },
  { maxAgeDays: 7, multiplier: 0.25 },
  { maxAgeDays: 14, multiplier: 0.5 },
  { maxAgeDays: 28, multiplier: 0.75 },
  { maxAgeDays: Infinity, multiplier: 1 },
];

/** Base per-number broadcast cap per rolling 24h, before warm-up scaling. */
export const BROADCAST_DAILY_SEND_LIMIT = 250;
/** Floor so a brand-new number can still send a handful. */
export const BROADCAST_DAILY_SEND_FLOOR = 5;

export function warmUpMultiplier(sessionCreatedAt: Date | null | undefined, now = new Date()) {
  if (!sessionCreatedAt) return WARM_UP_TIERS[0].multiplier;
  const ageDays = (now.getTime() - sessionCreatedAt.getTime()) / (24 * 60 * 60 * 1000);
  for (const tier of WARM_UP_TIERS) {
    if (ageDays <= tier.maxAgeDays) return tier.multiplier;
  }
  return 1;
}

/** The daily cap a number actually gets today -- shared by the worker (which
 * enforces it) and the UI (which shows it), so they can't drift apart. */
export function effectiveDailyBroadcastLimit(sessionCreatedAt: Date | null | undefined, now = new Date()) {
  return Math.max(
    BROADCAST_DAILY_SEND_FLOOR,
    Math.floor(BROADCAST_DAILY_SEND_LIMIT * warmUpMultiplier(sessionCreatedAt, now)),
  );
}

export async function getBroadcastSettings(db: Db, workspaceId: string) {
  const row = await db
    .select()
    .from(workspaceBroadcastSettings)
    .where(eq(workspaceBroadcastSettings.workspaceId, workspaceId))
    .get();
  return {
    recipientCeiling: Math.min(row?.recipientCeiling ?? DEFAULT_RECIPIENT_CEILING, ANTI_BAN_HARD_MAX_CEILING),
    cooldownDays: row?.cooldownDays ?? DEFAULT_COOLDOWN_DAYS,
    listSourcingMode: row?.listSourcingMode ?? "warn",
    listMinIntervalHours: row?.listMinIntervalHours ?? 24,
  } as const;
}

/**
 * Adds a contact to a list and resolves "first list wins" ownership, as a
 * single D1 batch (never sequential round trips). Returns the membership's
 * resulting ownership.
 */
export async function addContactToList(
  db: Db,
  params: { listId: string; contactId: string; source: "manual" | "search" | "rule" | "import" },
) {
  const contact = await db
    .select({ broadcastListId: contacts.broadcastListId })
    .from(contacts)
    .where(eq(contacts.id, params.contactId))
    .get();

  const becomesOwner = !contact?.broadcastListId;
  const now = new Date();

  const memberInsert = db
    .insert(contactListMembers)
    .values({
      listId: params.listId,
      contactId: params.contactId,
      source: params.source,
      ownership: becomesOwner ? "owned" : "disabled",
      addedAt: now,
    })
    .onConflictDoNothing();

  if (becomesOwner) {
    await db.batch([
      memberInsert,
      db
        .update(contacts)
        .set({ broadcastListId: params.listId, broadcastListSince: now })
        .where(eq(contacts.id, params.contactId)),
    ]);
  } else {
    await memberInsert;
  }

  return becomesOwner ? ("owned" as const) : ("disabled" as const);
}

// Ids per statement for the bulk paths below. They travel as ONE bound JSON
// parameter (read back with json_each), so D1's 100-bound-parameter cap
// doesn't apply; this just keeps each statement comfortably small.
const BULK_CHUNK = 500;
// Statements per db.batch() round trip.
const BULK_STATEMENTS_PER_BATCH = 40;

/**
 * Set-based version of addContactToList for many contacts: 2 statements per
 * 500 contacts, sent in batches, instead of 2 sequential round trips per
 * contact. A 100k-contact smart list used to need ~200k D1 queries (far past
 * the ~1,000-queries-per-invocation Worker limit, so it simply failed past a
 * few hundred matches); now it's ~400 statements in ~10 round trips.
 * Same semantics: first list wins ownership, later lists get "disabled".
 */
export async function addContactsToListBulk(
  db: Db,
  params: {
    workspaceId: string;
    listId: string;
    contactIds: string[];
    source: "manual" | "search" | "rule" | "import";
  },
) {
  const ids = Array.from(new Set(params.contactIds));
  if (ids.length === 0) return;
  const statements: any[] = [];
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const rows = JSON.stringify(ids.slice(i, i + BULK_CHUNK).map((contactId) => [crypto.randomUUID(), contactId]));
    // `WHERE true` disambiguates INSERT ... SELECT ... ON CONFLICT for SQLite's parser.
    statements.push(
      db.run(sql`
        INSERT INTO contact_list_members (id, list_id, contact_id, source, ownership, added_at)
        SELECT json_extract(j.value, '$[0]'), ${params.listId}, c.id, ${params.source},
               CASE WHEN c.broadcast_list_id IS NULL THEN 'owned' ELSE 'disabled' END,
               unixepoch()
        FROM json_each(${rows}) j
        JOIN contacts c ON c.id = json_extract(j.value, '$[1]') AND c.workspace_id = ${params.workspaceId}
        WHERE true
        ON CONFLICT DO NOTHING`),
      db.run(sql`
        UPDATE contacts
        SET broadcast_list_id = ${params.listId}, broadcast_list_since = unixepoch()
        WHERE broadcast_list_id IS NULL
          AND workspace_id = ${params.workspaceId}
          AND id IN (SELECT json_extract(value, '$[1]') FROM json_each(${rows}))
          AND EXISTS (
            SELECT 1 FROM contact_list_members m
            WHERE m.list_id = ${params.listId} AND m.contact_id = contacts.id AND m.ownership = 'owned'
          )`),
    );
  }
  for (let i = 0; i < statements.length; i += BULK_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + BULK_STATEMENTS_PER_BATCH) as any);
  }
}

/**
 * Explicit reassignment ("use this list instead") -- the only way ownership
 * moves once set. One batch: flip old owner to disabled, flip target to
 * owned, update the denormalized columns on `contacts`.
 */
export async function reassignContactOwnership(db: Db, params: { contactId: string; toListId: string }) {
  const contact = await db
    .select({ broadcastListId: contacts.broadcastListId })
    .from(contacts)
    .where(eq(contacts.id, params.contactId))
    .get();
  if (!contact) throw new Error("Contact not found");

  const now = new Date();
  const ops = [];
  if (contact.broadcastListId && contact.broadcastListId !== params.toListId) {
    ops.push(
      db
        .update(contactListMembers)
        .set({ ownership: "disabled" })
        .where(
          and(eq(contactListMembers.listId, contact.broadcastListId), eq(contactListMembers.contactId, params.contactId)),
        ),
    );
  }
  ops.push(
    db
      .update(contactListMembers)
      .set({ ownership: "owned" })
      .where(and(eq(contactListMembers.listId, params.toListId), eq(contactListMembers.contactId, params.contactId))),
  );
  ops.push(
    db
      .update(contacts)
      .set({ broadcastListId: params.toListId, broadcastListSince: now })
      .where(eq(contacts.id, params.contactId)),
  );
  await db.batch(ops as [any, ...any[]]);
}

/**
 * Recomputes a list's `usableAfter` from the earliest membership `addedAt`
 * still in the list -- aging applies to membership, not the list shell, so
 * dumping fresh numbers into an old empty list doesn't make them
 * immediately usable. Call after any membership insert.
 */
export async function recomputeListUsableAfter(db: Db, listId: string, cooldownHours = 24) {
  // ORDER BY + LIMIT 1 on contact_list_members_list_added_idx: one index
  // probe instead of reading every member row for min().
  const earliest = await db
    .select({ addedAt: sql<number>`${contactListMembers.addedAt}` })
    .from(contactListMembers)
    .where(eq(contactListMembers.listId, listId))
    .orderBy(contactListMembers.addedAt)
    .limit(1)
    .get();
  if (!earliest?.addedAt) return;
  const usableAfter = new Date(Number(earliest.addedAt) * 1000 + cooldownHours * 60 * 60 * 1000);
  await db.update(contactLists).set({ usableAfter }).where(eq(contactLists.id, listId));
}

/**
 * The eligibility resolution query: one indexed round trip producing every
 * contact a campaign against this list may actually message right now --
 * suppressed contacts and cross-list-disabled memberships are excluded at
 * the query level, never filtered in application code after a wider read.
 */
export async function resolveEligibleContactIds(
  db: Db,
  params: { listId: string; workspaceId: string; cooldownDays: number },
) {
  const cooldownCutoff = new Date(Date.now() - params.cooldownDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ contactId: contacts.id })
    .from(contactListMembers)
    .innerJoin(contacts, eq(contacts.id, contactListMembers.contactId))
    .where(
      and(
        eq(contactListMembers.listId, params.listId),
        eq(contactListMembers.ownership, "owned"),
        eq(contacts.workspaceId, params.workspaceId),
        eq(contacts.doNotBroadcast, false),
        or(isNull(contacts.lastBroadcastAt), lt(contacts.lastBroadcastAt, cooldownCutoff)),
      ),
    )
    .all();
  return rows.map((r) => r.contactId);
}

/**
 * Opt-out phrases, matched against the WHOLE message after normalization --
 * never as a substring, so "don't stop the order" can't opt someone out.
 * Covers the languages most likely in this app's markets (English, Arabic,
 * Hindi/Urdu, Malayalam, Tamil, French, Spanish, Portuguese, German,
 * Indonesian/Malay, Turkish). Stored pre-normalized (see normalizeStopText).
 */
const STOP_PHRASES = [
  // Deliberately excludes words that are ordinary replies in a sales chat
  // ("cancel", "end", "remove", "para", "venda"...): an opt-out here is
  // permanent and can't be cleared by an admin, so false positives cost
  // real customers.
  // English
  "stop", "stop all", "stop please", "please stop", "unsubscribe", "optout", "opt out", "opt-out",
  "remove me", "stop messaging", "stop sending", "stop messaging me", "no more messages",
  // Arabic
  "توقف", "توقفوا", "ايقاف", "الغاء الاشتراك", "الغي الاشتراك", "لا ترسل", "لا ترسلوا", "لا ترسل لي",
  // Hindi / Urdu (Devanagari, Urdu script, and romanized)
  "बंद करो", "रोको", "बंद कीजिए", "मैसेज बंद करो", "بند کرو", "band karo", "mat bhejo",
  // Malayalam / Tamil
  "നിർത്തുക", "മെസ്സേജ് വേണ്ട", "நிறுத்து", "நிறுத்துங்கள்",
  // French / Spanish / Portuguese / German
  "arret", "arreter", "desabonner", "se desabonner", "desinscrire", "darme de baja",
  "cancelar suscripcion", "cancelar inscricao", "descadastrar", "abmelden", "abbestellen",
  // Indonesian / Malay / Turkish
  "berhenti", "berhenti langganan", "abonelikten cik", "durdur",
].map((p) => normalizeStopText(p));

const STOP_PHRASE_SET = new Set(STOP_PHRASES);

/**
 * Lowercases, strips accents/Arabic diacritics & tatweel, unifies Arabic
 * alef/ya/ta-marbuta variants, drops punctuation/emoji, and collapses
 * whitespace -- so "STOP!!", "Stop.", "إلغاء" and "الغاء" all compare equal.
 */
export function normalizeStopText(text: string): string {
  return text
    .replace(/[\u200C\u200D]/g, "") // ZWNJ/ZWJ (Malayalam chillu, Indic conjuncts)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // Latin combining accents
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // Arabic harakat, superscript alef, tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") // alef variants -> ا
    .replace(/\u0649/g, "\u064A") // alef maksura -> ي
    .replace(/\u0629/g, "\u0647") // ta marbuta -> ه
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, " ") // punctuation, emoji
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

/** Kept for callers/tests that want the raw list. */
export const STOP_KEYWORDS = STOP_PHRASES;

export function matchesStopKeyword(body: string | null | undefined) {
  if (!body) return false;
  // Long messages are conversations, not opt-outs.
  if (body.length > 40) return false;
  return STOP_PHRASE_SET.has(normalizeStopText(body));
}
