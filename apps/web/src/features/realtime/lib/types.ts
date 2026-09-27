// Event shapes pushed by the engine's per-session Durable Object over
// the browser WebSocket (see apps/worker/src/session/whatsapp-session.ts).

export interface ConversationPatch {
  lastBody: string | null
  lastType: string
  lastDirection: "in" | "out"
  /** Milliseconds since epoch (the conversation list itself uses seconds). */
  lastMessageAt: number
  unreadCountDelta: number
}

export interface NewMessageEvent {
  type: "new-message"
  sessionId: string
  workspaceId: string
  conversationId: string
  message: {
    remoteJid: string
    fromMe: boolean
    type: string
    body: string | null
    waMessageId: string
    timestampMs: number
    pushName?: string | null
    upsertType?: "notify" | "append"
  }
  conversationPatch: ConversationPatch
}

/** A delivery/read receipt advanced one of our messages' status. */
export interface MessageStatusEvent {
  type: "message-status"
  sessionId: string
  workspaceId: string
  conversationId: string
  /** wa_message_ids that advanced (one event per conversation per batch). */
  messageIds: string[]
  status: "queued" | "sent" | "delivered" | "read" | "failed"
}

export interface SessionStatusEvent {
  type: "session-status"
  sessionId: string
  status: string
  user: string | null
}

export interface ChatStateEvent {
  type: "chat-state"
  sessionId: string
  workspaceId: string
  jid: string
  update: { archived?: boolean; muted?: boolean }
}

export interface CampaignProgressEvent {
  type: "campaign-progress"
  sessionId: string
  campaignId: string
  recipientStatus?: "sent" | "failed"
  campaignStatus?: string
}

export interface ScheduledMessageEvent {
  type: "scheduled-message"
  sessionId: string
  scheduledMessageId: string
  status: "sent" | "failed"
}

/** Synthetic, client-side: a session's socket just (re)opened. Lets a
 * component do a one-off catch-up read for anything it may have missed
 * while the socket was down -- never a poll. */
export interface SocketOpenEvent {
  type: "socket-open"
  sessionId: string
  /** false on the first open, true after a drop. */
  reconnect: boolean
}

/** A change to a single message in a single thread. `conversationId` scopes
 *  the client's cache invalidation to that thread; it is absent when the
 *  message isn't in D1 (unknown to us), in which case the client falls back
 *  to refreshing every thread. */
export interface MessageMutationEvent {
  type: "message-reaction" | "message-edited" | "message-deleted"
  sessionId: string
  messageId: string
  conversationId?: string
  reaction?: { emoji: string; sender: string; timestampMs: number }
  newBody?: string
}

export interface OtherEvent {
  type: "presence.update" | "call"
  sessionId: string
  [key: string]: unknown
}

export type RealtimeEvent =
  | NewMessageEvent
  | MessageStatusEvent
  | SessionStatusEvent
  | ChatStateEvent
  | CampaignProgressEvent
  | ScheduledMessageEvent
  | SocketOpenEvent
  | MessageMutationEvent
  | OtherEvent

export type RealtimeListener = (event: RealtimeEvent) => void
