// Fixes a real crash sending ANY media message (image/video/audio/document)
// from this Worker: Baileys encodes outgoing messages with protobufjs,
// whose generated BufferWriter pre-computes each string field's UTF-8 byte
// length with its own JS-side counter, then hands the actual write off to
// the runtime's native `Buffer.prototype.utf8Write` for any string 40+
// characters long (media messages have several -- the CDN `url`,
// `directPath`, `mediaKey`, caption, mimetype...). Node 22.7+ tightened
// `utf8Write`'s bounds checking so a precompute/actual-write mismatch now
// throws `RangeError [ERR_OUT_OF_RANGE]` instead of silently truncating,
// and Cloudflare's workerd `nodejs_compat` Buffer polyfill inherited the
// same strict check -- see nodejs/node#54518 and
// WhiskeySockets/Baileys#1003 for the exact same failure signature in
// other protobufjs-based stacks. Text messages stay under the 40-char
// threshold so they never hit this path, which is why only media broke.
//
// Fix: disable protobufjs's Buffer-based writer entirely so it always
// uses its own pure-JS Writer, which never calls the buggy native
// utf8Write. Must run before the first message is ever encoded --
// protobufjs decides which Writer to use the first time one is created,
// and after that the decision is cached for the life of the process, so
// this needs to execute at module-load time, not lazily.
//
// Imports protobufjs by a raw relative path into the pnpm store instead
// of as a normal package dependency: this worker doesn't (and shouldn't)
// depend on protobufjs directly -- Baileys does, and pnpm's strict
// node_modules layout means our own package.json can't just declare it
// without a `pnpm install` (which this sandboxed dev environment can't
// reliably run against a synced folder -- see the message-scroller.tsx /
// @shadcn/react note in packages/ui for the same constraint). The
// relative path below resolves to the exact same on-disk file Baileys
// itself imports as "protobufjs/minimal.js" (pnpm hard-links every
// consumer of the same package version to one shared copy), so mutating
// `util.Buffer` here mutates the very singleton Baileys' generated
// WAProto code reads from.
//
// If a future `pnpm install`/lockfile change moves protobufjs to a
// different resolved version, this path will stop matching and this
// file will fail to build -- if that happens, `find node_modules/.pnpm
// -maxdepth 1 -iname "protobufjs*"` and update the version in the path
// below to match.
import protobufMinimal from "../../../node_modules/.pnpm/protobufjs@7.6.6/node_modules/protobufjs/minimal.js";

(protobufMinimal.util as any).Buffer = null;
// Setting util.Buffer alone isn't enough -- protobufjs decides which
// Writer/Reader implementation to use once, at its own module-load time
// (index-minimal.js's `configure()` call), and caches that decision in
// `Writer.create`/`Reader.create`. By the time this file's own body runs,
// that decision has already been made using the *real* Buffer. Calling
// the library's own exported `configure()` again re-derives it from the
// util.Buffer value we just set, correctly switching Writer.create over
// to the pure-JS writer this time.
(protobufMinimal as any).configure();
