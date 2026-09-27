# Security policy

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Report them privately through GitHub's **[Report a vulnerability](../../security/advisories/new)** (Security → Advisories) on this repository.

Include what you found, steps to reproduce, and the impact (for example: another workspace's data can be read, sessions can be taken over, or auth can be bypassed). We aim to acknowledge reports within a few days and will credit you in the fix unless you'd rather stay anonymous.

## Scope

In scope: this repository's code, meaning tenant isolation, authentication, engine/API-key auth, WebSocket tokens, webhook signing, SSRF protections, media handling and the AI agent's guardrails.

Out of scope: WhatsApp account bans (see [DISCLAIMER.md](./DISCLAIMER.md)), issues in Baileys itself (report those [upstream](https://github.com/WhiskeySockets/Baileys)), Cloudflare platform issues, and misconfigured self-hosted deployments.

## Hardening your deployment

- Generate strong, unique values for `BETTER_AUTH_SECRET`, `ENGINE_INTERNAL_SECRET` and `WS_TOKEN_SECRET`, and set them with `wrangler secret put`.
- Set `CORS_ORIGIN` on the engine to your CRM's exact origin, never `*`.
- Rotate API keys you no longer use. Treat a linked WhatsApp session like a logged-in phone.
- Keep dependencies up to date and back up D1 regularly (see [DEPLOY.md](./DEPLOY.md)).
