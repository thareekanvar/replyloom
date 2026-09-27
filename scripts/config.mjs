#!/usr/bin/env node
// Local deploy config lives in gitignored files so nobody's Cloudflare ids or
// domains end up in the repo:
//   apps/web/wrangler.jsonc     <- apps/web/wrangler.example.jsonc
//   apps/worker/wrangler.jsonc  <- apps/worker/wrangler.example.jsonc
//   apps/web/.env.production    <- apps/web/.env.production.example
//
// `node scripts/config.mjs`            restore any missing file from your local
//                                      backup, then copy the rest from its
//                                      template (runs on `pnpm install`;
//                                      never overwrites)
// `node scripts/config.mjs --backup`   copy all local config files to a
//                                      gitignored backup dir (re-run after you
//                                      change one; set CONFIG_BACKUP_DIR to
//                                      point at a synced folder, e.g. Dropbox)
// `node scripts/config.mjs --restore`  copy backup files back, only where the
//                                      local file is missing
// `... --backup --cloud` / `--restore --cloud`
//                                      same, but synced to R2 in your own
//                                      Cloudflare account (needs
//                                      `wrangler login` once):
//                                        r2://<CONFIG_R2_BUCKET>/config/config.json
//                                      bucket defaults to the media bucket
//                                      created by `pnpm setup`. On a new
//                                      machine: wrangler login, then
//                                      `pnpm config:restore --cloud`.
// `node scripts/config.mjs --from-env` (re)write all three from the templates
//                                      using env vars — for CI deploys:
//     D1_DATABASE_ID, KV_NAMESPACE_ID, APP_URL, ENGINE_URL   (required)
//     SENTRY_DSN                                             (optional)
// `node scripts/config.mjs --check`    exit 1 if any placeholder is left
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  ["apps/web/wrangler.example.jsonc", "apps/web/wrangler.jsonc"],
  ["apps/worker/wrangler.example.jsonc", "apps/worker/wrangler.jsonc"],
  ["apps/web/.env.production.example", "apps/web/.env.production"],
];
// Every local config file worth keeping: the three above + the two .dev.vars
// (which have no template — they're created by hand once).
const BACKUP_FILES = [...FILES.map(([, dst]) => dst), "apps/web/.dev.vars", "apps/worker/.dev.vars"];
const BACKUP_DIR = process.env.CONFIG_BACKUP_DIR ?? join(root, ".config-backup");
const R2_BUCKET = process.env.CONFIG_R2_BUCKET ?? "whatsapp-ai-media";
const R2_KEY = "config/config.json";
const WRANGLER_BIN = join(root, "apps/worker/node_modules/wrangler/bin/wrangler.js");
const PLACEHOLDER = /REPLACE_WITH_[A-Z_]+|YOUR-ENGINE-WORKER/;
const flags = process.argv.slice(2);
const mode = flags.find((f) => f !== "--cloud") ?? "";
const cloud = flags.includes("--cloud");

// Run wrangler from apps/worker so its wrangler.jsonc supplies the account id
// (multi-account logins) — R2 object commands don't need any config binding.
function wrangler(args) {
  if (!existsSync(WRANGLER_BIN)) {
    console.error("wrangler not found — run `pnpm install` first.");
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: join(root, "apps/worker"),
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error((r.stdout ?? "") + (r.stderr ?? ""));
    console.error(`\`wrangler ${args.slice(0, 3).join(" ")}\` failed — are you logged in (\`pnpm exec wrangler login\`) and does bucket "${R2_BUCKET}" exist?`);
    process.exit(1);
  }
  return r.stdout ?? "";
}

function restoreMissing() {
  if (!existsSync(BACKUP_DIR)) return 0;
  let n = 0;
  for (const rel of BACKUP_FILES) {
    const dst = join(root, rel);
    const src = join(BACKUP_DIR, rel);
    if (existsSync(dst) || !existsSync(src)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    console.log(`restored ${rel} from backup`);
    n++;
  }
  return n;
}

if (mode === "--backup") {
  let n = 0;
  for (const rel of BACKUP_FILES) {
    const src = join(root, rel);
    if (!existsSync(src)) {
      console.warn(`skip (missing) ${rel}`);
      continue;
    }
    const dst = join(BACKUP_DIR, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    n++;
  }
  const where = process.env.CONFIG_BACKUP_DIR
    ? BACKUP_DIR
    : `${relative(root, BACKUP_DIR)} (gitignored — set CONFIG_BACKUP_DIR to sync it across machines)`;
  console.log(`Backed up ${n}/${BACKUP_FILES.length} files to ${where}`);

  if (cloud) {
    const files = {};
    for (const rel of BACKUP_FILES) {
      const p = join(root, rel);
      if (existsSync(p)) files[rel] = readFileSync(p).toString("base64");
    }
    const tmp = mkdtempSync(join(tmpdir(), "replyloom-config-"));
    try {
      const blob = JSON.stringify({ savedAt: new Date().toISOString(), files });
      writeFileSync(join(tmp, "config.json"), blob);
      wrangler(["r2", "object", "put", `${R2_BUCKET}/${R2_KEY}`, "--file", join(tmp, "config.json"), "--remote"]);
      console.log(`Uploaded ${Object.keys(files).length} files to r2://${R2_BUCKET}/${R2_KEY}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  process.exit(0);
}

if (mode === "--restore") {
  if (cloud) {
    const tmp = mkdtempSync(join(tmpdir(), "replyloom-config-"));
    try {
      wrangler(["r2", "object", "get", `${R2_BUCKET}/${R2_KEY}`, "--file", join(tmp, "config.json"), "--remote"]);
      const blob = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
      for (const [rel, b64] of Object.entries(blob.files ?? {})) {
        const dst = join(BACKUP_DIR, rel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, Buffer.from(b64, "base64"));
      }
      console.log(`Downloaded backup from r2://${R2_BUCKET}/${R2_KEY} (saved ${blob.savedAt ?? "?"}) into ${relative(root, BACKUP_DIR) || BACKUP_DIR}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const n = restoreMissing();
  console.log(n ? `Restored ${n} file(s).` : "Nothing to restore — local config is already complete.");
  process.exit(0);
}

if (mode === "--check") {
  const bad = FILES.map(([, dst]) => dst).filter((dst) => {
    const p = join(root, dst);
    return !existsSync(p) || PLACEHOLDER.test(readFileSync(p, "utf8"));
  });
  if (bad.length) {
    console.error(`Placeholders left in: ${bad.join(", ")}\nRun \`pnpm setup\` and set your URLs (see DEPLOY.md).`);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "--from-env") {
  const need = ["D1_DATABASE_ID", "KV_NAMESPACE_ID", "APP_URL", "ENGINE_URL"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  const strip = (u) => u.replace(/\/+$/, "");
  const app = strip(process.env.APP_URL);
  const engine = strip(process.env.ENGINE_URL);
  const set = (src, key, val) => src.replace(new RegExp(`("${key}": *)"[^"]*"`), `$1${JSON.stringify(val)}`);
  for (const [tpl, dst] of FILES) {
    let src = readFileSync(join(root, tpl), "utf8");
    if (dst.endsWith(".jsonc")) {
      src = set(src, "database_id", process.env.D1_DATABASE_ID);
      src = src.replace(/("binding": "REPLY_CACHE", "id": )"[^"]*"/, `$1${JSON.stringify(process.env.KV_NAMESPACE_ID)}`);
      src = set(src, "BETTER_AUTH_URL", app);
      src = set(src, "VITE_ENGINE_URL", engine);
      src = set(src, "CORS_ORIGIN", app);
    } else {
      src = src
        .replace(/^VITE_ENGINE_URL=.*$/m, `VITE_ENGINE_URL=${engine}`)
        .replace(/^VITE_WA_API_URL=.*$/m, `VITE_WA_API_URL=${engine}`)
        .replace(/^VITE_SENTRY_DSN=.*$/m, `VITE_SENTRY_DSN=${process.env.SENTRY_DSN ?? ""}`);
    }
    writeFileSync(join(root, dst), src);
    console.log(`wrote ${dst}`);
  }
  process.exit(0);
}

// Default (postinstall): fill gaps — your own backup first, templates after.
restoreMissing();

for (const [tpl, dst] of FILES) {
  if (!existsSync(join(root, dst))) {
    copyFileSync(join(root, tpl), join(root, dst));
    console.log(`created ${dst} from ${tpl} (placeholder values — run \`pnpm setup\`)`);
  }
}
