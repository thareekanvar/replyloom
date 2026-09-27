import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { cn } from "@workspace/ui/lib/utils"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@workspace/ui/components/avatar"
import { Bubble, BubbleContent } from "@workspace/ui/components/bubble"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@workspace/ui/components/message"
import { Marker, MarkerContent } from "@workspace/ui/components/marker"
import {
  CheckIcon,
  CheckCheckIcon,
  ClockIcon,
  TriangleAlertIcon,
  PencilIcon,
} from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { ChatThreadSkeleton } from "@/components/skeletons"
import { MessageMedia } from "./message-media"
import { MessageRichContent } from "./message-rich-content"
import { MessageActions } from "./message-actions"
import { useEditMessage } from "../hooks/use-edit-message"
import type { MediaMeta, Reaction } from "@workspace/db"

interface ChatMessage {
  id: string
  waMessageId: string | null
  direction: "in" | "out"
  senderJid: string | null
  senderName?: string | null
  type: string
  body: string | null
  mediaKey: string | null
  mediaMime: string | null
  mediaMeta: MediaMeta | null
  status: string
  createdAt: number
  reactions?: Reaction[] | null
  editedAt?: number | null
  deleted?: boolean
}

function formatMessageTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDaySeparator(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "long" })
  return d.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  })
}

function getInitials(name: string | null): string {
  if (!name) return "??"
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/** Sent = one grey check. Delivered = two grey checks. Read = two blue-ish (primary) checks. */
function StatusTicks({ status }: { status: string }) {
  if (status === "queued") return <ClockIcon className="size-3" />
  if (status === "failed") return <span className="text-destructive">!</span>
  // WhatsApp-style "read" tint -- needs to read clearly against BOTH the
  // primary-colored outgoing bubble and (if ever reused) a muted one, so a
  // plain `text-primary` (invisible on a text-primary-foreground bubble)
  // won't do; sky reads as "blue ticks" in both contexts.
  if (status === "read")
    return <CheckCheckIcon className="size-3.5 text-sky-400" />
  if (status === "delivered") return <CheckCheckIcon className="size-3.5" />
  return <CheckIcon className="size-3.5" />
}

// Consecutive messages from the same side (and, in a group, the same
// sender) are stacked under one MessageGroup -- WhatsApp/iMessage-style --
// so the avatar and sender name only show once per run instead of once per
// bubble.
function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = []
  // `groups[groups.length - 1]` is undefined on the very first message
  // (empty array), and TS's default indexed-access typing doesn't reflect
  // that -- these checks are load-bearing, not decorative.
  /* eslint-disable @typescript-eslint/no-unnecessary-condition */
  for (const msg of messages) {
    const last = groups[groups.length - 1]
    const lastMsg = last?.[last.length - 1]
    if (
      lastMsg &&
      lastMsg.direction === msg.direction &&
      lastMsg.senderJid === msg.senderJid
    ) {
      last.push(msg)
    } else {
      groups.push([msg])
    }
  }
  /* eslint-enable @typescript-eslint/no-unnecessary-condition */
  return groups
}

export function MessageThread({
  messages,
  isLoading,
  isError,
  hasOlder,
  isLoadingOlder,
  onLoadOlder,
  contactName,
  contactAvatar,
  kind = "direct",
  senderNames,
  waSessionId,
  workspaceId,
  toJid,
  conversationId,
}: {
  messages: ChatMessage[]
  isLoading?: boolean
  isError?: boolean
  hasOlder?: boolean
  isLoadingOlder?: boolean
  onLoadOlder?: () => void
  contactName?: string | null
  contactAvatar?: string | null
  kind?: "direct" | "group"
  senderNames?: Record<string, string>
  waSessionId?: string | null
  workspaceId?: string
  toJid?: string | null
  conversationId?: string
}) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const initialScrollDone = useRef(false)
  const prependHeight = useRef<number | null>(null)
  // Whether the user is parked at (or near) the bottom of the thread.
  // New live messages only auto-scroll into view when they are, so
  // reading older history isn't yanked away -- same as WhatsApp Web.
  const nearBottom = useRef(true)

  // Inline "edit this message" state -- one message editable at a time,
  // matching WhatsApp Web's own edit affordance.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editText, setEditText] = useState("")
  const editMutation = useEditMessage({
    waSessionId: waSessionId ?? null,
    conversationId: conversationId ?? "",
    workspaceId: workspaceId ?? "",
    toJid: toJid ?? null,
  })

  function startEdit(messageId: string, currentBody: string) {
    setEditingMessageId(messageId)
    setEditText(currentBody)
  }

  function cancelEdit() {
    setEditingMessageId(null)
    setEditText("")
  }

  async function saveEdit() {
    if (!editingMessageId) return
    const trimmed = editText.trim()
    if (!trimmed) return
    try {
      await editMutation.mutateAsync({
        messageId: editingMessageId,
        newText: trimmed,
      })
      setEditingMessageId(null)
      setEditText("")
    } catch (err: any) {
      toast.error(err?.message ?? "Couldn't edit message. Please try again.")
    }
  }

  useEffect(() => {
    initialScrollDone.current = false
    prependHeight.current = null
    nearBottom.current = true
  }, [contactName, contactAvatar, kind])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    if (prependHeight.current !== null) {
      container.scrollTop += container.scrollHeight - prependHeight.current
      prependHeight.current = null
    } else if (!initialScrollDone.current) {
      bottomRef.current?.scrollIntoView({ block: "end" })
      initialScrollDone.current = true
    } else {
      // A new message landed (live WS refetch or our own send). Previously
      // nothing scrolled here, so it rendered below the fold and the open
      // chat looked like it never updated.
      const last = messages.at(-1)
      if (nearBottom.current || last?.direction === "out") {
        bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
      }
    }
  }, [messages.length])

  function handleScroll() {
    const container = scrollRef.current
    if (container) {
      nearBottom.current =
        container.scrollHeight - container.scrollTop - container.clientHeight < 120
    }
    if (!container || !hasOlder || isLoadingOlder || !onLoadOlder) return
    if (container.scrollTop <= 24) {
      prependHeight.current = container.scrollHeight
      onLoadOlder()
    }
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <TriangleAlertIcon className="size-8 text-destructive" />
        <span>Couldn't load messages.</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Try again
        </Button>
      </div>
    )
  }

  if (isLoading) {
    return <ChatThreadSkeleton />
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet — say hello 👋
      </div>
    )
  }

  let lastDay: string | null = null

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
    >
      {hasOlder && (
        <div className="flex justify-center py-1 text-xs text-muted-foreground">
          {isLoadingOlder
            ? "Loading older messages…"
            : "Scroll up for older messages"}
        </div>
      )}
      {groupMessages(messages).map((group) => {
        const first = group[0]
        const isOut = first.direction === "out"
        const day = formatDaySeparator(first.createdAt)
        const showSeparator = day !== lastDay
        lastDay = day

        // In a group chat, label who's speaking above their first bubble in
        // the run -- our own outgoing messages never need that label.
        // Prefer the contact name from the message (enriched by the query);
        // fall back to the senderNames map, then to the raw phone number.
        const senderLabel =
          kind === "group" && !isOut
            ? (first.senderName ?? senderNames?.[first.senderJid ?? ""] ?? first.senderJid?.split("@")[0] ?? null)
            : null

        return (
          <div
            key={first.id}
            // content-visibility: the browser skips layout/paint for runs
            // scrolled out of view, so a long thread (infinite-scrolled,
            // re-rendered on every new message) stays smooth without a
            // virtualization library -- same trick as conversation-list rows.
            className="flex flex-col gap-1 [contain-intrinsic-size:auto_96px] [content-visibility:auto]"
          >
            {showSeparator && (
              <Marker variant="separator" className="my-2">
                <MarkerContent>{day}</MarkerContent>
              </Marker>
            )}
            <MessageGroup>
              {group.map((msg, i) => {
                const isLastInGroup = i === group.length - 1
                const FILE_MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"]
                const isMedia = FILE_MEDIA_TYPES.includes(msg.type)
                const isRichType =
                  msg.type === "poll" ||
                  msg.type === "location" ||
                  msg.type === "contact"
                // Stickers (and to a lesser extent images) look right the way
                // WhatsApp Web shows them -- no colored bubble chrome around
                // the picture itself -- so those two use the "ghost" bubble
                // variant; everything else keeps the normal bubble surface.
                const bubbleVariant = isOut ? "default" : "muted"
                const ghost = msg.type === "sticker" || msg.type === "image"

                return (
                  <Message key={msg.id} align={isOut ? "end" : "start"}>
                    {!isOut && (
                      <MessageAvatar
                        className={isLastInGroup ? "" : "invisible"}
                      >
                        <Avatar>
                          <AvatarImage
                            src={contactAvatar ?? undefined}
                            alt=""
                          />
                          <AvatarFallback>
                            {getInitials(contactName ?? null)}
                          </AvatarFallback>
                        </Avatar>
                      </MessageAvatar>
                    )}
                    <MessageContent>
                      {i === 0 && senderLabel && (
                        <MessageHeader>{senderLabel}</MessageHeader>
                      )}
                      {msg.deleted ? (
                        <Bubble
                          align={isOut ? "end" : "start"}
                          variant="ghost"
                        >
                          <BubbleContent>
                            <p className="text-sm italic text-muted-foreground">
                              This message was deleted
                            </p>
                          </BubbleContent>
                        </Bubble>
                      ) : (
                        <>
                          <Bubble
                            align={isOut ? "end" : "start"}
                            variant={ghost ? "ghost" : bubbleVariant}
                          >
                            <BubbleContent>
                              {isMedia && (
                                <MessageMedia
                                  data={{
                                    type: msg.type as
                                      | "image"
                                      | "video"
                                      | "audio"
                                      | "document"
                                      | "sticker",
                                    mediaKey: msg.mediaKey,
                                    mediaMime: msg.mediaMime,
                                    mediaMeta: msg.mediaMeta,
                                  }}
                                  caption={msg.body}
                                />
                              )}
                              {isRichType && (
                                <MessageRichContent
                                  type={msg.type as "poll" | "location" | "contact"}
                                  body={msg.body}
                                />
                              )}
                              {/* editingMessageId defaults to null, and any not-yet-
                                  confirmed outgoing message also has waMessageId: null
                                  (see the optimistic bubble in use-send-message.ts) --
                                  `null === null` was true for every one of those, so
                                  every freshly-sent message rendered this empty edit
                                  box instead of its body until the real waMessageId
                                  came back. Require a real, non-null id on both sides. */}
                              {editingMessageId !== null && editingMessageId === msg.waMessageId ? (
                                <div className="flex min-w-56 flex-col gap-1.5">
                                  <Textarea
                                    autoFocus
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault()
                                        saveEdit()
                                      } else if (e.key === "Escape") {
                                        e.preventDefault()
                                        cancelEdit()
                                      }
                                    }}
                                    className="min-h-16 border-0 bg-black/10 px-2 py-1.5 text-current focus-visible:ring-1"
                                  />
                                  <div className="flex justify-end gap-1.5">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 px-2 text-xs opacity-80 hover:opacity-100"
                                      onClick={cancelEdit}
                                    >
                                      Cancel
                                    </Button>
                                    <Button
                                      size="sm"
                                      className="h-6 px-2 text-xs"
                                      disabled={!editText.trim() || editMutation.isPending}
                                      onClick={saveEdit}
                                    >
                                      {editMutation.isPending ? "Saving…" : "Save"}
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                msg.body &&
                                (msg.type === "text" ||
                                  (isMedia &&
                                    msg.type !== "sticker" &&
                                    msg.type !== "audio")) && (
                                  <p
                                    className={cn(
                                      "break-words whitespace-pre-wrap",
                                      isMedia && "mt-1.5 px-0.5"
                                    )}
                                  >
                                    {msg.body}
                                  </p>
                                )
                              )}
                            </BubbleContent>
                            {/* Message hover actions -- absolutely positioned
                                against the bubble's own built-in `relative`
                                (see bubbleVariants in packages/ui) so they
                                float just above it instead of permanently
                                reserving a row of blank space, and without
                                disturbing the bubble's own width math.
                                It sits flush against the bubble's top edge
                                (no margin gap) so the pointer never crosses
                                unhoverable dead space while moving from the
                                bubble up into the action bar -- separation
                                from the bubble is purely visual, via the
                                shadow, not a literal gap. */}
                            {/* Actions that talk to WhatsApp (react/edit/delete/pin/
                                forward) need the message's REAL WhatsApp id, not our
                                internal DB row id -- a just-sent message can briefly
                                have no waMessageId yet (before the engine's confirm
                                writes it back), and acting on the DB id instead would
                                silently no-op against both WhatsApp and our own D1
                                sync (which also matches by waMessageId). So hide the
                                action bar entirely until it's there, rather than
                                falling back to a fake id. */}
                            {waSessionId && workspaceId && toJid && conversationId && msg.waMessageId &&
                              editingMessageId !== msg.waMessageId && (
                              <div className={cn(
                                "pointer-events-none absolute bottom-full z-10 flex rounded-lg bg-background/95 opacity-0 shadow-md ring-1 ring-border/50 transition-opacity group-hover/message:pointer-events-auto group-hover/message:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                                isOut ? "right-0 justify-end" : "left-0 justify-start"
                              )}>
                                <MessageActions
                                  messageId={msg.waMessageId}
                                  conversationId={conversationId}
                                  waSessionId={waSessionId}
                                  workspaceId={workspaceId}
                                  toJid={toJid}
                                  isOwnMessage={isOut}
                                  senderJid={msg.senderJid}
                                  body={msg.body ?? ""}
                                  onEdit={startEdit}
                                />
                              </div>
                            )}
                            {/* Reactions -- like WhatsApp, this sits ON the
                                bubble as a small badge overlapping its bottom
                                corner, not as a separate row below it. It's a
                                child of Bubble (sibling of BubbleContent, same
                                pattern as the hover-actions block above) so it
                                positions off Bubble's own built-in `relative`
                                and isn't clipped by BubbleContent's
                                overflow-hidden. */}
                            {msg.reactions && msg.reactions.length > 0 && (
                              <div className={cn(
                                "absolute -bottom-2.5 z-20 flex items-center gap-0.5 rounded-full border border-background bg-muted px-1.5 py-0.5 text-xs leading-none shadow-sm",
                                isOut ? "right-1" : "left-1"
                              )}>
                                {msg.reactions.map((r, ri) => (
                                  <span key={ri} title={r.sender.split("@")[0]}>
                                    {r.emoji}
                                  </span>
                                ))}
                              </div>
                            )}
                          </Bubble>
                        </>
                      )}
                      {isLastInGroup && (
                        <MessageFooter className={cn(
                          "gap-1",
                          // Give the overlapping reaction badge room so it
                          // doesn't sit on top of the timestamp text.
                          msg.reactions && msg.reactions.length > 0 && "mt-3"
                        )}>
                          {formatMessageTime(msg.createdAt)}
                          {msg.editedAt && (
                            <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                              <PencilIcon className="size-2.5" />
                              edited
                            </span>
                          )}
                          {isOut && !msg.deleted && <StatusTicks status={msg.status} />}
                        </MessageFooter>
                      )}
                    </MessageContent>
                  </Message>
                )
              })}
            </MessageGroup>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
