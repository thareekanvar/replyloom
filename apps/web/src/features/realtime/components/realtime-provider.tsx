import { useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { RealtimeContext } from "../lib/context"
import { applyRealtimeEvent } from "../lib/apply-event"
import { openSessionSocket } from "../lib/session-socket"
import type { RealtimeEvent, RealtimeListener } from "../lib/types"

const ENGINE_URL = import.meta.env.VITE_ENGINE_URL

/**
 * App-wide realtime connection. Mounted once in the `_app` layout so live
 * updates (inbox, desktop notifications, broadcasts, session status, QR
 * linking) work on every page -- not just while the inbox is open.
 *
 * Opens one WebSocket per WhatsApp session in the workspace, follows the
 * sessions list (a newly added number is picked up automatically, a
 * deleted one is closed), and reconnects with exponential backoff. There
 * is deliberately no polling fallback: after a reconnect it does a single
 * catch-up refetch of the conversation list to cover the gap, then goes
 * back to purely event-driven updates.
 */
export function RealtimeProvider({
  workspaceId,
  children,
}: {
  workspaceId: string
  children: React.ReactNode
}) {
  const queryClient = useQueryClient()
  const listenersRef = useRef<Set<RealtimeListener>>(new Set())
  const connectionsRef = useRef<Map<string, () => void>>(new Map())

  const { data: sessions } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    staleTime: 30_000,
  })

  // Close everything when the workspace changes / the app shell unmounts.
  useEffect(() => {
    const connections = connectionsRef.current
    return () => {
      for (const dispose of connections.values()) dispose()
      connections.clear()
    }
  }, [workspaceId])

  // Reconcile open sockets with the current sessions list.
  useEffect(() => {
    if (!ENGINE_URL || !Array.isArray(sessions)) return
    const connections = connectionsRef.current
    const wanted = new Set(sessions.map((s: { id: string }) => s.id))

    function dispatch(event: RealtimeEvent) {
      applyRealtimeEvent(queryClient, workspaceId, event)
      for (const listener of listenersRef.current) {
        try {
          listener(event)
        } catch {
          // a broken subscriber must not break the others
        }
      }
    }

    for (const [id, dispose] of connections) {
      if (!wanted.has(id)) {
        dispose()
        connections.delete(id)
      }
    }
    for (const id of wanted) {
      if (!connections.has(id)) {
        connections.set(id, openSessionSocket(id, ENGINE_URL, dispatch))
      }
    }
  }, [sessions, workspaceId, queryClient])

  return (
    <RealtimeContext.Provider value={listenersRef.current}>
      {children}
    </RealtimeContext.Provider>
  )
}
