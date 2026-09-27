#!/usr/bin/env node
// Fills a LOCAL D1 database with a realistic, entirely fictional demo
// workspace ("Lumen & Oak Interiors"): three WhatsApp numbers, contacts,
// direct + group chats, a deal pipeline, tags, notes, contact lists,
// broadcasts, templates, auto-replies and an AI agent config. Made for
// screenshots, demos and UI work. No real people, no real phone numbers
// (every number is in the fictional +1 555-01xx range).
//
// Usage (from the repo root, after `pnpm install`):
//   0. in apps/web/wrangler.jsonc set the DB binding to "remote": false
//   1. pnpm dev                        # or just the web app
//   2. sign up in the browser          # creates your user + workspace
//   3. pnpm seed:demo [--email you@example.com]
//
// Re-running replaces the previous demo data (ids are prefixed `demo_`).
// It only ever touches the local database (`wrangler d1 execute --local`);
// there is intentionally no --remote flag.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "apps/web");
const DB = "whatsapp-ai";

const args = process.argv.slice(2);
const emailArg = args.includes("--email") ? args[args.indexOf("--email") + 1] : null;
if (args.includes("--remote")) {
  console.error("seed-demo only writes to the local database. Refusing --remote.");
  process.exit(1);
}

// The app only sees this data if its dev config reads the LOCAL database.
// The template sets "remote": true on D1 (so web + engine share one DB in
// dev), in which case the app would read your real Cloudflare D1 instead.
try {
  const cfg = readFileSync(join(webDir, "wrangler.jsonc"), "utf8");
  const d1Line = cfg.split("\n").find((l) => l.includes('"binding": "DB"')) ?? "";
  if (/"remote":\s*true/.test(d1Line)) {
    console.error(
      'apps/web/wrangler.jsonc has "remote": true on the DB binding, so the app reads your real D1, not the local one.\n' +
        'For demo data, set it to "remote": false (web only is enough), restart `pnpm dev`, sign up, then run this again.',
    );
    process.exit(1);
  }
} catch {
  // no config yet: `pnpm install` creates it
}

function d1(argv) {
  return execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", DB, "--local", ...argv], {
    cwd: webDir,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function query(sql) {
  const out = d1(["--json", "--command", sql]);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

// ── Find the target workspace ─────────────────────────────────────────────
const who = query(
  `SELECT u.id AS userId, u.email, m.organization_id AS workspaceId
     FROM user u JOIN member m ON m.user_id = u.id
    ${emailArg ? `WHERE u.email = '${emailArg.replace(/'/g, "''")}'` : ""}
    ORDER BY u.created_at ASC LIMIT 1`,
);
if (!who.length) {
  console.error(
    emailArg
      ? `No user with email ${emailArg} in the local database. Sign up in the app first.`
      : "No users in the local database yet. Run the app, sign up, then run this again.",
  );
  process.exit(1);
}
const { userId, email, workspaceId: W } = who[0];
console.log(`Seeding demo data into ${email}'s workspace (${W})...`);

// ── Helpers ───────────────────────────────────────────────────────────────
const q = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "1" : "0") : `'${String(v).replace(/'/g, "''")}'`;
const rows = [];
const insert = (table, obj) =>
  rows.push(`INSERT INTO ${table} (${Object.keys(obj).join(", ")}) VALUES (${Object.values(obj).map(q).join(", ")});`);
const NOW = Math.floor(Date.now() / 1000);
const MIN = 60, HOUR = 3600, DAY = 86400;
const ago = (s) => NOW - s;
const jid = (n) => `${n}@s.whatsapp.net`;

// ── Clean previous demo data (FK cascades remove the children) ────────────
rows.push(
  `DELETE FROM broadcast_campaigns WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM contact_lists WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM deals WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM pipeline_stages WHERE workspace_id = ${q(W)};`,
  `DELETE FROM tags WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM templates WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM auto_reply_rules WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM doc_chunks WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
  `DELETE FROM agent_configs WHERE workspace_id = ${q(W)};`,
  `DELETE FROM wa_sessions WHERE workspace_id = ${q(W)} AND id LIKE 'demo_%';`,
);

// ── Workspace ────────────────────────────────────────────────────────────
rows.push(`UPDATE organization SET name = 'Lumen & Oak Interiors' WHERE id = ${q(W)};`);

// ── WhatsApp numbers ─────────────────────────────────────────────────────
const sessions = [
  { id: "demo_s_sales", label: "Sales", phone: "15550100001" },
  { id: "demo_s_support", label: "Client care", phone: "15550100002" },
  { id: "demo_s_studio", label: "Studio ops", phone: "15550100003" },
];
for (const s of sessions) {
  insert("wa_sessions", {
    id: s.id, workspace_id: W, label: s.label, phone_number: `+${s.phone}`, connected_jid: jid(s.phone),
    status: "connected", created_at: ago(40 * DAY), updated_at: ago(5 * MIN),
    daily_broadcast_count: 0, consecutive_failures: 0,
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────
const tags = {
  vip: { id: "demo_t_vip", name: "VIP", color: "#f59e0b" },
  trade: { id: "demo_t_trade", name: "Trade partner", color: "#6366f1" },
  lead: { id: "demo_t_lead", name: "New lead", color: "#22c55e" },
  follow: { id: "demo_t_follow", name: "Follow up", color: "#ef4444" },
  reno: { id: "demo_t_reno", name: "Renovation", color: "#0ea5e9" },
};
for (const t of Object.values(tags)) insert("tags", { ...t, workspace_id: W, created_at: ago(30 * DAY) });

// ── Contacts ─────────────────────────────────────────────────────────────
// [key, name, session, stage, tags, company, city]
const people = [
  ["maya", "Maya Alvarez", "sales", "lead", ["lead", "reno"], "Alvarez Residence", "Austin"],
  ["kofi", "Kofi Owusu", "sales", "customer", ["vip"], "Owusu & Partners", "Accra"],
  ["sara", "Sara Novak", "support", "customer", ["vip", "reno"], "Novak Loft", "Prague"],
  ["daniel", "Daniel Kim", "sales", "active", ["follow"], "Kim Dental Clinic", "Seattle"],
  ["priya", "Priya Menon", "sales", "lead", ["lead"], "Menon Villa", "Kochi"],
  ["lucas", "Lucas Moreau", "support", "customer", [], "Café Moreau", "Lyon"],
  ["amara", "Amara Obi", "sales", "active", ["reno"], "Obi Townhouse", "Lagos"],
  ["hana", "Hana Sato", "support", "customer", ["vip"], "Sato Ryokan", "Kyoto"],
  ["omar", "Omar Haddad", "sales", "lead", ["lead", "follow"], "Haddad Offices", "Dubai"],
  ["elena", "Elena Rossi", "studio", "customer", ["trade"], "Rossi Tiles", "Milan"],
  ["ben", "Ben Carter", "studio", "customer", ["trade"], "Carter Joinery", "Leeds"],
  ["zoe", "Zoe Lindqvist", "support", "churned", [], "Lindqvist Flat", "Stockholm"],
  ["ravi", "Ravi Shah", "sales", "active", ["follow"], "Shah Boutique Hotel", "Jaipur"],
  ["noor", "Noor Al-Amin", "sales", "lead", ["lead"], "Al-Amin Majlis", "Doha"],
  ["tomas", "Tomás Silva", "studio", "customer", ["trade"], "Silva Lighting", "Lisbon"],
  ["grace", "Grace Wu", "support", "active", ["reno"], "Wu Family Home", "Singapore"],
  ["felix", "Felix Wagner", "sales", "lead", [], "Wagner Architects", "Berlin"],
  ["leila", "Leila Karimi", "support", "customer", ["vip"], "Karimi Penthouse", "Toronto"],
  ["jonas", "Jonas Berg", "studio", "active", [], "Berg Upholstery", "Oslo"],
  ["ana", "Ana Pereira", "sales", "active", ["reno", "follow"], "Pereira Beach House", "Porto"],
  ["mateo", "Mateo Ruiz", "studio", "customer", ["trade"], "Ruiz Stoneworks", "Valencia"],
  ["chloe", "Chloé Martin", "support", "lead", ["lead"], "Martin Apartment", "Paris"],
  ["yusuf", "Yusuf Demir", "sales", "active", [], "Demir Co-working", "Istanbul"],
  ["ivy", "Ivy Chen", "support", "customer", [], "Chen Studio Flat", "Vancouver"],
];
const contacts = {};
people.forEach(([key, name, sess, stage, tagKeys, company, city], i) => {
  const phone = `1555010${String(1000 + i * 37).padStart(4, "0")}`;
  const id = `demo_c_${key}`;
  contacts[key] = { id, name, phone, session: `demo_s_${sess}` };
  insert("contacts", {
    id, workspace_id: W, wa_session_id: `demo_s_${sess}`, jid: jid(phone), phone_number: `+${phone}`, name,
    custom_fields: JSON.stringify({ organizationName: company, city }),
    lifecycle_stage: stage, assigned_to: i % 3 === 0 ? userId : null,
    last_contacted_at: ago((i + 1) * 3 * HOUR), pinned_at: key === "kofi" || key === "sara" ? ago(10 * DAY) : null,
    blocked: false, do_not_broadcast: key === "zoe", do_not_broadcast_reason: key === "zoe" ? "opted_out" : null,
    do_not_broadcast_at: key === "zoe" ? ago(12 * DAY) : null,
    created_at: ago((60 - i) * DAY), updated_at: ago(i * HOUR),
  });
  for (const t of tagKeys) insert("contact_tags", { contact_id: id, tag_id: tags[t].id });
});

// ── Direct conversations ─────────────────────────────────────────────────
// Each message: [direction, text, minutesAgo, status?]
const threads = {
  maya: { unread: 2, msgs: [
    ["in", "Hi! Found you on Instagram 👋 We just bought a 1970s bungalow and want to redo the living room + kitchen.", 190],
    ["out", "Hi Maya, congrats on the new place! Happy to help. Roughly what size are the two rooms, and do you have a budget in mind?", 180, "read"],
    ["in", "About 45 m² together. Thinking $25–30k all in.", 170],
    ["out", "That works well for a full refresh. I can come by for a free site visit. Does Thursday 10am or Friday 3pm suit you?", 160, "read"],
    ["in", "Friday 3pm is perfect", 25],
    ["in", "Is the spring design package still on offer this week?", 18],
  ]},
  kofi: { unread: 1, msgs: [
    ["out", "Hi Kofi, attached is the revised quote for the reception area: walnut slats, brass fixtures, and the acoustic panels you asked for.", 26 * 60, "read"],
    ["in", "Looks great. Partners approved it this morning.", 60 * 3],
    ["out", "Wonderful! I'll send the contract over for signature today.", 60 * 2.8, "read"],
    ["in", "Sent the signed quote 👍", 29],
  ]},
  sara: { unread: 0, msgs: [
    ["in", "The pendant light over the dining table flickers when the dimmer is below 30%", 60 * 30],
    ["out", "Sorry about that, Sara! That's usually a driver mismatch. Our electrician Tomás can swap it Tuesday morning, no charge.", 60 * 29.5, "read"],
    ["in", "Tuesday works", 60 * 29],
    ["out", "Booked for Tuesday 9–11am ✅", 60 * 28.8, "read"],
    ["in", "Thanks, that fixed it! The whole loft feels finished now.", 60 * 4],
    ["out", "So glad to hear it! Would you mind if we featured a couple of photos in our portfolio?", 60 * 3.9, "delivered"],
  ]},
  daniel: { unread: 0, msgs: [
    ["out", "Hi Daniel, following up on the waiting room concept. Any feedback from the team?", 60 * 50, "read"],
    ["in", "They loved option B with the softer greens. Can we see it with oak instead of ash?", 60 * 6],
    ["out", "Absolutely. I'll have the updated render to you by tomorrow noon.", 60 * 5.5, "read"],
  ]},
  priya: { unread: 3, msgs: [
    ["in", "Hello, do you take projects in Kerala? It's a 3BHK villa in Kochi.", 95],
    ["in", "We're looking at mostly teak and handloom textiles, fairly traditional", 94],
    ["in", "Can share floor plans if helpful", 93],
  ]},
  lucas: { unread: 0, msgs: [
    ["in", "Bonjour! The new banquette seating arrived. Customers love it already", 60 * 72],
    ["out", "Merci Lucas! Send us a photo when the café is busy, we'd love to see it in action ☕", 60 * 71, "read"],
  ]},
  amara: { unread: 0, msgs: [
    ["out", "Hi Amara, here's the moodboard for the townhouse: warm terracotta, rattan, and lots of plants.", 60 * 8, "read"],
    ["in", "Obsessed with this. Can we add a reading nook by the stairs?", 60 * 7],
    ["out", "Love that idea. I'll sketch two options.", 60 * 6.8, "delivered"],
  ]},
  hana: { unread: 0, msgs: [
    ["in", "The tatami room is finished. Guests are already booking it first 🙏", 60 * 26],
    ["out", "That makes our week, Hana. Thank you for trusting us with it.", 60 * 25, "read"],
  ]},
  omar: { unread: 1, msgs: [
    ["in", "We need a fit-out for a 400 m² office in Business Bay. Timeline is tight, 10 weeks.", 60 * 2],
    ["out", "Hi Omar, 10 weeks is doable if we lock the design in the first 2. Can you share the floor plan?", 60 * 1.8, "read"],
    ["in", "Sharing it now. Also need a quote for furniture separately", 55],
  ]},
  elena: { unread: 0, msgs: [
    ["out", "Ciao Elena, can you hold 60 m² of the sage zellige for the Alvarez kitchen?", 60 * 20, "read"],
    ["in", "Held until Friday. Shipping to Austin takes ~3 weeks.", 60 * 19],
  ]},
  ben: { unread: 0, msgs: [
    ["in", "Walnut slats for Owusu & Partners are cut. Ready for install Monday.", 60 * 9],
    ["out", "Perfect timing, Ben. Team will be on site at 8.", 60 * 8.9, "read"],
  ]},
  ravi: { unread: 0, msgs: [
    ["out", "Namaste Ravi, the lobby lighting samples are on their way to Jaipur.", 60 * 34, "read"],
    ["in", "Received! The brass lanterns are stunning.", 60 * 12],
  ]},
  noor: { unread: 1, msgs: [
    ["in", "Salam, do you design majlis spaces? Looking for something modern but warm.", 40],
  ]},
  grace: { unread: 0, msgs: [
    ["in", "Could we move the kids' room install to next week?", 60 * 15],
    ["out", "Of course, Grace. Moved to Wednesday 10am.", 60 * 14.5, "read"],
  ]},
  leila: { unread: 0, msgs: [
    ["out", "Hi Leila, the custom sofa ships from Oslo on the 14th 🛋️", 60 * 44, "read"],
    ["in", "Can't wait. The penthouse is almost done!", 60 * 43],
  ]},
  ana: { unread: 0, msgs: [
    ["in", "What's the lead time on the rattan pendants?", 60 * 11],
    ["out", "About 4 weeks. Want me to reserve four?", 60 * 10.5, "read"],
    ["in", "Yes please", 60 * 10],
  ]},
};
let convN = 0;
for (const [key, t] of Object.entries(threads)) {
  const c = contacts[key];
  const cid = `demo_cv_${key}`;
  const last = t.msgs[t.msgs.length - 1];
  insert("conversations", {
    id: cid, workspace_id: W, wa_session_id: c.session, kind: "direct", contact_id: c.id,
    status: t.unread ? "open" : "resolved", assigned_to: convN % 2 === 0 ? userId : null, unread_count: t.unread,
    last_message_at: ago(last[2] * MIN), last_body: last[1], last_type: "text", last_direction: last[0],
    pinned_at: key === "kofi" ? ago(2 * DAY) : null, archived: false, muted: false, created_at: ago(t.msgs[0][2] * MIN + DAY),
  });
  t.msgs.forEach(([dir, body, m, status], i) => {
    insert("messages", {
      id: `demo_m_${key}_${i}`, workspace_id: W, conversation_id: cid, wa_message_id: `DEMO${convN}X${i}`,
      direction: dir, sender_jid: dir === "in" ? jid(c.phone) : null, type: "text", body,
      status: dir === "in" ? (i >= t.msgs.length - t.unread ? "delivered" : "read") : status ?? "read",
      deleted: false, created_at: ago(m * MIN),
    });
  });
  convN++;
}

// ── Groups ───────────────────────────────────────────────────────────────
const groupDefs = [
  { key: "site", name: "Owusu fit-out · site team", session: "demo_s_studio", members: ["kofi", "ben", "tomas"], unread: 4, msgs: [
    ["ben", "Slats are up on the north wall", 70], ["tomas", "Lighting track goes in after lunch", 62],
    [null, "Great progress! Sending the client a photo update tonight.", 58], ["kofi", "Looks incredible already 🔥", 20],
  ]},
  { key: "suppliers", name: "Lumen & Oak · trade partners", session: "demo_s_studio", members: ["elena", "mateo", "jonas", "tomas"], unread: 0, msgs: [
    ["mateo", "Travertine restock lands next Tuesday", 60 * 5], [null, "Thanks Mateo, reserving 2 slabs for the Novak job.", 60 * 4.8],
    ["jonas", "Boucle fabric back in stock in all 4 colours", 60 * 3],
  ]},
  { key: "lisbon", name: "Porto beach house 🌊", session: "demo_s_sales", members: ["ana", "tomas"], unread: 0, msgs: [
    ["ana", "The contractor says the terrace tiles need 2 more days", 60 * 6], [null, "No problem, we'll shift styling to Thursday.", 60 * 5.9],
  ]},
];
for (const g of groupDefs) {
  const gid = `demo_g_${g.key}`;
  const gjid = `1203630${String(g.key.length * 7919).padStart(11, "0")}@g.us`;
  insert("groups", { id: gid, workspace_id: W, wa_session_id: g.session, jid: gjid, name: g.name, participant_count: g.members.length + 1, created_at: ago(20 * DAY), updated_at: ago(DAY) });
  g.members.forEach((m, i) =>
    insert("group_members", { id: `demo_gm_${g.key}_${i}`, workspace_id: W, wa_session_id: g.session, group_id: gid, contact_id: contacts[m].id, jid: jid(contacts[m].phone), role: i === 0 ? "admin" : "member", created_at: ago(20 * DAY) }),
  );
  const last = g.msgs[g.msgs.length - 1];
  const cid = `demo_cv_${g.key}`;
  insert("conversations", {
    id: cid, workspace_id: W, wa_session_id: g.session, kind: "group", group_id: gid, status: "open", unread_count: g.unread,
    last_message_at: ago(last[2] * MIN), last_body: last[1], last_type: "text", last_direction: last[0] ? "in" : "out",
    archived: false, muted: false, created_at: ago(20 * DAY),
  });
  g.msgs.forEach(([who, body, m], i) =>
    insert("messages", {
      id: `demo_m_${g.key}_${i}`, workspace_id: W, conversation_id: cid, wa_message_id: `DEMOG${g.key}${i}`,
      direction: who ? "in" : "out", sender_jid: who ? jid(contacts[who].phone) : null, type: "text", body,
      status: "read", deleted: false, created_at: ago(m * MIN),
    }),
  );
}

// ── Notes ────────────────────────────────────────────────────────────────
[["maya", "Site visit booked Fri 3pm. Loves warm woods, hates grey. Two dogs, so durable fabrics only."],
 ["kofi", "Signed. 50% deposit received. Install starts Monday."],
 ["omar", "Tight 10-week timeline. Decision maker is Omar himself. Wants furniture quoted separately."],
 ["daniel", "Prefers oak over ash. Clinic open Sat, so installs Sun only."]]
  .forEach(([k, body], i) => insert("notes", { id: `demo_n_${i}`, workspace_id: W, contact_id: contacts[k].id, author_id: userId, body, created_at: ago((i + 1) * 5 * HOUR) }));

// ── Pipeline ─────────────────────────────────────────────────────────────
const stages = [
  ["demo_st_new", "New inquiry", "#94a3b8"], ["demo_st_visit", "Site visit", "#3b82f6"],
  ["demo_st_proposal", "Proposal sent", "#8b5cf6"], ["demo_st_won", "Won", "#22c55e"], ["demo_st_lost", "Lost", "#ef4444"],
];
stages.forEach(([id, name, color], i) => insert("pipeline_stages", { id, workspace_id: W, name, position: i, color }));
[
  ["priya", "demo_st_new", "Kochi villa · full interior", 48000], ["noor", "demo_st_new", "Modern majlis design", 22000],
  ["felix", "demo_st_new", "Architect partnership", 9500], ["maya", "demo_st_visit", "Living room + kitchen refresh", 28000],
  ["omar", "demo_st_visit", "Business Bay office fit-out", 96000], ["amara", "demo_st_visit", "Townhouse styling", 14500],
  ["daniel", "demo_st_proposal", "Clinic waiting room", 18000], ["ravi", "demo_st_proposal", "Boutique hotel lobby", 62000],
  ["ana", "demo_st_proposal", "Beach house styling", 11200], ["kofi", "demo_st_won", "Reception area redesign", 4800 * 10],
  ["leila", "demo_st_won", "Penthouse living", 38500], ["hana", "demo_st_won", "Tatami guest room", 12000],
  ["zoe", "demo_st_lost", "Studio flat refresh", 6500],
].forEach(([k, stage, title, usd], i) =>
  insert("deals", { id: `demo_d_${i}`, workspace_id: W, contact_id: contacts[k].id, stage_id: stage, title, value_cents: usd * 100, currency: "USD", position: i, created_at: ago((20 - i) * DAY), updated_at: ago(i * HOUR) }),
);

// ── Contact lists + broadcasts ───────────────────────────────────────────
const lists = [
  ["demo_l_news", "Newsletter opt-ins", ["maya", "sara", "lucas", "hana", "leila", "grace", "ana", "amara", "ivy", "chloe", "yusuf", "ravi"]],
  ["demo_l_vip", "VIP clients", ["kofi", "sara", "hana", "leila"]],
  ["demo_l_trade", "Trade partners", ["elena", "ben", "tomas", "mateo", "jonas"]],
];
for (const [id, name, members] of lists) {
  insert("contact_lists", { id, workspace_id: W, name, created_by: userId, kind: "static", status: "active", last_used_at: id === "demo_l_news" ? ago(6 * DAY) : null, created_at: ago(25 * DAY) });
  members.forEach((m, i) => insert("contact_list_members", { id: `${id}_${i}`, list_id: id, contact_id: contacts[m].id, added_at: ago(24 * DAY), source: "manual", ownership: "owned" }));
}
insert("broadcast_campaigns", { id: "demo_b_autumn", workspace_id: W, wa_session_id: "demo_s_sales", name: "Autumn collection preview", message_text: "Hi {{name}}! Our autumn collection just landed: walnut, bouclé and warm brass. Reply YES for the lookbook 🍂", contact_list_id: "demo_l_news", resolved_recipient_count: 12, sent_count: 12, failed_count: 0, status: "completed", paused_for_failure_rate: false, created_at: ago(6 * DAY) });
insert("broadcast_campaigns", { id: "demo_b_vip", workspace_id: W, wa_session_id: "demo_s_support", name: "VIP studio evening invite", message_text: "Hi {{name}}, you're invited to a private evening at the studio on the 24th. Wine, new pieces, and good company. Can we save you a spot?", contact_list_id: "demo_l_vip", resolved_recipient_count: 4, sent_count: 0, failed_count: 0, status: "scheduled", scheduled_at: NOW + 3 * DAY, paused_for_failure_rate: false, created_at: ago(DAY) });
insert("broadcast_campaigns", { id: "demo_b_trade", workspace_id: W, wa_session_id: "demo_s_studio", name: "Q4 trade order window", message_text: "Hi {{name}}, our Q4 order window closes Friday. Send us your availability for next quarter.", contact_list_id: "demo_l_trade", resolved_recipient_count: 5, sent_count: 0, failed_count: 0, status: "draft", paused_for_failure_rate: false, created_at: ago(2 * HOUR) });

// ── Templates ────────────────────────────────────────────────────────────
[
  ["Site visit confirmation", "/visit", "Hi {{name}}, confirming your free site visit on {{date}}. Our designer will bring samples. See you then!"],
  ["Quote follow-up", "/quote", "Hi {{name}}, just checking you received the quote. Happy to walk through it on a quick call."],
  ["Install day reminder", "/install", "Hi {{name}}, reminder that our team arrives tomorrow at 8am. Please clear access to the rooms we're working in 🙏"],
  ["Review request", "/review", "Hi {{name}}, we loved working on your space! Would you leave us a short review? It helps a small studio like ours a lot."],
].forEach(([name, shortcut, body], i) => insert("templates", { id: `demo_tp_${i}`, workspace_id: W, name, shortcut, body, usage_count: [42, 31, 18, 9][i], created_at: ago(30 * DAY), updated_at: ago(i * DAY) }));

// ── Auto-replies ─────────────────────────────────────────────────────────
[
  ["hours", "contains", "We're open Mon–Sat, 9am–6pm. Visits by appointment. Reply VISIT to book one!"],
  ["visit", "exact", "Great! Pick a slot here and we'll confirm on WhatsApp: Mon–Sat, 10am–5pm."],
  ["price|pricing|cost", "regex", "Most room refreshes land between $8k and $30k. Send us a few photos and we'll give you a free estimate."],
].forEach(([keyword, match_type, reply_text], i) => insert("auto_reply_rules", { id: `demo_ar_${i}`, workspace_id: W, keyword, match_type, context: "private", reply_text, priority: i, enabled: true, created_at: ago(20 * DAY) }));

// ── AI agent ─────────────────────────────────────────────────────────────
insert("agent_configs", {
  workspace_id: W, enabled: true, business_name: "Lumen & Oak Interiors",
  scope_description: "Interior design studio. Answer questions about services, pricing ranges, lead times, visits and materials. Hand off quotes and complaints to a designer.",
  max_context_chunks: 4, cache_ttl_seconds: 3600, reply_in_groups: false, created_at: ago(15 * DAY), updated_at: ago(DAY),
});
[
  ["services.md", "We design residential and hospitality interiors: full renovations, room refreshes, styling and custom furniture."],
  ["pricing.md", "Room refreshes typically cost $8k–$30k. Full renovations start at $45k. Site visits and first estimates are free."],
  ["lead-times.md", "Custom sofas: 6–8 weeks. Lighting: 3–4 weeks. Tiles from Italy: about 3 weeks to ship."],
].forEach(([source, text], i) => insert("doc_chunks", { id: `demo_dc_${i}`, workspace_id: W, doc_id: `demo_doc_${i}`, source, text, created_at: ago(15 * DAY) }));

// ── Write + execute ──────────────────────────────────────────────────────
const file = join(mkdtempSync(join(tmpdir(), "seed-demo-")), "seed.sql");
writeFileSync(file, rows.join("\n") + "\n");
d1(["--file", file]);
console.log(`Done: ${sessions.length} numbers, ${people.length} contacts, ${Object.keys(threads).length + groupDefs.length} chats, 13 deals, ${lists.length} lists, 3 broadcasts.`);
console.log("Reload the app to see Lumen & Oak Interiors.");
