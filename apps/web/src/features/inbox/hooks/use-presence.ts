import { useCallback, useEffect, useRef } from "react"
import { serverUpdatePresence } from "@/lib/wa-server"

const PAUSE_AFTER_MS = 3000

/**
 * Sends WhatsApp's "typing…" presence to the other side while the person
 * is actively composing, and "paused" once they stop for a few seconds --
 * the same composing/paused pair WhatsApp Web itself sends. Calls are
 * cheap to spam from onChange: this throttles to one "composing" ping
 * per session per burst of typing, using a trailing timer to send "paused".
 */
export function usePresence({
  waSessionId,
  toJid,
}: {
  waSessionId: string | null
  toJid: string | null
}) {
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composingRef = useRef(false)
  const targetRef = useRef<{ waSessionId: string | null; toJid: string | null }>({
    waSessionId,
    toJid,
  })
  targetRef.current = { waSessionId, toJid }

  function send(presence: "composing" | "paused") {
    const { waSessionId: sid, toJid: jid } = targetRef.current
    if (!sid || !jid) return
    serverUpdatePresence({ data: { sessionId: sid, to: jid, presence } }).catch(
      () => undefined // best-effort -- a missed typing indicator isn't worth surfacing
    )
  }

  const notifyTyping = useCallback(() => {
    if (!targetRef.current.waSessionId || !targetRef.current.toJid) return
    if (!composingRef.current) {
      composingRef.current = true
      send("composing")
    }
    if (pauseTimer.current) clearTimeout(pauseTimer.current)
    pauseTimer.current = setTimeout(() => {
      composingRef.current = false
      send("paused")
    }, PAUSE_AFTER_MS)
  }, [])

  const notifyStopped = useCallback(() => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current)
    if (composingRef.current) {
      composingRef.current = false
      send("paused")
    }
  }, [])

  // Switching conversations (or unmounting) shouldn't leave a stale
  // "composing…" showing on a chat that's no longer being typed into.
  useEffect(() => {
    return () => {
      if (pauseTimer.current) clearTimeout(pauseTimer.current)
      if (composingRef.current) send("paused")
    }
  }, [waSessionId, toJid])

  return { notifyTyping, notifyStopped }
}
