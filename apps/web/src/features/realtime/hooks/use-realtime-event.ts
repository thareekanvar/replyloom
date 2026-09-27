import { useContext, useEffect, useRef } from "react"
import { RealtimeContext } from "../lib/context"
import type { RealtimeListener } from "../lib/types"

/**
 * Subscribe a component to every realtime event (all sessions in the
 * workspace). The handler is read through a ref, so passing an inline
 * function doesn't resubscribe on each render.
 */
export function useRealtimeEvent(handler: RealtimeListener) {
  const listeners = useContext(RealtimeContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!listeners) return
    const listener: RealtimeListener = (e) => handlerRef.current(e)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [listeners])
}
