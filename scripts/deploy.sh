#!/usr/bin/env bash
# Deploys both Workers, in the right order: the engine (apps/worker) first
# since the web app's service binding depends on it existing, then the web
# app itself. Run `pnpm setup` once before the first deploy.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Refuse to deploy with template placeholders still in the local config.
node scripts/config.mjs --check

# If your login can see more than one Cloudflare account, `wrangler d1 ...
# --remote` can't pick one on a non-interactive terminal: export
# CLOUDFLARE_ACCOUNT_ID=<your account id> before running this script.

echo "==> Applying any new D1 migrations..."
(cd apps/worker && CI=true pnpm exec wrangler d1 migrations apply whatsapp-ai --remote)

echo "==> Checking Baileys patches..."
bash scripts/check-patches.sh || {
  echo "Some patches may be stale. Continue anyway? [y/N]" >&2
  read -r answer
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "Deploy aborted." >&2
    exit 1
  fi
}

echo "==> Building..."
pnpm build

echo "==> Deploying engine (apps/worker)..."
(cd apps/worker && pnpm exec wrangler deploy)

echo "==> Deploying web app (apps/web)..."
(cd apps/web && pnpm exec wrangler deploy)

echo ""
echo "Deployed. Check the URLs wrangler printed above."
