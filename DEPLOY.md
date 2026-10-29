# Deploying

This app is two Cloudflare Workers (`apps/worker`, the WhatsApp engine; `apps/web`, the CRM) sharing one D1 database. `pnpm setup` + `pnpm deploy` handle the whole thing, but here's what they do, in case you want to run any step by hand, use a CI pipeline instead, or something doesn't go as expected.

## Prerequisites

- A Cloudflare account (the free tier works for trying this out; Durable Objects, Queues, and Vectorize all have free tier allowances but check current limits for production use).
- Node 22+ and pnpm (`corepack enable` is enough — this repo pins the pnpm version).
- `pnpm exec wrangler login` — the setup/deploy scripts run as you, against your account.

## Config files (not in git)

Per-deployment config is kept out of the repo so nobody's Cloudflare ids or domains get committed. `pnpm install` copies each template to its real file if that file is missing (`scripts/config.mjs`):

| Template (tracked) | Your file (gitignored) |
|---|---|
| `apps/web/wrangler.example.jsonc` | `apps/web/wrangler.jsonc` |
| `apps/worker/wrangler.example.jsonc` | `apps/worker/wrangler.jsonc` |
| `apps/web/.env.production.example` | `apps/web/.env.production` |

Edit your files, not the templates. `pnpm deploy` runs `node scripts/config.mjs --check` and stops if any placeholder is left. If your Cloudflare login can see several accounts, `export CLOUDFLARE_ACCOUNT_ID=...` first (there's no `account_id` in the templates).

**Backup / restore.** So you never have to set this up again on the same machine:

```bash
pnpm config:backup    # copies all 5 local files (the 3 above + both .dev.vars)
                      # to .config-backup/ (gitignored) — re-run after edits
pnpm config:restore   # copies them back, only where a local file is missing
```

`pnpm install` also auto-restores from that backup before falling back to templates.

**Cloudflare (R2) sync — cross-machine, encrypted & isolated.** The same two commands take `--cloud` to encrypt the backup client-side (`AES-256-GCM`, `PBKDF2-SHA256` 600,000 iterations via `BACKUP_ENCRYPTION_KEY`) and sync it to a dedicated restricted R2 bucket (`whatsapp-ai-backups`, separate from the Worker's `whatsapp-ai-media` bucket and never bound to any Worker):

```bash
export BACKUP_ENCRYPTION_KEY="your-strong-passphrase-at-least-12-chars"
pnpm config:backup --cloud    # local backup + AES-256-GCM upload to r2://whatsapp-ai-backups/config/config.json.enc
pnpm config:restore --cloud   # download + decrypt from R2, then restore missing local files
```

On a new machine: `pnpm exec wrangler login`, export `BACKUP_ENCRYPTION_KEY`, then `pnpm config:restore --cloud` — done, no re-entry. The bucket defaults to `whatsapp-ai-backups` created by `pnpm setup` (override with `CONFIG_R2_BUCKET`).

**GitHub Actions deploy & backup.** CI renders the three files with `node scripts/config.mjs --from-env`. Add these under Settings → Secrets and variables → Actions:
- Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `KV_NAMESPACE_ID`, `BACKUP_ENCRYPTION_KEY`
- Variables: `APP_URL` (CRM origin), `ENGINE_URL` (engine Worker URL), `SENTRY_DSN` (optional), `BACKUP_R2_BUCKET` (optional, default `whatsapp-ai-backups`), `BACKUP_RETENTION_DAYS` (optional, default `30`)

The deploy job skips cleanly when any of these is missing, for example on forks. The nightly D1 backup uses the same values.

## `pnpm setup`

Runs `scripts/setup.sh`, which is idempotent (safe to re-run; it reuses anything that already exists):

1. **D1 database** — creates `whatsapp-ai` if `apps/worker/wrangler.jsonc`'s `database_id` is still the placeholder, and writes the real id into both `apps/worker/wrangler.jsonc` and `apps/web/wrangler.jsonc` (they must point at the *same* database).
2. **R2 bucket** — creates `whatsapp-ai-media` for message media.
3. **Queue** — creates `wa-broadcast-dispatch`, used to stagger broadcast sends with randomized delays.
4. **Vectorize indexes** — creates `wa-messages` (message search) and `wa-docs` (AI agent grounding), both 1024 dimensions, cosine similarity — matching the `@cf/baai/bge-m3` embedding model.
5. **KV namespace** — creates `REPLY_CACHE` for the AI agent's exact-match answer cache + short-lived config cache, and writes its id into `apps/worker/wrangler.jsonc`.
6. **D1 migrations** — applies everything in `packages/db/migrations` to the remote database.
7. **Secrets** — generates `BETTER_AUTH_SECRET` (web), plus `WS_TOKEN_SECRET` and `ENGINE_INTERNAL_SECRET` (same value on both Workers), if they aren't already set.

After it finishes, set your real URLs: `BETTER_AUTH_URL` in `apps/web/wrangler.jsonc` (Better Auth uses it for cookies and redirects), `CORS_ORIGIN` in `apps/worker/wrangler.jsonc`, and `VITE_ENGINE_URL` in `apps/web/wrangler.jsonc` and `apps/web/.env.production`.

## `pnpm deploy`

Runs `scripts/deploy.sh`:

1. Applies any new D1 migrations (safe no-op if there aren't any).
2. Builds both apps (`turbo build`).
3. Deploys `apps/worker` (the engine) first.
4. Deploys `apps/web` (the CRM) second — its service binding to the engine resolves by Worker name, so exact ordering isn't strictly required, but deploying the engine first means the CRM never briefly points at a not-yet-deployed engine.

Run it again any time you push changes — both steps are safe to repeat.

## Doing it by hand

If you'd rather not run the scripts (e.g. wiring this into your own CI):

```bash
# From apps/worker/
wrangler d1 create whatsapp-ai                          # copy the database_id into both wrangler.jsonc files
wrangler r2 bucket create whatsapp-ai-media
wrangler queues create wa-broadcast-dispatch
wrangler vectorize create wa-messages --dimensions=1024 --metric=cosine
wrangler vectorize create wa-docs --dimensions=1024 --metric=cosine
wrangler kv namespace create REPLY_CACHE                 # copy the id into apps/worker/wrangler.jsonc
wrangler d1 migrations apply whatsapp-ai --remote --migrations-dir ../../packages/db/migrations

# From apps/web/
wrangler secret put BETTER_AUTH_SECRET                  # paste a random 32+ byte value

# From the repo root
pnpm build
(cd apps/worker && wrangler deploy)
(cd apps/web && wrangler deploy)
```

## Multiple environments

For staging/production separation, use Wrangler's `env` blocks in both `wrangler.jsonc` files (separate D1 databases, R2 buckets, etc. per environment) and pass `--env <name>` to every command above. Not set up by default here to keep the template simple — add it if you need it.

### Example: staging + production

Add env blocks to both `apps/worker/wrangler.jsonc` and `apps/web/wrangler.jsonc`:

```jsonc
// apps/worker/wrangler.jsonc
{
  // ... default (development) config above ...

  "env": {
    "staging": {
      "name": "wa-cf-poc-staging",
      "vars": { "CORS_ORIGIN": "https://staging.yourdomain.com" },
      "d1_databases": [
        { "binding": "DB", "database_name": "whatsapp-ai-staging", "database_id": "<staging-db-id>" }
      ],
      "r2_buckets": [
        { "binding": "MEDIA", "bucket_name": "whatsapp-ai-media-staging" }
      ],
      "kv_namespaces": [
        { "binding": "REPLY_CACHE", "id": "<staging-kv-id>" }
      ]
    },
    "production": {
      "name": "wa-cf-poc-production",
      "vars": { "CORS_ORIGIN": "https://app.yourdomain.com" },
      "d1_databases": [
        { "binding": "DB", "database_name": "whatsapp-ai-production", "database_id": "<production-db-id>" }
      ],
      "r2_buckets": [
        { "binding": "MEDIA", "bucket_name": "whatsapp-ai-media-production" }
      ],
      "kv_namespaces": [
        { "binding": "REPLY_CACHE", "id": "<production-kv-id>" }
      ]
    }
  }
}
```

Then deploy to a specific environment:

```bash
# Staging
wrangler d1 migrations apply whatsapp-ai --env staging --remote
wrangler deploy --env staging

# Production
wrangler d1 migrations apply whatsapp-ai --env production --remote
wrangler deploy --env production
```

### CI/CD with multi-environment

The included GitHub Actions workflow (`/.github/workflows/ci.yml`) deploys to the default environment on push to `main`. For staging, add a second job or use the `environment` field:

```yaml
deploy-staging:
  environment: staging
  steps:
    - run: wrangler deploy --env staging
```

### Secrets per environment

Each environment has its own secret store:

```bash
wrangler secret put ENGINE_INTERNAL_SECRET --env staging
wrangler secret put WS_TOKEN_SECRET --env staging
wrangler secret put BETTER_AUTH_SECRET --env staging
wrangler secret put CORS_ORIGIN --env staging

wrangler secret put ENGINE_INTERNAL_SECRET --env production
wrangler secret put WS_TOKEN_SECRET --env production
wrangler secret put BETTER_AUTH_SECRET --env production
wrangler secret put CORS_ORIGIN --env production
```

## Custom domain

Once deployed, add a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) to `apps/web` from the Cloudflare dashboard (or a `routes` entry in its `wrangler.jsonc`), then update `BETTER_AUTH_URL` to match.

## Error tracking

Sentry is already wired into both Workers and the browser, with a scrubber that strips cookies, bodies, auth headers, phone numbers and emails. It's **off unless you set a DSN**:

```bash
(cd apps/web && wrangler secret put SENTRY_DSN)      # CRM server
(cd apps/worker && wrangler secret put SENTRY_DSN)   # engine
# browser: VITE_SENTRY_DSN=... in apps/web/.env.production (then rebuild)
```

Cloudflare's built-in [Error Tracking](https://developers.cloudflare.com/workers/observability/error-tracking/) also works with zero config. Errors appear in the dashboard under Workers & Pages > your Worker > Errors.

## Uptime monitoring

The engine exposes `GET /health` and the web app has a built-in health endpoint. Set up an external monitor to alert when either goes down:

**Option A — Cloudflare Health Checks (simplest):**
1. Go to your domain in the Cloudflare dashboard > Health Checks
2. Add a health check for `https://<your-engine-domain>/health` (interval: 60s)
3. Add a second for `https://<your-web-domain>/health`
4. Configure alerts (email, Slack webhook, PagerDuty) in the notification settings

**Option B — External service (Cronitor, BetterStack, UptimeRobot):**
1. Create an account and add two monitors:
   - Engine: `GET https://<engine-domain>/health` — expect `{"cloudflare":true,"baileys":true}`
   - Web app: `GET https://<web-domain>/health` — expect `{"status":"ok"}`
2. Set alert channels (email, Slack, PagerDuty)
3. Recommended intervals: 60s for production, 5min for staging

## D1 database backups

D1 does not have automatic backups on the free tier. The included `.github/workflows/d1-backup.yml` workflow exports D1 nightly, encrypts the SQL dump client-side with `AES-256-GCM` (`PBKDF2-SHA256`, 600,000 iterations) using `BACKUP_ENCRYPTION_KEY`, uploads it to the dedicated `whatsapp-ai-backups` R2 bucket (`backups/d1-YYYYMMDD-HHMMSS.sql.enc`), and enforces an R2 object lifecycle expiration rule (`BACKUP_RETENTION_DAYS`, default `30` days).

**Manual encrypted backup via Wrangler + `scripts/config.mjs`:**
```bash
export BACKUP_ENCRYPTION_KEY="your-strong-passphrase"
FILE="d1-$(date +%Y%m%d).sql"
wrangler d1 export whatsapp-ai --remote --output "$FILE"
node scripts/config.mjs --encrypt-file "$FILE" "${FILE}.enc"
wrangler r2 object put "whatsapp-ai-backups/backups/${FILE}.enc" --file "${FILE}.enc" --remote
rm -f "$FILE" "${FILE}.enc"
```

**Decrypt & Restore:**
```bash
export BACKUP_ENCRYPTION_KEY="your-strong-passphrase"
wrangler r2 object get "whatsapp-ai-backups/backups/d1-20261025-030000.sql.enc" --file d1.sql.enc --remote
node scripts/config.mjs --decrypt-file d1.sql.enc d1.sql
wrangler d1 execute whatsapp-ai --remote --file=d1.sql
rm -f d1.sql d1.sql.enc
```

## AI Gateway

Every model call in the worker — the agent's intent classifier, the reply generator, RAG + message-search embeddings — is routed through an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) via the AI binding (worker var `AIG_GATEWAY_ID`, default `"default"`). Each request is tagged `ws:{workspaceId}` and carries `metadata.workspaceId`/`feature`, so gateway metrics can be filtered per workspace once a matching [custom-metadata profile](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/) exists.

**Privacy by default (`collectLog: false`):** By default, `gatewayRunOptions` sets `collectLog: false` so Cloudflare AI Gateway records operational telemetry (request counts, token usage, latency, cost, and cache hit/miss rates) **without** persisting raw WhatsApp message bodies, conversation history, or RAG context in AI Gateway logs. To opt in to full request/response payload logging for debugging, set `AIG_COLLECT_LOG="true"` in `apps/worker`.

Features that are configured dashboard-side on the gateway (no code changes needed here):

- **Caching** — identical model calls served from Cloudflare's cache; our per-message KV reply cache stays as the faster first line.
- **Rate limiting / spend limits** — cost and request caps per provider, model, or workspace (using the `ws:` tags / metadata above).
- **Guardrails + DLP** — moderation categories and DLP profiles scan prompts/responses; our own intent gate + regex redaction remain the domain-specific first line.
- **Dynamic routing / fallbacks** — route between models/providers with A/B and failover. The worker also has a built-in code fallback: if the generator model fails it retries once on `@cf/meta/llama-3.1-8b-instruct`, and every gateway call retries up to 2×.
- **Logging / Logpush / OpenTelemetry** — export gateway logs for audit and tracing.

Disabling: remove the `gateway` option in `apps/worker/src/ai-agent/gateway.ts` (`gatewayRunOptions`) and keep the plain `env.AI.run()` calls — everything degrades to direct Workers AI.

## Security Configuration

### CORS (Cross-Origin Resource Sharing)

The worker's CORS origin is configurable via the `CORS_ORIGIN` environment variable:

- **Local dev**: Defaults to `*` (allows all origins for convenience)
- **Production**: Set to your domain for tighter security

```bash
# Set via wrangler secret (recommended for production)
cd apps/worker
wrangler secret put CORS_ORIGIN
# Enter: https://app.yourdomain.com

# Or set in wrangler.jsonc vars (less secure, visible in config)
# "CORS_ORIGIN": "https://app.yourdomain.com"
```

### Rate Limiting

Rate limiting is configured via `wrangler.jsonc` using Cloudflare's built-in Rate Limiting API:

```jsonc
// apps/worker/wrangler.jsonc
"ratelimits": [
  {
    "name": "API_RATE_LIMITER",
    "namespace_id": "1001",
    "simple": {
      "limit": 100,  // 100 requests per minute
      "period": 60
    }
  },
  {
    "name": "AUTH_RATE_LIMITER",
    "namespace_id": "1002",
    "simple": {
      "limit": 10,   // 10 requests per minute for auth
      "period": 60
    }
  }
]
```

**Note:** Requires wrangler 4.36.0+ and a paid Workers plan. Adjust limits based on your needs.

### Content Security Policy (CSP)

CSP headers are automatically added in production builds via the Vite plugin. The default policy:

- `default-src 'self'` — only load resources from your domain
- `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — required for TanStack Start hydration
- `style-src 'self' 'unsafe-inline'` — required for Tailwind CSS
- `img-src 'self' data: https:` — allows images from your domain and HTTPS sources
- `connect-src 'self'` — only allow API calls to your domain
- `frame-ancestors 'none'` — prevents framing (clickjacking protection)

To customize production CSP headers, edit `withSecurityHeaders` in `apps/web/src/server.ts` (for local `vite dev` CSP testing, set `VITE_ENABLE_DEV_CSP=true` in `apps/web/vite.config.ts`).

### Production Security Checklist

Before going live:

- [ ] Set `CORS_ORIGIN` to your production domain (via `wrangler secret put CORS_ORIGIN`)
- [ ] Set `BETTER_AUTH_URL` to your production URL (the setup script now validates this)
- [ ] Set `ENGINE_INTERNAL_SECRET` via `wrangler secret put` in both apps (same value in both)
- [ ] Set `WS_TOKEN_SECRET` via `wrangler secret put` in both apps (same value in both — signs/verifies the WebSocket auth token; the engine's `/ws-token` route now fails closed with a 500 if this is unset, instead of throwing an unhandled exception)
- [ ] Set `BETTER_AUTH_SECRET` via `wrangler secret put`
- [ ] Set `RESEND_FROM_EMAIL` to a verified domain (not `onboarding@resend.dev`)
- [ ] Configure rate limiting rules in Cloudflare dashboard
- [ ] Review and customize CSP headers if needed
- [ ] Ensure all secrets are set via `wrangler secret put` (not in wrangler.jsonc)
- [ ] Enable Cloudflare Workers Logs or a log drain for structured logging
- [ ] Set up error tracking (Sentry or Cloudflare Error Tracking)
- [ ] Set up uptime monitoring for both Workers (Cloudflare Health Checks or external)
- [ ] Configure D1 backup strategy (see D1 database backups section)
- [ ] Run the test suite: `pnpm --filter worker test`
- [ ] Verify CI pipeline passes before merging to main
