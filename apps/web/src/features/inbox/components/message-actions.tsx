import { useState, useRef, useCallback } from "react"
import { toast } from "sonner"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Button } from "@workspace/ui/components/button"
import {
  SmileIcon,
  PencilIcon,
  Trash2Icon,
  ForwardIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react"
import { EMOJI_CATEGORIES } from "./emoji-data"
import { useReactMessage } from "../hooks/use-react-message"
import { useDeleteMessage } from "../hooks/use-delete-message"
import { useForwardMessage } from "../hooks/use-forward-message"
import { usePinMessage } from "../hooks/use-pin-message"

export function MessageActions({
  messageId,
  conversationId,
  waSessionId,
  workspaceId,
  toJid,
  isOwnMessage,
  senderJid,
  body,
  onEdit,
}: {
  messageId: string
  conversationId: string
  waSessionId: string | null
  workspaceId: string
  toJid: string | null
  isOwnMessage: boolean
  /** Original sender's jid, for group messages -- Baileys needs this as
   * the WAMessageKey `participant` when acting on someone else's message
   * in a group (reacting/deleting/pinning your own never needs it). */
  senderJid?: string | null
  body: string
  onEdit?: (messageId: string, currentBody: string) => void
}) {
  const [reactionOpen, setReactionOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState(0)
  const [showForward, setShowForward] = useState(false)
  const [forwardTarget, setForwardTarget] = useState("")
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const reactMutation = useReactMessage({
    waSessionId,
    conversationId,
    workspaceId,
    toJid,
  })

  const deleteMutation = useDeleteMessage({
    waSessionId,
    conversationId,
    workspaceId,
    toJid,
  })

  const forwardMutation = useForwardMessage({
    waSessionId,
    workspaceId,
  })

  const pinMutation = usePinMessage({ waSessionId, toJid })
  const [isPinned, setIsPinned] = useState(false)

  const handleReact = useCallback(
    (emoji: string) => {
      reactMutation.mutate({
        messageId,
        emoji,
        fromMe: isOwnMessage,
        participant: isOwnMessage ? undefined : senderJid,
      })
      setReactionOpen(false)
    },
    [reactMutation, messageId, isOwnMessage, senderJid]
  )

  const handleDelete = useCallback(
    (forEveryone: boolean) => {
      deleteMutation.mutate({
        messageId,
        forEveryone,
        fromMe: isOwnMessage,
        participant: isOwnMessage ? undefined : senderJid,
      })
      setShowDeleteConfirm(false)
    },
    [deleteMutation, messageId, isOwnMessage, senderJid]
  )

  const handlePin = useCallback(() => {
    const next = !isPinned
    pinMutation.mutate(
      {
        messageId,
        pin: next,
        fromMe: isOwnMessage,
        participant: isOwnMessage ? undefined : senderJid,
      },
      {
        onSuccess: () => {
          setIsPinned(next)
          toast.success(next ? "Message pinned" : "Message unpinned")
        },
        onError: () => toast.error("Couldn't update the pin. Please try again."),
      }
    )
  }, [pinMutation, messageId, isPinned, isOwnMessage, senderJid])

  const handleForward = useCallback(() => {
    if (!forwardTarget) return
    forwardMutation.mutate({
      messageId,
      from: toJid ?? "",
      to: forwardTarget,
      text: body,
    })
    setShowForward(false)
    setForwardTarget("")
  }, [forwardMutation, messageId, toJid, forwardTarget, body])

  return (
    <div ref={containerRef} className="flex items-center gap-0.5 p-0.5">
      <Popover open={reactionOpen} onOpenChange={setReactionOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label="React"
            />
          }
        >
          <SmileIcon className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-72 gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5">
            {EMOJI_CATEGORIES.map((cat, i) => (
              <button
                key={cat.label}
                type="button"
                title={cat.label}
                onClick={() => setActiveCategory(i)}
                className={`shrink-0 rounded-md px-2 py-1 text-lg leading-none hover:bg-accent ${
                  activeCategory === i ? "bg-accent" : ""
                }`}
              >
                {cat.emojis[0]}
              </button>
            ))}
          </div>
          <div className="grid max-h-48 grid-cols-8 gap-0.5 overflow-y-auto p-2">
            {EMOJI_CATEGORIES[activeCategory].emojis.map((emoji, i) => (
              <button
                key={`${emoji}-${i}`}
                type="button"
                onClick={() => handleReact(emoji)}
                className="flex size-7 items-center justify-center rounded-md text-lg leading-none hover:bg-accent"
              >
                {emoji}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {isOwnMessage && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Edit"
          onClick={() => onEdit?.(messageId, body)}
        >
          <PencilIcon className="size-3.5" />
        </Button>
      )}

      <Popover open={showForward} onOpenChange={setShowForward}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label="Forward"
            />
          }
        >
          <ForwardIcon className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-64 p-2">
          <p className="mb-2 text-xs text-muted-foreground">Forward to:</p>
          <div className="flex gap-1">
            <input
              type="text"
              value={forwardTarget}
              onChange={(e) => setForwardTarget(e.target.value)}
              placeholder="Phone number or JID"
              className="h-7 flex-1 min-w-0 rounded-md border border-border bg-background px-2 text-xs"
              autoFocus
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-xs"
              onClick={handleForward}
              disabled={!forwardTarget || forwardMutation.isPending}
            >
              Forward
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        variant="ghost"
        size="icon"
        className={`size-7 ${isPinned ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
        aria-label={isPinned ? "Unpin message" : "Pin message"}
        title={isPinned ? "Unpin message" : "Pin message"}
        disabled={pinMutation.isPending}
        onClick={handlePin}
      >
        {isPinned ? (
          <PinOffIcon className="size-3.5" />
        ) : (
          <PinIcon className="size-3.5" />
        )}
      </Button>

      {isOwnMessage && (
        <Popover open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-destructive"
                aria-label="Delete"
              />
            }
          >
            <Trash2Icon className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent align="center" side="top" className="w-auto p-2">
            <p className="mb-2 text-xs text-muted-foreground">Delete message?</p>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleDelete(false)}
              >
                Delete for me
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleDelete(true)}
              >
                Delete for everyone
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
