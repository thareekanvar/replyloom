import { createContext } from "react"
import type { RealtimeListener } from "./types"

/** Listener registry shared by RealtimeProvider and useRealtimeEvent. */
export const RealtimeContext = createContext<Set<RealtimeListener> | null>(null)
