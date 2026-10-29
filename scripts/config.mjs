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
//                                      same, but encrypted client-side with
//                                      AES-256-GCM (PBKDF2-SHA256, 600,000
//                                      iterations via BACKUP_ENCRYPTION_KEY)
//                                      and synced to a dedicated restricted R2
//                                      bucket (`whatsapp-ai-backups`):
//                                        r2://<CONFIG_R2_BUCKET>/config/config.json.enc
// `node scripts/config.mjs --encrypt-file <in> <out>`
// `node scripts/config.mjs --decrypt-file <in> <out>`
//                                      encrypt/decrypt arbitrary backup files
//                                      (used by .github/workflows/d1-backup.yml)
// `node scripts/config.mjs --from-env` (re)write all three from the templates
//                                      using env vars — for CI deploys:
//     D1_DATABASE_ID, KV_NAMESPACE_ID, APP_URL, ENGINE_URL   (required)
//     SENTRY_DSN                                             (optional)
// `node scripts/config.mjs --check`    exit 1 if any placeholder is left
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Encrypts a Buffer or UTF-8 string using AES-256-GCM with a key derived from
 * `passphrase` via PBKDF2-SHA256 (600,000 iterations). Returns a serialized JSON
 * envelope string.
 */
export function encryptBackupPayload(plaintext, passphrase) {
  if (typeof passphrase !== "string" || passphrase.trim().length < 12) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be at least 12 characters long.");
  }
  const plainBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    version: 2,
    encrypted: true,
    algorithm: "aes-256-gcm",
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_ITERATIONS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    savedAt: new Date().toISOString(),
  });
}

/**
 * Decrypts a JSON envelope string produced by `encryptBackupPayload` and returns
 * the original plaintext Buffer.
 */
export function decryptBackupPayload(envelopeRaw, passphrase) {
  if (typeof passphrase !== "string" || passphrase.trim().length === 0) {
    throw new Error("BACKUP_ENCRYPTION_KEY is required to decrypt this backup.");
  }
  const env = typeof envelopeRaw === "string" ? JSON.parse(envelopeRaw) : envelopeRaw;
  if (!env || env.encrypted !== true || env.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported or unencrypted backup envelope.");
  }
  const iterations = Number(env.iterations) || PBKDF2_ITERATIONS;
  if (iterations < 100_000 || iterations > 5_000_000) {
    throw new Error("Invalid PBKDF2 iteration count in backup envelope.");
  }
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const ciphertext = Buffer.from(env.ciphertext, "base64");
  const key = pbkdf2Sync(passphrase, salt, iterations, KEY_BYTES, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

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
// Dedicated restricted bucket separate from the Worker's media bucket (`whatsapp-ai-media`).
const R2_BUCKET = process.env.CONFIG_R2_BUCKET ?? process.env.BACKUP_R2_BUCKET ?? "whatsapp-ai-backups";
const LEGACY_R2_BUCKET = "whatsapp-ai-media";
const R2_KEY = "config/config.json";
const LEGACY_ENC_R2_KEY = "config/config.json.enc";
const WRANGLER_BIN = join(root, "apps/worker/node_modules/wrangler/bin/wrangler.js");
const PLACEHOLDER = /REPLACE_WITH_[A-Z_]+|YOUR-ENGINE-WORKER/;

function wrangler(args, { allowFail = false } = {}) {
  if (!existsSync(WRANGLER_BIN)) {
    console.error("wrangler not found — run `pnpm install` first.");
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: join(root, "apps/worker"),
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    console.error((r.stdout ?? "") + (r.stderr ?? ""));
    console.error(`\`wrangler ${args.slice(0, 3).join(" ")}\` failed — are you logged in (\`pnpm exec wrangler login\`) and does bucket "${R2_BUCKET}" exist?`);
    process.exit(1);
  }
  return r.stdout ?? "";
}

function resolveBackupEncryptionKey() {
  if (process.env.BACKUP_ENCRYPTION_KEY && process.env.BACKUP_ENCRYPTION_KEY.trim().length > 0) {
    return process.env.BACKUP_ENCRYPTION_KEY.trim();
  }
  for (const rel of ["apps/worker/.dev.vars", "apps/web/.dev.vars"]) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const match = readFileSync(p, "utf8").match(/^BACKUP_ENCRYPTION_KEY=(.+)$/m);
    if (match?.[1]?.trim()) {
      return match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
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

function runCli() {
  const flags = process.argv.slice(2);
  const cloud = flags.includes("--cloud");
  const allowUnencrypted = flags.includes("--allow-unencrypted");
  const positional = flags.filter((f) => f !== "--cloud" && f !== "--allow-unencrypted");
  const mode = positional[0] ?? "";

  if (mode === "--encrypt-file") {
    const [, inputPath, outputPath] = positional;
    if (!inputPath || !outputPath) {
      console.error("Usage: node scripts/config.mjs --encrypt-file <input> <output>");
      process.exit(1);
    }
    const key = resolveBackupEncryptionKey();
    if (!key || key.length < 12) {
      console.error("Missing or weak BACKUP_ENCRYPTION_KEY (must be at least 12 chars).");
      process.exit(1);
    }
    const plain = readFileSync(inputPath);
    const encrypted = encryptBackupPayload(plain, key);
    writeFileSync(outputPath, encrypted, { mode: 0o600 });
    console.log(`Encrypted ${inputPath} -> ${outputPath} (AES-256-GCM)`);
    process.exit(0);
  }

  if (mode === "--decrypt-file") {
    const [, inputPath, outputPath] = positional;
    if (!inputPath || !outputPath) {
      console.error("Usage: node scripts/config.mjs --decrypt-file <input> <output>");
      process.exit(1);
    }
    const key = resolveBackupEncryptionKey();
    if (!key) {
      console.error("Missing BACKUP_ENCRYPTION_KEY environment variable.");
      process.exit(1);
    }
    const envelope = readFileSync(inputPath, "utf8");
    const decrypted = decryptBackupPayload(envelope, key);
    writeFileSync(outputPath, decrypted, { mode: 0o600 });
    console.log(`Decrypted ${inputPath} -> ${outputPath}`);
    process.exit(0);
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
      const key = resolveBackupEncryptionKey();
      const files = {};
      for (const rel of BACKUP_FILES) {
        const p = join(root, rel);
        if (existsSync(p)) files[rel] = readFileSync(p).toString("base64");
      }
      const tmp = mkdtempSync(join(tmpdir(), "replyloom-config-"));
      try {
        // Ensure the dedicated restricted backup bucket exists so upgrading users don't have to re-run setup.sh.
        wrangler(["r2", "bucket", "create", R2_BUCKET], { allowFail: true });
        const plainBlob = JSON.stringify({ savedAt: new Date().toISOString(), files });
        if (!key || key.length < 12) {
          console.error(
            "BACKUP_ENCRYPTION_KEY (12+ chars) is not set. Refusing to upload your .dev.vars secrets unencrypted.\n" +
              "Set it in your shell (keep a copy outside this backup, e.g. a password manager), or pass --allow-unencrypted.",
          );
          if (!allowUnencrypted) process.exit(1);
        }
        const encrypt = key && key.length >= 12;
        const payload = encrypt ? encryptBackupPayload(plainBlob, key) : plainBlob;
        const encryptedLabel = encrypt ? "AES-256-GCM encrypted" : "UNENCRYPTED (--allow-unencrypted)";
        const tmpFile = join(tmp, "config.json");
        writeFileSync(tmpFile, payload, { mode: 0o600 });
        wrangler(["r2", "object", "put", `${R2_BUCKET}/${R2_KEY}`, "--file", tmpFile, "--remote"]);
        if (R2_BUCKET !== LEGACY_R2_BUCKET) {
          if (wrangler(["r2", "object", "delete", `${LEGACY_R2_BUCKET}/${R2_KEY}`, "--remote"], { allowFail: true }) !== null) {
            console.log(`Removed the old unencrypted copy at r2://${LEGACY_R2_BUCKET}/${R2_KEY}`);
          }
        }
        console.log(`Uploaded ${encryptedLabel} backup (${Object.keys(files).length} files) to r2://${R2_BUCKET}/${R2_KEY}`);
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
        const tmpFile = join(tmp, "config.json");
        let sourceRef = `${R2_BUCKET}/${R2_KEY}`;
        const candidates = [
          `${R2_BUCKET}/${R2_KEY}`,
          `${R2_BUCKET}/${LEGACY_ENC_R2_KEY}`,
          `${LEGACY_R2_BUCKET}/${R2_KEY}`,
        ];
        let fetched = false;
        for (const candidate of candidates) {
          if (wrangler(["r2", "object", "get", candidate, "--file", tmpFile, "--remote"], { allowFail: true }) !== null && existsSync(tmpFile)) {
            sourceRef = candidate;
            fetched = true;
            break;
          }
        }
        if (!fetched) {
          console.error(`Could not find cloud config backup in r2://${R2_BUCKET}/${R2_KEY} (or legacy r2://${LEGACY_R2_BUCKET}/${R2_KEY}).`);
          process.exit(1);
        }
        const raw = JSON.parse(readFileSync(tmpFile, "utf8"));
        let blob = raw;
        if (raw.encrypted === true) {
          const key = resolveBackupEncryptionKey();
          if (!key) {
            console.error("Backup in R2 is encrypted. Set BACKUP_ENCRYPTION_KEY before running `--restore --cloud`.");
            process.exit(1);
          }
          blob = JSON.parse(decryptBackupPayload(raw, key).toString("utf8"));
        }
        for (const [rel, b64] of Object.entries(blob.files ?? {})) {
          const dst = join(BACKUP_DIR, rel);
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, Buffer.from(b64, "base64"), { mode: 0o600 });
        }
        console.log(
          `Downloaded backup from r2://${sourceRef} (saved ${blob.savedAt ?? raw.savedAt ?? "?"}) into ${relative(root, BACKUP_DIR) || BACKUP_DIR}`,
        );
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
