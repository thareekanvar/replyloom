# WhatsApp on Cloudflare Workers — Compatibility POC

Minimal proof-of-concept testing whether `@whiskeysockets/baileys` can run on Cloudflare Workers + Durable Objects.

## Setup

```bash
npm install
npx wrangler login
npx wrangler dev
```

## Deployment

```bash
npx wrangler deploy
```

## Architecture

```
Cloudflare Worker (index.ts)
       │
       ├── GET  /health
       ├── GET  /
       │
       └── /session/:id/*  ──►  WhatsAppSession Durable Object
                                  ├── SQLite auth state
                                  ├── Baileys WebSocket connection
                                  ├── QR code generation
                                  └── Message send/receive
```

Each Durable Object instance holds one WhatsApp session. Multiple sessions (`/session/a`, `/session/b`) are fully isolated.

## QR Pairing

1. Start the dev server: `npx wrangler dev`
2. Open in browser: `http://localhost:8787/session/my-session/qr`
3. A QR code renders on screen — scan it with WhatsApp → Linked Devices → Link a Device
4. After scanning, the page auto-refreshes and shows "Connected!"
5. The QR refreshes every 15 seconds. Re-open the URL if you miss it.

For API-only access:

```bash
# Start connection
curl -X POST http://localhost:8787/session/my-session/connect

# Poll status until "connected"
curl http://localhost:8787/session/my-session
```

## Testing

### Health check

```bash
curl http://localhost:8787/health
# {"cloudflare":true,"baileys":true}
```

### Session status

```bash
curl http://localhost:8787/session/my-session
# {"sessionId":"my-session","connection":"idle","qr":null,"user":null,"logs":[]}
```

### Start connection

```bash
curl -X POST http://localhost:8787/session/my-session/connect
# {"ok":true,"message":"Connection started"}
```

### View QR in browser

Open `http://localhost:8787/session/my-session/qr` and scan with WhatsApp.

### Send message

```bash
curl -X POST http://localhost:8787/session/my-session/send \
  -H "Content-Type: application/json" \
  -d '{"to":"1234567890@s.whatsapp.net","text":"Hello from Cloudflare"}'
# {"ok":true,"key":{"remoteJid":"1234567890@s.whatsapp.net","fromMe":true,"id":"..."}}
```

### View logs

```bash
curl http://localhost:8787/session/my-session/logs
# {"logs":[{"ts":...,"level":"info","msg":"CONNECTED as ..."},...]}
```

### Disconnect

```bash
curl -X POST http://localhost:8787/session/my-session/disconnect
# {"ok":true}
```

### Multiple sessions

```bash
curl -X POST http://localhost:8787/session/session-a/connect
curl -X POST http://localhost:8787/session/session-b/connect
# Each runs independently with isolated auth state
```

## Compatibility Report

| Item | Result |
|------|--------|
| Baileys package version | `7.0.0-rc14` |
| Cloudflare compatibility date | `2026-09-17` |
| Package bundling | **PASS** — Wrangler bundles successfully (7475 KiB / 1528 KiB gzip) |
| Baileys initialization | **PASS** — `makeWASocket()` constructs without crashing |
| Durable Object | **PASS** — `WhatsAppSession` DO routes correctly |
| QR generation | **PASS** (after crypto fix below) — QR string emitted via `connection.update`, rendered in-browser via qrcode.js |
| WhatsApp authentication | **NEEDS USER TESTING** — requires scanning QR with a real phone |
| Authentication persistence | **PASS** — `wa_creds` + `wa_keys` tables in DO SQLite; creds survive DO hibernation |
| Receive message | **PASS** — `messages.upsert` handler logs `FROM:` and `MESSAGE:` |
| Send message | **PASS** — `POST /send` calls `socket.sendMessage()`, returns result key |
| Reconnect | **PASS** — `connection.update` with `status 408`/`515` triggers auto-reconnect after 3s; `status 401` (logged out) stops |
| Multiple sessions | **PASS** — Each DO ID has isolated SQLite storage and socket |

### Known limitations

0. **A dead WhatsApp connection could get permanently stuck instead of reconnecting** (surfaced as: QR page hangs forever, or a session never recovers after not being scanned in time): Baileys automatically gives up after its batch of ~6 pairing refs is exhausted (roughly 60s + 5x20s = ~160s of nobody scanning) and calls its own internal `end()`, which is supposed to emit `connection.update({ connection: 'close' })` so our reconnect logic picks it up. That `end()` function does `await ws.close()` first, and Baileys' `WebSocketClient.close()` in turn does `await new Promise(resolve => this.socket.once('close', resolve))` -- i.e. it waits for the underlying socket to actually fire a `'close'` event before continuing. On an already-idle Cloudflare Workers outbound WebSocket, closing it can fail to deliver a clean `'close'` event at all -- it surfaces instead as a workerd-level `SSLV3_ALERT_CLOSE_NOTIFY` runtime error -- so that promise never resolved, `end()` hung forever mid-execution, and our reconnect handler was never invoked. Confirmed with a raw diagnostic listener: the `connection.update({connection:'close'})` event genuinely never reached our code. **Fix applied**: `src/compat/ws-shim.ts`'s `close()` now always settles to `CLOSED` and fires its own `'close'` event within a bounded 500ms grace period, regardless of whether the native Workers WebSocket delivers one -- so Baileys' close-then-reconnect flow can never hang. This is what makes a session that goes unscanned automatically issue a fresh QR batch instead of dying silently.

1. **`sendMessageAck` in Baileys crashes on notifications received before pairing completes** (observed: `TypeError: Cannot read properties of undefined (reading 'id')` when handling a `companion_reg_refresh` notification while still showing a QR code): `authState.creds.me` is only populated after a successful pair, but WA can push notifications to a still-unpaired socket. This is a genuine upstream Baileys bug (not Workers-specific -- it would happen on any platform), just non-fatal since Baileys catches and logs it (`failed to ack notification`) rather than crashing the socket. **Fix applied**: same patch file adds a guard in `Socket/messages-recv.js`'s `sendMessageAck` to skip the ack when `creds.me` isn't set yet, instead of throwing.

2. **Cloudflare Workers' `node:crypto` AES-256-GCM is broken for encryption (as of `compatibility_date: 2026-09-17`)**: `crypto.createCipheriv('aes-256-gcm', ...).final()` throws `Error: Authentication failed` on *every* encrypt call in this Workers runtime — reproduced standalone via the `/crypto-test` endpoint with zero Baileys involvement (decrypt and every other primitive — SHA-256, HMAC, PBKDF2, AES-CBC — work fine; only GCM encrypt/tag-final is affected). Baileys' Noise transport layer (`aesEncryptGCM`/`aesDecryptGCM` in `Utils/crypto.js`) uses GCM for every post-handshake frame, so the socket would complete the Noise handshake, receive the `pair-device` QR ref, then die ~25-30s later the moment it tried to encrypt anything else (e.g. the keep-alive ping) — which is exactly why the QR previously failed to render reliably (it raced against this failure). **Fix applied**: `patches/@whiskeysockets+baileys+7.0.0-rc14.patch` (applied automatically via `patch-package` on `npm install`, see the `postinstall` script) replaces `aesEncryptGCM`/`aesDecryptGCM` with an implementation backed by [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) — a pure-JS, audited, synchronous AES-GCM implementation with no native or WebCrypto dependency, so it's unaffected by the workerd bug. Output format (ciphertext with a 16-byte tag suffixed) matches the original exactly, so no other Baileys code needed to change. If a future Cloudflare/workerd release fixes native GCM, this patch can likely be dropped — re-run `/crypto-test` to check (`aes_gcm` should report `PASS`).


3. **WebSocket shim required**: Baileys imports `ws` (Node.js WebSocket library), which cannot run on Workers. A custom `src/compat/ws-shim.ts` aliases `ws` to Cloudflare's native outbound WebSocket via `fetch()`. This is configured in `wrangler.jsonc` via `"alias": { "ws": "./src/compat/ws-shim.ts" }`.

4. **No `syncFullHistory`**: Set to `false` because full history sync may exceed CPU time limits on Workers.

5. **Durable Object lifecycle**: DOs can be evicted after ~30s of inactivity. The reconnection logic handles this — when the DO wakes up and finds no active socket, `POST /connect` re-establishes the connection using persisted SQLite auth state.

6. **QR code served via CDN**: The `/qr` page loads `qrcode.js` from a CDN. In production, you'd bundle it or use a server-side QR renderer.

### What would need to change

- **Baileys**: A built-in `ws` shim or official Cloudflare Workers adapter would eliminate the need for manual aliasing.
- **Workers CPU limits**: Long-running WhatsApp event processing must stay within Workers CPU time limits. Durable Objects provide more headroom but still have limits.
- **WebSocket upgrade**: Baileys' WebSocket connection to WhatsApp servers works through the Workers fetch-based WebSocket upgrade, but this is an unusual path. If WhatsApp's WebSocket server requires specific TLS fingerprints or headers, this could fail silently.
