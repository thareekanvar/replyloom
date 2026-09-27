/**
 * Minimal polyfill of the `ws` npm package's default export, implemented on
 * top of Cloudflare Workers' native outbound WebSocket support (fetch() with
 * an `Upgrade: websocket` header, which returns a `webSocket` on the
 * Response). This is aliased in place of `ws` (see wrangler.jsonc `alias`)
 * so that @whiskeysockets/baileys' Socket/Client/websocket.js — which does
 * `import WebSocket from 'ws'` and expects a Node-EventEmitter-flavoured
 * WebSocket — keeps working unmodified inside a Worker/Durable Object,
 * where the real `ws` package cannot run (it needs Node's `net`/`tls`
 * modules for raw TCP sockets, which Workers does not expose).
 *
 * Only the surface area Baileys actually touches is implemented:
 *   new WebSocket(url, { origin, headers, handshakeTimeout, timeout, agent })
 *   .on / .once / .off / .removeListener / .emit / .setMaxListeners
 *   .send(data, cb) / .close() / .readyState / .OPEN / .CLOSED / .CLOSING / .CONNECTING
 */

type Listener = (...args: any[]) => void;

interface ShimOptions {
  origin?: string;
  headers?: Record<string, string>;
  handshakeTimeout?: number;
  timeout?: number;
  agent?: unknown; // not supported in Workers; ignored
}

export default class WorkersWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = WorkersWebSocket.CONNECTING;
  readonly OPEN = WorkersWebSocket.OPEN;
  readonly CLOSING = WorkersWebSocket.CLOSING;
  readonly CLOSED = WorkersWebSocket.CLOSED;

  readyState: number = WorkersWebSocket.CONNECTING;

  private nativeSocket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private sendQueue: Array<{ data: string | Uint8Array; cb?: (err?: Error) => void }> = [];
  private closeSettled = false;

  constructor(
    private url: URL | string,
    private options: ShimOptions = {}
  ) {
    void this.open();
  }

  private async open() {
    try {
      // Workers' outbound-WebSocket-via-fetch requires an http(s) scheme;
      // ws:// / wss:// are translated 1:1.
      const httpUrl = this.url
        .toString()
        .replace(/^wss:/i, 'https:')
        .replace(/^ws:/i, 'http:');

      const headers = new Headers(this.options.headers ?? {});
      headers.set('Upgrade', 'websocket');
      if (this.options.origin) {
        headers.set('Origin', this.options.origin);
      }

      // Wrap fetch with a timeout so a slow/unreachable WhatsApp server
      // doesn't wedge the entire Baileys connection flow indefinitely.
      const controller = new AbortController();
      const timeoutMs = this.options.handshakeTimeout ?? 15_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let resp: Response;
      try {
        resp = await fetch(httpUrl, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;

      if (!ws) {
        const body = await resp.text().catch(() => '');
        throw new Error(
          `Cloudflare Workers outbound WebSocket upgrade failed: got HTTP ${resp.status} ` +
            `instead of a 101 Switching Protocols response with a webSocket. ` +
            `Body (truncated): ${body.slice(0, 300)}`
        );
      }

      ws.accept();
      this.nativeSocket = ws;
      this.readyState = WorkersWebSocket.OPEN;

      ws.addEventListener('message', async (evt: MessageEvent) => {
        let data: string | Uint8Array;
        if (evt.data instanceof ArrayBuffer) {
          data = new Uint8Array(evt.data);
        } else if (typeof Blob !== 'undefined' && evt.data instanceof Blob) {
          // Workers may deliver messages as Blob — convert to Uint8Array
          const buf = await evt.data.arrayBuffer();
          data = new Uint8Array(buf);
        } else {
          data = evt.data;
        }
        if (data instanceof Uint8Array) {
          console.debug(`[ws-shim] RECV ${data.length} bytes: first8=[${Array.from(data.slice(0, 8))}]`);
        } else {
          console.debug(`[ws-shim] RECV string: ${String(data).slice(0, 100)}`);
        }
        this.fire('message', data);
      });
      ws.addEventListener('close', (evt: CloseEvent) => {
        console.debug(`[ws-shim] CLOSE code=${evt.code} reason=${evt.reason}`);
        this.settleClose(evt.code, evt.reason);
      });
      ws.addEventListener('error', (evt: Event) => {
        const err = (evt as any).error ?? new Error('Workers WebSocket error event');
        console.error(`[ws-shim] ERROR: ${err.message || err}`);
        this.fire('error', err);
      });

      this.fire('open');
      this.flushQueue();
    } catch (err) {
      this.fire('error', err instanceof Error ? err : new Error(String(err)));
      this.settleClose(1006, String(err));
    }
  }

  // Fires the 'close' event exactly once, however we got here (a real
  // native close event, our own close() timing out, or open() failing).
  // Baileys' own WebSocketClient.close() does:
  //   const p = new Promise(resolve => this.socket.once('close', resolve));
  //   this.socket.close();
  //   await p;
  // -- so if a 'close' event is never fired here, that await hangs
  // forever, which stalls Baileys' whole end()/reconnect sequence
  // (observed: Cloudflare Workers' outbound WebSocket can fail to
  // deliver a clean 'close' event on an already-idle connection --
  // surfacing instead as a workerd-level TLS close_notify runtime error
  // -- leaving Baileys unable to ever notice the socket died).
  private settleClose(code: number, reason: string) {
    if (this.closeSettled) return;
    this.closeSettled = true;
    this.readyState = WorkersWebSocket.CLOSED;
    this.fire('close', code, reason);
  }

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once(event: string, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Listener) {
    return this.off(event, listener);
  }

  emit(event: string, ...args: any[]) {
    this.fire(event, ...args);
    return true;
  }

  setMaxListeners(_n: number) {
    return this;
  }

  private fire(event: string, ...args: any[]) {
    for (const l of this.listeners.get(event) ?? []) {
      try {
        const result = l(...args) as any;
        if (result && typeof result.catch === 'function') {
          result.catch((err: any) => {
            console.error(`[ws-shim] async listener for "${event}" rejected`, err);
          });
        }
      } catch (err) {
        console.error(`[ws-shim] listener for "${event}" threw`, err);
      }
    }
  }

  private flushQueue() {
    const queued = this.sendQueue.splice(0);
    for (const { data, cb } of queued) this.doSend(data, cb);
  }

  send(data: string | Uint8Array, cb?: (err?: Error) => void) {
    if (this.readyState !== WorkersWebSocket.OPEN) {
      this.sendQueue.push({ data, cb });
      return;
    }
    this.doSend(data, cb);
  }

  private doSend(data: string | Uint8Array, cb?: (err?: Error) => void) {
    try {
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      console.debug(`[ws-shim] SEND ${bytes.length} bytes: first8=[${Array.from(bytes.slice(0, 8))}]`);
      this.nativeSocket!.send(data);
      cb?.();
    } catch (err) {
      cb?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(code?: number, reason?: string) {
    if (this.closeSettled || this.readyState === WorkersWebSocket.CLOSING) return;
    this.readyState = WorkersWebSocket.CLOSING;

    if (!this.nativeSocket) {
      // Never finished opening -- nothing will ever fire a native close
      // event for us, so settle immediately.
      this.settleClose(code ?? 1000, reason ?? 'closed before open');
      return;
    }

    try {
      this.nativeSocket.close(code, reason);
    } catch {
      // Native close() threw synchronously -- still fall through to the
      // grace-period timeout below so callers awaiting 'close' aren't
      // left hanging.
    }

    // Give the native 'close' event a chance to fire normally, but never
    // wait longer than this -- see settleClose()'s comment for why this
    // matters (an unresolved close() call otherwise wedges Baileys'
    // entire disconnect/reconnect flow, which is what caused sessions to
    // get permanently stuck instead of automatically getting a fresh QR
    // batch once the old one expired).
    setTimeout(() => this.settleClose(code ?? 1000, reason ?? 'close timed out'), 500);
  }
}
