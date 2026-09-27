import { useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { getNotificationPreferences } from "@/features/settings/hooks/use-settings"
import { useRealtimeEvent } from "@/features/realtime/hooks/use-realtime-event"
import { findCachedConversation } from "@/features/inbox/lib/conversation-cache"

function playChime() {
  try {
    // lib.dom types AudioContext as always present, but older/Safari
    // builds only expose the vendor-prefixed one (or neither) -- this is
    // real feature detection.
    /* eslint-disable @typescript-eslint/no-unnecessary-condition */
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = "sine"
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4)
    osc.start()
    osc.stop(ctx.currentTime + 0.4)
    osc.onended = () => ctx.close()
  } catch {
    // Autoplay restrictions or an unsupported browser -- silently skip,
    // this is a nice-to-have, never worth surfacing an error for.
  }
}

/** Messages older than this aren't "new" (offline catch-up / backfill). */
const MAX_AGE_MS = 60_000
/** Collapse a burst of messages into one chime. */
const CHIME_COOLDOWN_MS = 1500

/** Looks the conversation up in whichever conversation list is cached. */
function findConversation(
  queryClient: QueryClient,
  workspaceId: string,
  conversationId: string
): any {
  return findCachedConversation(queryClient, workspaceId, conversationId)
}

/**
 * App-wide desktop notification + chime for new inbound WhatsApp
 * messages, per the user's saved preferences. Driven directly by the
 * realtime `new-message` event (no polling, no diffing the conversation
 * list), so it fires on every page -- including for a brand-new contact's
 * first message. Must be rendered inside RealtimeProvider.
 *
 * Skipped: our own outbound messages, muted conversations, and
 * backfill/offline catch-up (Baileys "append" older than a minute).
 * Desktop popups only show while the tab is in the background; the chime
 * plays either way.
 */
export function useDesktopNotifications(workspaceId: string) {
  const queryClient = useQueryClient()
  const lastChimeRef = useRef(0)

  const { data: prefs } = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: () => getNotificationPreferences(),
    staleTime: 60_000,
  })

  useRealtimeEvent((event) => {
    if (event.type !== "new-message") return
    if (!prefs?.desktopEnabled && !prefs?.soundEnabled) return

    const { message, conversationId } = event
    if (message.fromMe) return
    if (
      message.upsertType === "append" &&
      Date.now() - message.timestampMs > MAX_AGE_MS
    )
      return

    const conv = findConversation(queryClient, workspaceId, conversationId)
    if (conv?.muted) return

    if (prefs.soundEnabled) {
      const now = Date.now()
      if (now - lastChimeRef.current > CHIME_COOLDOWN_MS) {
        lastChimeRef.current = now
        playChime()
      }
    }

    if (
      prefs.desktopEnabled &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      document.visibilityState !== "visible"
    ) {
      const title =
        (conv?.kind === "group" ? conv.groupName : conv?.contactName) ??
        message.pushName ??
        message.remoteJid.split("@")[0] ??
        "New message"
      const body =
        message.body ??
        (message.type !== "text" ? `Sent a ${message.type}` : "New message")
      const n = new Notification(title, { body, tag: conversationId })
      n.onclick = () => {
        window.focus()
        n.close()
      }
    }
  })
}
