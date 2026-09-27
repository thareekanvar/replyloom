# Architecture

Replyloom is two Cloudflare Workers that share one D1 database. Everything runs on Cloudflare: there's no VPS, no external database and no long-running Node process.

```
                    ┌──────────────────────── Browser ─────────────────────────┐
                    │  TanStack Start UI (React)                               │
                    └──────┬───────────────────────────────▲───────────────────┘
          server fns (HTTP)│                               │ WebSocket (HMAC token)
                           ▼                               │
┌──────────── apps/web (Worker) ───────────┐     ┌─────────┴────── apps/worker (Worker) ─────────────────┐
│ SSR + server functions                   │     │ router (index.ts): auth, rate limits, CORS            │
│ Better Auth (sessions, orgs, invites)    │     │                                                       │
│ workspace-scoped queries (Drizzle)       │────►│ WhatsAppSession DO ×N  (one per linked number)        │
│ service binding WA_WORKER ───────────────┼─────│   Baileys socket ⇄ WhatsApp servers                   │
└──────┬──────────────────────┬────────────┘     │   auth state in DO SQLite, outbound guard, WS fan-out │
       │                      │                  │ Scheduler DO (one global alarm)                       │
       │                      │                  │ Queue consumer (broadcast dispatch)                   │
       │                      │                  │ AI agent (Workers AI via AI Gateway, Vectorize, KV)   │
       ▼                      ▼                  └───────┬──────────────┬──────────────┬─────────────────┘
   ┌───────┐              ┌──────┐                       │              │              │
   │  D1   │◄─────────────┼──────┼───────────────────────┘              ▼              ▼
   │SQLite │              │  R2  │◄──────────────────────────────── media        Vectorize / KV
   └───────┘              └──────┘
```

## Workspaces

| Package | Role |
|---|---|
| `apps/web` | The CRM. TanStack Start (SSR + server functions), React 19, TanStack Query, Better Auth, shadcn/ui. Code is split by feature in `src/features/*` (inbox, contacts, contact-lists, broadcasts, pipeline, templates, agent, integrations, …). |
| `apps/worker` | The WhatsApp engine. HTTP router, `WhatsAppSession` and `Scheduler` Durable Objects, the broadcast queue consumer, the cron trigger, the AI agent, search and media. |
| `packages/db` | The single source of truth for the schema (Drizzle) and SQL migrations (`packages/db/migrations`), used by both apps. |
| `packages/ui` | Shared shadcn/ui components (`@workspace/ui/components/*`). |

The two apps are **separate Workers on purpose**: you can deploy or roll back the engine without taking the CRM down, and the other way round. `apps/web` calls the engine over a **service binding** (`WA_WORKER`) authenticated with `ENGINE_INTERNAL_SECRET`. External integrations call the engine's public URL with a workspace **API key**.

## Storage

| Store | Used for |
|---|---|
| **D1** (`DB`) | Everything relational: users, orgs, sessions, contacts, conversations, messages, lists, campaigns, deals, templates, webhooks, API keys, `entity_counts`. |
| **Durable Object SQLite** | Per-number Baileys auth state (`wa_creds`, `wa_keys`) and per-session counters (pace buckets, daily caps). |
| **R2** (`MEDIA`) | Inbound/outbound media and the media library. |
| **Queues** (`BROADCAST_QUEUE`) | Broadcast dispatch, one message per recipient batch, with delays. |
| **Vectorize** | `wa-messages` (semantic message search) and `wa-docs` (AI agent knowledge), 1024-dim `@cf/baai/bge-m3`. |
| **KV** (`REPLY_CACHE`) | AI agent answer cache, config cache and per-conversation rate limits. |

## Main flows

### Linking a number
The UI creates a session and opens `/session/:id/connect` on the engine. The `WhatsAppSession` DO starts Baileys, sends QR codes to the browser over its WebSocket, and stores credentials in DO SQLite once the QR is scanned. When the DO wakes up after hibernation or eviction, it reconnects from the stored credentials. A watchdog reconnects with jitter and backoff.

### Inbound message
`messages.upsert` in the DO → `session/message-events.ts`:
1. Upserts the contact, conversation and message in D1 (`db/sync/*`, one `db.batch` per message, resolver cache).
2. Downloads media to R2.
3. Pushes the event to every connected browser over the DO's WebSocket.
4. In the background: signed **webhooks** (`message.received`), **semantic indexing**, then a **keyword auto-reply**, or the **AI agent** if no rule matched. Replies pass through the loop breakers.

### Outbound message
UI → server function (workspace-scoped) → service binding → engine router (checks the caller and that the workspace owns the session) → DO → **outbound guard** (`session/outbound-guard.ts`) → Baileys `sendMessage`. The server decides the send *kind* (`manual`, `api`, `broadcast`, `scheduled`, `auto`) and the client can't override it.

### Broadcast
Recipients come **only** from contact lists. `startCampaign` checks the ceiling, warm-up cap, cooldown and suppression list, then enqueues with `Queue.sendBatch`. The consumer sends one recipient at a time with 15–45 s random gaps, updates counters atomically, and trips the campaign or session **circuit breaker** on failure spikes. Progress is streamed to the UI over the same WebSocket.

### Scheduled work
A single `Scheduler` DO sets one alarm for the soonest pending item (scheduled message, scheduled campaign or webhook retry), dispatches everything that's due, then sets the next alarm. The `*/5` cron only pokes the Scheduler as a safety net. There's one writer, so nothing gets sent twice.

### Realtime
The browser asks the web app for a short-lived **HMAC token** (`WS_TOKEN_SECRET`), then opens a WebSocket straight to the engine at `/session/:id/ws`. The DO pushes messages, receipts, QR codes, connection state and campaign progress. **The app never polls.** All live updates go over this socket and patch the TanStack Query cache.

### AI agent (optional)
`ai-agent/`: intent gate → RAG over `wa-docs` → tool calls (customer lookup, recent conversation, deals, your webhooks) → grounded reply, or a hand-off to the human queue. Guardrails block coding requests and secret leaks and redact credentials. All model calls go through **AI Gateway**, tagged per workspace, with a fallback model.

## Security model

- **Tenant isolation**: every server function resolves the workspace from the authenticated session (`requireCurrentWorkspaceId()`), and every query filters by `workspace_id`. Taking an id alone is never enough.
- **Engine auth**: internal secret (web → engine) or a hashed workspace API key (external callers). `/internal/*` DO routes can't be reached from outside.
- **Rate limits**: Workers rate-limit bindings on the API, auth and web routes.
- **Media**: MIME allow-list, size caps and safe response headers. **Outbound URLs** (webhooks, agent tools) are checked against SSRF.
- **Sentry**: optional, with scrubbing of PII and secrets.

## Performance notes

- **Keyset (cursor) pagination** everywhere (`apps/web/src/lib/cursor.ts`). No `OFFSET`.
- **Exact totals** come from the `entity_counts` table, which SQLite triggers keep up to date (migration `0031`). Reading a total is a single primary-key lookup.
- Hot paths are covered by partial and expression indexes. See [AGENTS.md](./AGENTS.md) for the rules.
- D1 limits to keep in mind: 100 bound parameters per statement (use `json_each` for bulk), 10 GB per database, a single writer. One self-hosted install serving one business is well within these.

## Baileys on Workers

Baileys expects Node. Three changes make it run on Workers:

- `ws` is aliased to a shim built on Workers' outbound WebSocket (`src/compat/ws-shim.ts`). Its `close()` always settles, so reconnects can't hang.
- `patches/@whiskeysockets+baileys+7.0.0-rc14.patch` replaces AES-GCM with `@noble/ciphers` (workerd's GCM encrypt is broken) and guards an upstream ack crash. It's applied by `patch-package` on install, and CI checks it with `scripts/check-patches.sh`.
- `syncFullHistory` is off, and history sync is batched, to stay within CPU limits.

Baileys is pinned to an exact version. Upgrading it means re-checking the patch.
