# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, etc.) and human contributors working in this repo. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first for the big picture.

## Project in one paragraph

Replyloom: a self-hosted WhatsApp CRM on Cloudflare. `apps/web` (TanStack Start) is the CRM UI and its server functions. `apps/worker` is the WhatsApp engine: Baileys running inside one Durable Object per linked number, plus the broadcast queue consumer, the Scheduler DO and the AI agent. `packages/db` holds the shared Drizzle schema and migrations for D1. `packages/ui` holds the shared shadcn/ui components. Package manager is **pnpm** and the monorepo runs on **Turborepo**. Use Node 22+.

## Commands

```bash
pnpm install
pnpm dev                                   # web :3000 + engine :8787
pnpm seed:demo                             # fictional demo data into the LOCAL D1 (see README)
pnpm typecheck                             # all packages
pnpm lint
pnpm --filter worker test                  # vitest (includes real-SQLite integration tests)
pnpm --filter web test
pnpm --filter @workspace/db generate       # drizzle-kit migration after schema change
bash scripts/check-patches.sh              # Baileys patch still applies
cd apps/web && npx wrangler d1 migrations apply whatsapp-ai --local
```

Before calling a change done, run typecheck, lint and the tests for every package you touched. CI runs lint, typecheck, test, build and check-patches.

## Hard rules

1. **Tenant isolation.** Every server function must resolve the workspace with `requireCurrentWorkspaceId()` (`apps/web/src/lib/auth.ts`), and every query or update by id must **also** filter by `workspace_id`. Never trust a `workspaceId`, `userId` or `userEmail` sent by the client. Engine routes must check that the caller's workspace owns the session.
2. **No polling.** Live updates go over the engine WebSocket (`features/realtime`) and patch the TanStack Query cache. Don't add `refetchInterval`, `setInterval` fetch loops or cron-style scans. Scheduled work goes through the `Scheduler` DO alarm.
3. **Anti-spam limits are product features, not bugs.** Don't weaken or bypass the broadcast limits (contact-list-only, ceiling, warm-up cap, cooldown, random gaps, circuit breakers, STOP suppression, required personalization) or the outbound guard (`apps/worker/src/session/outbound-guard.ts`: pace, new-chat daily cap, auto-reply loop breakers). The send *kind* is decided by the server. **Never** implement proxy/IP rotation, fingerprint spoofing, text spinning or anything else meant to evade WhatsApp's detection.
4. **Scale-conscious queries.** No unbounded `SELECT`s, no `OFFSET` pagination, no `count(*)` for UI totals (see the gotchas below). Keep D1 round trips low: use `db.batch`, and `json_each` for bulk (D1 caps a statement at 100 bound params).
5. **Secrets.** Never commit `.dev.vars` or real keys. Never commit `apps/*/wrangler.jsonc` or `apps/web/.env.production` (gitignored, per-deployment); change the `*.example` templates instead. No personal ids, domains or DSNs in tracked files. Never log or return credentials. Error messages to clients go through the public-message helpers.

## UI conventions

- **Sheets (side panels) are the standard** for create/edit/detail flows, not modals. Use a dialog only for short confirmations.
- Broadcasts are sent to **contact lists**, and contact lists live as a **tab inside the Contacts page**, not a separate top-level page.
- Every list uses cursor pagination with `components/load-more-button.tsx` and shows the exact total ("Showing 25 of 1,240").
- Put new UI primitives in `packages/ui` via `pnpm dlx shadcn@latest add <c> -c apps/web`.
- Put feature code in `apps/web/src/features/<feature>/{components,hooks,lib}`. Routes stay thin.

## Baileys

- It's pinned to `7.0.0-rc14` and patched (`apps/worker/patches/`). If you touch the version, regenerate the patch and run `scripts/check-patches.sh`.
- `ws` is aliased to `src/compat/ws-shim.ts`. Don't import Node-only modules into the worker without checking `nodejs_compat` support.
- Keep Durable Object work inside Workers CPU limits: batch history sync and don't turn on `syncFullHistory`.

## Database migrations

- Migrations `0004_kind_catseye.sql` through `0007_media_assets.sql` were hand-written; their snapshots are backfilled via the no-op `0008_modern_newton_destine.sql` (its `0008_snapshot.json` is the regenerated full schema). The snapshot is in sync today — confirmed by `pnpm generate` reporting no changes.
- After any (hand-written or generated) migration, apply it to the local D1 database before the app works:
  ```bash
  cd apps/web
  npx wrangler d1 migrations apply whatsapp-ai --local
  ```
  Add `--remote` when deploying.

## Counters, pagination and index gotchas

- **Exact totals live in `entity_counts`**, maintained by SQLite triggers created in `0031_entity_counts.sql` (hand-appended; drizzle-kit doesn't model triggers). Read them through `apps/web/src/lib/counts.ts` (`readCount` / `readCounts`); never `count(*)` a big table for a UI total. Search totals use `cappedCount` (stops at 10,000 → "10,000+").
- **SQLite drops a table's triggers when the table is dropped.** If a generated migration rebuilds a counted table (`__new_<table>` copy + rename), re-create that table's `trg_counts_*` triggers in the same migration. `apps/worker/src/__tests__/sync-batch.test.ts` asserts all 27 exist and that counters match `count(*)`.
- Adding a new counter: add AI/AD(/AU) triggers + a backfill in a new migration, and a name in `COUNTER` (lib/counts.ts). Decrements must be `UPDATE` (never upsert) so a cascade after a scope's cleanup can't create negative orphans.
- **List endpoints are cursor (keyset) paginated** via `apps/web/src/lib/cursor.ts`: fetch `limit + 1`, predicate `(sortCol, id) < (?, ?)` on an index whose columns are exactly `(…equality cols, sortCol DESC, id DESC)`. Return `total`/`totalCapped` on the first page only. No `OFFSET`.
- Sorting on an expression (e.g. `last_message_at` with NULLs): index the expression and use `k <= :k AND (k < :k OR id < :id)` — SQLite won't range-seek a row-value comparison on expression columns.
- **drizzle-kit splits index expressions at commas** (`coalesce(x, 0)` → broken SQL). Write comma-free expressions (`CASE WHEN x IS NULL THEN 0 ELSE x END`). Index expressions must use unqualified column names.
