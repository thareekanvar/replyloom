import { getWsToken } from "@/features/integrations/hooks/use-sessions"
import type { RealtimeEvent } from "./types"

/** Opens (and keeps open) one session's socket. Returns a disposer. */
export function openSessionSocket(
  sessionId: string,
  engineUrl: string,
  onEvent: (event: RealtimeEvent) => void
): () => void {
  let disposed = false
  let ws: WebSocket | null = null
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000
  let hasOpenedBefore = false

  async function connect() {
    if (disposed) return
    try {
      // getWsToken resolves directly to the engine's {ok, token} body.
      const tokenResult = await getWsToken({ data: { sessionId } })
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- disposed may flip during the await
      if (disposed) return
      const token = tokenResult?.token
      if (!token) {
        scheduleReconnect()
        return
      }

      // VITE_ENGINE_URL is the engine's http(s) origin -- WebSocket needs ws(s).
      const wsUrl =
        engineUrl.replace(/\/$/, "").replace(/^http/, "ws") +
        `/session/${sessionId}/ws?token=${token}`
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        reconnectDelay = 1000
        const reconnect = hasOpenedBefore
        hasOpenedBefore = true
        onEvent({ type: "socket-open", sessionId, reconnect })
      }
      ws.onmessage = (msg) => {
        let data: RealtimeEvent
        try {
          data = JSON.parse(msg.data)
        } catch {
          return
        }
        onEvent(data)
      }
      ws.onclose = () => {
        ws = null
        scheduleReconnect()
      }
      ws.onerror = () => {
        ws?.close()
      }
    } catch {
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimeout) return
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      connect()
    }, reconnectDelay)
  }

  connect()

  return () => {
    disposed = true
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }
}
