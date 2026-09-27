// Integration test: runs the real ingest SQL (syncIncomingMessage /
// syncMessagesBatch) against an actual SQLite database with every migration
// applied, via drizzle's sqlite-proxy driver on node:sqlite. Mocked-DB tests
// can't catch SQL-level mistakes (guards, conflict targets, CASE ordering).
import { describe, expect, it, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as schema from "@workspace/db/schema";
import { bulkUpsertContacts, parseBaileysMessage, syncIncomingMessage, syncMessagesBatch, updateMessageStatus, upsertGroupMembers  } from "../db/sync";
import type {ParsedMessage} from "../db/sync";
import { addContactsToListBulk } from "@workspace/db";

import type * as NodeSqlite from "node:sqlite";

const require = createRequire(import.meta.url);
let sqlite: typeof NodeSqlite | null = null;
try {
  sqlite = require("node:sqlite");
} catch {
  sqlite = null;
}

const MIGRATIONS = join(__dirname, "../../../../packages/db/migrations");
// drizzle-orm is a dependency of @workspace/db, not of this app -- load the
// proxy driver from that package's copy (same instance the sync code uses).
const { drizzle } = (await import(
  pathToFileURL(join(__dirname, "../../../../packages/db/node_modules/drizzle-orm/sqlite-proxy/index.js")).href
)) as { drizzle: (...args: any[]) => any };

function makeDb() {
  const raw = new sqlite!.DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
      if (!stmt.trim()) continue;
      try {
        raw.exec(stmt);
      } catch (e: any) {
        // 0017's table-rebuild copy references a column via a double-quoted
        // identifier that only D1's lenient DQS mode accepts; the tables are
        // empty here, so skipping the copy is harmless.
        if (/^\s*INSERT INTO `__new_/.test(stmt) && /no such column/.test(String(e?.message))) continue;
        throw e;
      }
    }
  }
  const exec = (sql: string, params: any[], method: string) => {
    const st = raw.prepare(sql);
    // Not every Node build that can load this file has setReturnArrays.
    (st as { setReturnArrays?: (enable: boolean) => void }).setReturnArrays?.(true);
    if (method === "run") {
      // RETURNING statements come through as "run" in batches too.
      if (/\breturning\b/i.test(sql)) return { rows: st.all(...params) as any[] };
      st.run(...params);
      return { rows: [] };
    }
    if (method === "get") return { rows: (st.get(...params) as any) ?? undefined };
    return { rows: st.all(...params) as any[] };
  };
  const db = drizzle(
    async (sql: string, params: any[], method: string) => exec(sql, params, method) as any,
    async (queries: { sql: string; params: any[]; method: string }[]) => {
      raw.exec("BEGIN");
      try {
        const out = queries.map((q) => exec(q.sql, q.params, q.method) as any);
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    { schema }
  );
  raw.exec(`INSERT INTO organization (id, name, slug, created_at) VALUES ('ws1', 'ws', 'ws', 0)`);
  raw.exec(`INSERT INTO wa_sessions (id, workspace_id, label) VALUES ('s1', 'ws1', 'main')`);
  return { db: db, raw };
}

const msg = (over: Partial<ParsedMessage>): ParsedMessage => ({
  waMessageId: "W1",
  remoteJid: "971500000001@s.whatsapp.net",
  fromMe: false,
  type: "text",
  body: "hello",
  pushName: "Alice",
  timestampMs: 1_790_000_000_000,
  ...over,
});

describe.skipIf(!sqlite)("message ingest against real SQLite", () => {
  let ctx: ReturnType<typeof makeDb>;
  beforeEach(() => {
    ctx = makeDb();
  });

  it("inserts once, bumps unread once, ignores duplicate deliveries", async () => {
    const conv = await syncIncomingMessage(ctx.db, "ws1", "s1", msg({}));
    await syncIncomingMessage(ctx.db, "ws1", "s1", msg({})); // duplicate
    const c = ctx.raw.prepare("select unread_count u, last_body b from conversations where id = ?").get(conv) as any;
    expect(c.u).toBe(1);
    expect(c.b).toBe("hello");
    expect((ctx.raw.prepare("select count(*) n from messages").get() as any).n).toBe(1);
  });

  it("keeps lastMessageAt/preview forward-only for out-of-order history", async () => {
    const newer = msg({ waMessageId: "N", body: "newer", timestampMs: 1_790_000_100_000 });
    const older = msg({ waMessageId: "O", body: "older", timestampMs: 1_790_000_000_000 });
    const r = await syncMessagesBatch(ctx.db, "ws1", "s1", [newer, older], { bumpUnread: false });
    expect(r).toEqual({ synced: 2, failed: 0 });
    const c = ctx.raw.prepare("select unread_count u, last_body b, last_message_at t from conversations").get() as any;
    expect(c.b).toBe("newer");
    expect(c.u).toBe(0);
    expect(c.t).toBe(1_790_000_100);
  });

  it("STOP reply opts the contact out", async () => {
    await syncIncomingMessage(ctx.db, "ws1", "s1", msg({ body: "STOP" }));
    const ct = ctx.raw.prepare("select do_not_broadcast d, do_not_broadcast_reason r from contacts").get() as any;
    expect(ct.d).toBe(1);
    expect(ct.r).toBe("opted_out");
  });

  it("re-resolves when a cached conversation was deleted", async () => {
    await syncIncomingMessage(ctx.db, "ws1", "s1", msg({ remoteJid: "971500000009@s.whatsapp.net", waMessageId: "A" }));
    ctx.raw.exec("DELETE FROM contacts"); // cascades conversations + messages
    await syncIncomingMessage(ctx.db, "ws1", "s1", msg({ remoteJid: "971500000009@s.whatsapp.net", waMessageId: "B" }));
    expect((ctx.raw.prepare("select count(*) n from messages").get() as any).n).toBe(1);
  });

  it("receipts only move status forward, batched", async () => {
    await syncIncomingMessage(ctx.db, "ws1", "s1", msg({ fromMe: true, waMessageId: "X1" }));
    await syncIncomingMessage(ctx.db, "ws1", "s1", msg({ fromMe: true, waMessageId: "X2" }));
    expect(await updateMessageStatus(ctx.db, "ws1", ["X1", "X2"], "read")).toHaveLength(2);
    expect(await updateMessageStatus(ctx.db, "ws1", ["X1"], "delivered")).toHaveLength(0); // no downgrade
    expect(await updateMessageStatus(ctx.db, "ws2", ["X2"], "read")).toHaveLength(0); // other workspace
    const rows = ctx.raw.prepare("select status s from messages order by wa_message_id").all() as any[];
    expect(rows.map((r) => r.s)).toEqual(["read", "read"]);
  });

  it("bulk list add: first list owns, second list gets disabled, other workspaces ignored", async () => {
    ctx.raw.exec(`INSERT INTO organization (id, name, slug, created_at) VALUES ('ws2', 'o', 'o', 0)`);
    ctx.raw.exec(`INSERT INTO wa_sessions (id, workspace_id, label) VALUES ('s2', 'ws2', 'x')`);
    for (let i = 0; i < 1200; i++) {
      const ws = i % 10 === 0 ? "ws2" : "ws1";
      ctx.raw.exec(`INSERT INTO contacts (id, workspace_id, wa_session_id, jid) VALUES ('c${i}', '${ws}', '${ws === "ws1" ? "s1" : "s2"}', 'j${i}')`);
    }
    ctx.raw.exec(`INSERT INTO contact_lists (id, workspace_id, name) VALUES ('L1', 'ws1', 'a'), ('L2', 'ws1', 'b')`);
    const ids = Array.from({ length: 1200 }, (_, i) => `c${i}`);
    await addContactsToListBulk(ctx.db, { workspaceId: "ws1", listId: "L1", contactIds: ids, source: "rule" });
    await addContactsToListBulk(ctx.db, { workspaceId: "ws1", listId: "L1", contactIds: ids, source: "rule" }); // idempotent
    await addContactsToListBulk(ctx.db, { workspaceId: "ws1", listId: "L2", contactIds: ids.slice(0, 100), source: "manual" });
    const counts = Object.fromEntries(
      (ctx.raw.prepare("select list_id || ':' || ownership k, count(*) n from contact_list_members group by 1").all() as any[]).map((r) => [r.k, r.n])
    );
    expect(counts).toEqual({ "L1:owned": 1080, "L2:disabled": 90 });
    expect((ctx.raw.prepare("select count(*) n from contacts where broadcast_list_id = 'L1'").get() as any).n).toBe(1080);
  });

  it("keyset cursors return every row exactly once, even with timestamp ties", () => {
    const raw = ctx.raw;
    raw.exec(`INSERT INTO contacts (id, workspace_id, wa_session_id, jid) VALUES ('ct', 'ws1', 's1', 'jt')`);
    raw.exec(`INSERT INTO conversations (id, workspace_id, wa_session_id, kind, contact_id) VALUES ('cv', 'ws1', 's1', 'direct', 'ct')`);
    // 60 messages, 3 distinct seconds -> page boundaries land inside ties.
    for (let i = 0; i < 60; i++) {
      raw.exec(`INSERT INTO messages (id, workspace_id, conversation_id, wa_message_id, direction, type, status, created_at)
                VALUES ('m${String(i).padStart(2, "0")}', 'ws1', 'cv', 'w${i}', 'in', 'text', 'read', ${1_790_000_000 + Math.floor(i / 20)})`);
    }
    const seen: string[] = [];
    let cursor: [number, string] | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const rows = (cursor
        ? raw.prepare(`SELECT id, created_at t FROM messages WHERE conversation_id = 'cv' AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 26`).all(cursor[0], cursor[1])
        : raw.prepare(`SELECT id, created_at t FROM messages WHERE conversation_id = 'cv' ORDER BY created_at DESC, id DESC LIMIT 26`).all()) as any[];
      const page = rows.slice(0, 25);
      seen.push(...page.map((r) => r.id));
      if (rows.length <= 25) break;
      const last = page[page.length - 1];
      cursor = [last.t, last.id];
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);

    // Inbox: unpinned segment keyed on the index expression, NULL
    // last_message_at shells included, ties on the timestamp.
    for (let i = 0; i < 40; i++) {
      raw.exec(`INSERT INTO contacts (id, workspace_id, wa_session_id, jid) VALUES ('k${i}', 'ws1', 's1', 'jk${i}')`);
      raw.exec(`INSERT INTO conversations (id, workspace_id, wa_session_id, kind, contact_id, last_message_at)
                VALUES ('q${String(i).padStart(2, "0")}', 'ws1', 's1', 'direct', 'k${i}', ${i % 4 === 0 ? "NULL" : 1_790_000_000 + (i % 3)})`);
    }
    const T = `(CASE WHEN last_message_at IS NULL THEN 0 ELSE last_message_at END)`;
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN SELECT id FROM conversations WHERE workspace_id = 'ws1' AND pinned_at IS NULL AND archived = 0 AND ${T} <= 5 AND (${T} < 5 OR id < 'x') ORDER BY ${T} DESC, id DESC LIMIT 10`).all() as any[]).map((r) => r.detail).join(" ");
    expect(plan).toContain("conversations_unpinned_idx");
    expect(plan).not.toContain("TEMP B-TREE");
    const convSeen: string[] = [];
    let c: [number, string] | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const rows = (c
        ? raw.prepare(`SELECT id, ${T} t FROM conversations WHERE workspace_id = 'ws1' AND pinned_at IS NULL AND archived = 0 AND ${T} <= ? AND (${T} < ? OR id < ?) ORDER BY ${T} DESC, id DESC LIMIT 8`).all(c[0], c[0], c[1])
        : raw.prepare(`SELECT id, ${T} t FROM conversations WHERE workspace_id = 'ws1' AND pinned_at IS NULL AND archived = 0 ORDER BY ${T} DESC, id DESC LIMIT 8`).all()) as any[];
      const page = rows.slice(0, 7);
      convSeen.push(...page.map((r) => r.id));
      if (rows.length <= 7) break;
      const last = page[page.length - 1];
      c = [last.t, last.id];
    }
    // 40 new + the 'cv' conversation from the message test above.
    expect(convSeen).toHaveLength(41);
    expect(new Set(convSeen).size).toBe(41);
  });

  it("trigger-maintained entity_counts stay exact through inserts, updates, cascades", async () => {
    const raw = ctx.raw;
    const triggers = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_counts_%'`).all() as any[]).map((r) => r.name);
    // A drizzle table rebuild drops a table's triggers silently -- fail loudly instead.
    expect(triggers.length).toBe(27);

    raw.exec(`INSERT INTO pipeline_stages (id, workspace_id, name, color, position) VALUES ('st1', 'ws1', 'A', '#000', 0), ('st2', 'ws1', 'B', '#000', 1)`);
    raw.exec(`INSERT INTO contact_lists (id, workspace_id, name) VALUES ('LX', 'ws1', 'x')`);
    for (let i = 0; i < 30; i++) {
      await syncIncomingMessage(ctx.db, "ws1", "s1", msg({ remoteJid: `97150000${1000 + i}@s.whatsapp.net`, waMessageId: `E${i}`, body: "hi" }));
    }
    raw.exec(`UPDATE conversations SET archived = 1 WHERE rowid % 5 = 0`);
    raw.exec(`UPDATE conversations SET unread_count = 0 WHERE rowid % 3 = 0`);
    raw.exec(`UPDATE conversations SET pinned_at = 1 WHERE rowid % 7 = 0`);
    raw.exec(`UPDATE contacts SET do_not_broadcast = 1 WHERE rowid % 4 = 0`);
    raw.exec(`INSERT INTO contact_list_members (id, list_id, contact_id, ownership) SELECT 'm' || id, 'LX', id, CASE WHEN rowid % 2 = 0 THEN 'owned' ELSE 'disabled' END FROM contacts`);
    raw.exec(`UPDATE contact_list_members SET ownership = 'owned' WHERE rowid % 3 = 0`);
    raw.exec(`INSERT INTO deals (id, workspace_id, stage_id, contact_id, title, value_cents, position) SELECT 'd' || id, 'ws1', 'st1', id, 't', 500, rowid FROM contacts`);
    raw.exec(`UPDATE deals SET stage_id = 'st2', value_cents = 700 WHERE rowid % 2 = 0`);
    raw.exec(`INSERT INTO notes (id, workspace_id, contact_id, body) SELECT 'n' || id, 'ws1', id, 'b' FROM contacts`);
    raw.exec(`DELETE FROM contacts WHERE rowid % 6 = 1`); // cascades conversations, members, deals?, notes

    const counter = (scope: string, name: string) =>
      ((raw.prepare(`SELECT n FROM entity_counts WHERE scope_id = ? AND name = ?`).get(scope, name) as any)?.n ?? 0) as number;
    const count = (q: string) => (raw.prepare(q).get() as any).n as number;
    expect(counter("ws1", "contacts")).toBe(count(`SELECT count(*) n FROM contacts WHERE workspace_id = 'ws1'`));
    expect(counter("ws1", "contacts_suppressed")).toBe(count(`SELECT count(*) n FROM contacts WHERE workspace_id = 'ws1' AND do_not_broadcast = 1`));
    expect(counter("ws1", "conv_active")).toBe(count(`SELECT count(*) n FROM conversations WHERE workspace_id = 'ws1' AND archived = 0`));
    expect(counter("ws1", "conv_archived")).toBe(count(`SELECT count(*) n FROM conversations WHERE workspace_id = 'ws1' AND archived = 1`));
    expect(counter("ws1", "conv_unread")).toBe(count(`SELECT count(*) n FROM conversations WHERE workspace_id = 'ws1' AND archived = 0 AND unread_count > 0`));
    expect(counter("ws1", "conv_pinned")).toBe(count(`SELECT count(*) n FROM conversations WHERE workspace_id = 'ws1' AND archived = 0 AND pinned_at IS NOT NULL`));
    expect(counter("ws1", "conv_direct")).toBe(count(`SELECT count(*) n FROM conversations WHERE workspace_id = 'ws1' AND archived = 0 AND kind = 'direct'`));
    expect(counter("LX", "members_owned")).toBe(count(`SELECT count(*) n FROM contact_list_members WHERE list_id = 'LX' AND ownership = 'owned'`));
    expect(counter("LX", "members_disabled")).toBe(count(`SELECT count(*) n FROM contact_list_members WHERE list_id = 'LX' AND ownership = 'disabled'`));
    for (const st of ["st1", "st2"]) {
      expect(counter(st, "deals")).toBe(count(`SELECT count(*) n FROM deals WHERE stage_id = '${st}'`));
      expect(counter(st, "deals_value")).toBe(count(`SELECT coalesce(sum(value_cents), 0) n FROM deals WHERE stage_id = '${st}'`));
    }
    const anyContact = (raw.prepare(`SELECT id FROM contacts LIMIT 1`).get() as any).id;
    expect(counter(anyContact, "notes")).toBe(count(`SELECT count(*) n FROM notes WHERE contact_id = '${anyContact}'`));
    expect(counter(anyContact, "notes")).toBe(1);

    // Deleting a scope owner removes its counters (no orphans / negatives).
    raw.exec(`DELETE FROM contact_lists WHERE id = 'LX'`);
    expect(count(`SELECT count(*) n FROM entity_counts WHERE scope_id = 'LX'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM entity_counts WHERE n < 0`)).toBe(0);
  });

  it("group member re-sync: adds new, updates roles, removes leavers, skips unchanged", async () => {
    const raw = ctx.raw;
    raw.exec(`INSERT INTO groups (id, workspace_id, wa_session_id, jid, name) VALUES ('g1', 'ws1', 's1', 'grp@g.us', 'G')`);
    const members = () =>
      (raw.prepare(`SELECT jid, role FROM group_members WHERE group_id = 'g1' ORDER BY jid`).all() as any[]).map((r) => `${r.jid}:${r.role}`);
    await upsertGroupMembers(ctx.db, "ws1", "s1", "g1", [
      { id: "971500000001@s.whatsapp.net", admin: "admin", name: "A" },
      { id: "971500000002@s.whatsapp.net" },
      { id: "971500000003@s.whatsapp.net" },
    ]);
    expect(members()).toEqual([
      "971500000001@s.whatsapp.net:admin",
      "971500000002@s.whatsapp.net:member",
      "971500000003@s.whatsapp.net:member",
    ]);
    const contactsBefore = (raw.prepare(`SELECT count(*) n FROM contacts`).get() as any).n;
    // 3 left, 2 promoted, 4 joined; 1 unchanged.
    await upsertGroupMembers(ctx.db, "ws1", "s1", "g1", [
      { id: "971500000001@s.whatsapp.net", admin: "admin" },
      { id: "971500000002@s.whatsapp.net", admin: "admin" },
      { id: "971500000004@s.whatsapp.net" },
    ]);
    expect(members()).toEqual([
      "971500000001@s.whatsapp.net:admin",
      "971500000002@s.whatsapp.net:admin",
      "971500000004@s.whatsapp.net:member",
    ]);
    expect((raw.prepare(`SELECT count(*) n FROM contacts`).get() as any).n).toBe(contactsBefore + 1);
    // LID participant resolves through an existing contact's lid mapping.
    raw.exec(`UPDATE contacts SET lid = '123456@lid' WHERE jid = '971500000004@s.whatsapp.net'`);
    await upsertGroupMembers(ctx.db, "ws1", "s1", "g1", [
      { id: "971500000001@s.whatsapp.net", admin: "admin" },
      { id: "971500000002@s.whatsapp.net", admin: "admin" },
      { id: "123456@lid" },
    ]);
    expect(members()).toContain("971500000004@s.whatsapp.net:member");
    expect(members()).toHaveLength(3);
  });

  it("history-synced outbound messages keep their delivered/read status", async () => {
    const base = { remoteJid: "971500000077@s.whatsapp.net", fromMe: true };
    const read = await parseBaileysMessage(ctx.db, "s1", {
      key: { ...base, id: "H1" }, message: { conversation: "old read msg" }, messageTimestamp: 1_790_000_000, status: 4,
    });
    const pending = await parseBaileysMessage(ctx.db, "s1", {
      key: { ...base, id: "H2" }, message: { conversation: "live echo" }, messageTimestamp: 1_790_000_001, status: 1,
    });
    const inbound = await parseBaileysMessage(ctx.db, "s1", {
      key: { ...base, fromMe: false, id: "H3" }, message: { conversation: "their msg" }, messageTimestamp: 1_790_000_002, status: 4,
    });
    expect(read?.status).toBe("read");
    expect(pending?.status).toBeUndefined(); // never start below the default "sent"
    expect(inbound?.status).toBeUndefined();
    await syncMessagesBatch(ctx.db, "ws1", "s1", [read!, pending!, inbound!], { bumpUnread: false });
    const rows = Object.fromEntries(
      (ctx.raw.prepare(`SELECT wa_message_id w, status s FROM messages WHERE wa_message_id IN ('H1','H2','H3')`).all() as any[]).map((r) => [r.w, r.s])
    );
    expect(rows).toEqual({ H1: "read", H2: "sent", H3: "delivered" });
  });

  it("bulk contact sync: phone-first dedupe, conversations, idempotent re-sync", async () => {
    const raw = ctx.raw;
    raw.exec(`INSERT INTO contacts (id, workspace_id, wa_session_id, jid, phone_number, name) VALUES ('old', 'ws1', 's1', '971500009999@s.whatsapp.net', '971500009999', 'Old Name')`);
    const items = [
      { jid: "971500009999@s.whatsapp.net", name: "New Name", phoneNumber: "971500009999", conversation: { lastMessageAt: new Date(1_790_000_000_000) } },
      { jid: "555@lid", lid: "555@lid", name: "Lid Person" }, // lid-only first...
      { jid: "971500008888@s.whatsapp.net", lid: "555@lid", phoneNumber: "971500008888", name: "Lid Person" }, // ...then its phone form
      ...Array.from({ length: 120 }, (_, i) => ({ jid: `9715011${String(i).padStart(5, "0")}@s.whatsapp.net`, name: `P${i}`, conversation: { lastMessageAt: null } })),
    ];
    const first = await bulkUpsertContacts(ctx.db, "ws1", "s1", items);
    expect(first.failed).toBe(0);
    expect(first.created).toBe(121); // lid person + 120 (the phone form merged into the lid row)
    const count = (q: string) => (raw.prepare(q).get() as any).n as number;
    expect(count(`SELECT count(*) n FROM contacts WHERE wa_session_id = 's1'`)).toBe(122);
    expect((raw.prepare(`SELECT name FROM contacts WHERE id = 'old'`).get() as any).name).toBe("New Name");
    const lidRow = raw.prepare(`SELECT jid, phone_number p FROM contacts WHERE lid = '555@lid'`).get() as any;
    expect(lidRow).toEqual({ jid: "971500008888@s.whatsapp.net", p: "971500008888" }); // upgraded to the phone jid
    expect(count(`SELECT count(*) n FROM conversations WHERE wa_session_id = 's1'`)).toBe(121);
    // Re-sync of the same data touches nothing.
    const again = await bulkUpsertContacts(ctx.db, "ws1", "s1", items);
    expect(again).toEqual({ created: 0, updated: 0, unchanged: items.length, failed: 0 });
    expect(count(`SELECT count(*) n FROM conversations WHERE wa_session_id = 's1'`)).toBe(121);
    expect(count(`SELECT n FROM entity_counts WHERE scope_id = 'ws1' AND name = 'contacts'`)).toBe(122);
  });
});

describe.skipIf(!sqlite)("auto-reply / access rules are tenant-isolated", () => {
  it("a workspace-wide rule never fires for another workspace's session", async () => {
    const { findAutoReply, isBlocked } = await import("../automation");
    const { db, raw } = makeDb();
    raw.exec(`INSERT INTO organization (id, name, slug, created_at) VALUES ('ws2', 'other', 'other', 0)`);
    raw.exec(`INSERT INTO wa_sessions (id, workspace_id, label) VALUES ('s2', 'ws2', 'theirs')`);
    // ws1: workspace-wide (wa_session_id NULL) rule + blacklist
    raw.exec(`INSERT INTO auto_reply_rules (id, workspace_id, wa_session_id, keyword, reply_text) VALUES ('r1', 'ws1', NULL, 'price', 'ws1 secret reply')`);
    raw.exec(`INSERT INTO access_rules (id, workspace_id, wa_session_id, list_type, scope, jid) VALUES ('a1', 'ws1', NULL, 'blacklist', 'auto_reply', 'x@s.whatsapp.net')`);
    const ctx = { isGroup: false, body: "what is the price?", senderJid: "y@s.whatsapp.net" };
    expect(await findAutoReply(db, "ws1", "s1", ctx)).toBe("ws1 secret reply");
    expect(await findAutoReply(db, "ws2", "s2", ctx)).toBeNull();
    expect(await isBlocked(db, "ws1", "s1", "auto_reply", "x@s.whatsapp.net")).toBe(true);
    expect(await isBlocked(db, "ws2", "s2", "auto_reply", "x@s.whatsapp.net")).toBe(false);
  });
});
