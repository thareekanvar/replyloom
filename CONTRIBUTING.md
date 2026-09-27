# Contributing

Thanks for helping out! Bug fixes, docs, tests and features are all welcome.

## Before you start

- Read [ARCHITECTURE.md](./ARCHITECTURE.md) and the hard rules in [AGENTS.md](./AGENTS.md). They apply to humans too.
- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- **Out of scope, and will be closed:** anything that helps send spam or evade WhatsApp's detection. That includes proxy/IP rotation, device-fingerprint spoofing, message spinning, number rotation, contact scraping, and removing or raising the anti-spam limits past their hard maximums. See [DISCLAIMER.md](./DISCLAIMER.md).

## Setup

```bash
corepack enable
pnpm install
cp apps/web/.dev.vars.example apps/web/.dev.vars
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
cd apps/web && npx wrangler d1 migrations apply whatsapp-ai --local && cd ../..
pnpm dev
```

Use a **test WhatsApp number** for development, never your main or business number.

## Making changes

- Branch from `main`. Keep PRs focused on one change.
- Schema changes: edit `packages/db/src/schema`, run `pnpm --filter @workspace/db generate`, review the SQL, and read the migration/trigger gotchas in AGENTS.md.
- Add or update tests for behaviour changes (`apps/worker/src/__tests__`, `apps/web/src/**/*.test.ts`).
- Run `pnpm typecheck && pnpm lint && pnpm --filter worker test && pnpm --filter web test` before pushing.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, `docs:`, `refactor:` …).

## Pull request checklist

- [ ] Every new query or server function is scoped to the caller's workspace
- [ ] No polling added. Live updates go over the WebSocket
- [ ] Lists are cursor-paginated. No unbounded queries or `count(*)` totals
- [ ] Anti-spam limits unchanged, or only made stricter
- [ ] Typecheck, lint and tests pass
- [ ] Docs updated if behaviour or setup changed

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
