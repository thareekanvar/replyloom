import { Panel } from "@workspace/ui/components/panel"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ConversationList } from "./conversation-list"
import type { ConversationCounts } from "./conversation-list"
import type { InboxFilter } from "../hooks/use-conversations"
import { MessageThread } from "./message-thread"
import { MessageComposer } from "./message-composer"
import { InboxSearch } from "./inbox-search"
import { ContactInfoPanel } from "./contact-info-panel"
import { NewConversationSheet } from "./new-conversation-sheet"
import { CreateGroupDialog } from "./create-group-dialog"
import { useSendMessage } from "../hooks/use-send-message"
import { useSendMedia, useSendMediaKey } from "../hooks/use-send-media"
import { useSendTemplate } from "../hooks/use-send-template"
import { useSendPoll } from "../hooks/use-send-poll"
import { useSendLocation } from "../hooks/use-send-location"
import { useSendContactCard } from "../hooks/use-send-contact"
import { usePresence } from "../hooks/use-presence"
import { useConversationActions } from "../hooks/use-conversation-actions"
import { useChatModify } from "../hooks/use-chat-modify"
import { createDealFromConversation } from "@/features/pipeline/hooks/use-pipeline"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import {
  PinIcon,
  PinOffIcon,
  UsersIcon,
  CheckCircle2Icon,
  PanelRightIcon,
  PanelRightCloseIcon,
  MessageSquareIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
} from "lucide-react"
import type { MediaMeta } from "@workspace/db"

interface Conversation {
  id: string
  kind: "direct" | "group"
  status: string
  assignedTo: string | null
  assignedTeamId: string | null
  assigneeName: string | null
  assigneeEmail: string | null
  unreadCount: number
  lastMessageAt: number | null
  pinnedAt: number | null
  archived: boolean
  muted: boolean
  waSessionId: string
  contactId: string | null
  contactName: string | null
  contactAvatar: string | null
  contactJid: string | null
  contactPhone: string | null
  contactLifecycleStage: string | null
  contactAssignedTo: string | null
  contactAssignedTeamId: string | null
  contactPinnedAt: number | null
  contactAbout: string | null
  contactAvatarFetchedAt: number | null
  contactBlocked: boolean | null
  sessionLabel: string | null
  groupName: string | null
  groupJid: string | null
  lastBody: string | null
  lastType: string | null
  lastDirection: string | null
}

interface Message {
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
}

function getInitials(name: string | null, jid: string | null): string {
  if (name)
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  if (jid) return jid.split("@")[0].slice(-2)
  return "??"
}

export function InboxLayout({
  conversations,
  messages,
  selectedConversationId,
  onSelectConversation,
  workspaceId,
  conversationsLoading,
  hasConnectedNumber,
  sessionsLoaded,
  messagesLoading,
  messagesError,
  messagesHasOlder,
  messagesLoadingOlder,
  onLoadOlderMessages,
  conversationsHasMore,
  conversationsLoadingMore,
  onLoadMoreConversations,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  counts,
}: {
  conversations: Conversation[]
  messages: Message[]
  selectedConversationId: string | null
  onSelectConversation: (id: string) => void
  workspaceId: string
  conversationsLoading?: boolean
  /** True when this workspace already has at least one WhatsApp session. */
  hasConnectedNumber?: boolean
  /** False while the sessions query is still in flight (avoid flashing the
   *  "connect your first number" CTA before we know). */
  sessionsLoaded?: boolean
  messagesLoading?: boolean
  messagesError?: boolean
  messagesHasOlder?: boolean
  messagesLoadingOlder?: boolean
  onLoadOlderMessages?: () => void
  conversationsHasMore?: boolean
  conversationsLoadingMore?: boolean
  onLoadMoreConversations?: () => void
  filter: InboxFilter
  onFilterChange: (filter: InboxFilter) => void
  search: string
  onSearchChange: (search: string) => void
  counts?: ConversationCounts
}) {
  const [showDetails, setShowDetails] = useState(true)
  const [newConversationOpen, setNewConversationOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)")
    const apply = () => setShowDetails(mq.matches)
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])
  const selected = conversations.find((c) => c.id === selectedConversationId)
  const conversationName = selected
    ? selected.kind === "group"
      ? selected.groupName
      : selected.contactName
    : null
  const toJid = selected
    ? selected.kind === "group"
      ? selected.groupJid
      : selected.contactJid
    : null

  const sendMessage = useSendMessage({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const sendMedia = useSendMedia({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const sendMediaKey = useSendMediaKey({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const sendTemplate = useSendTemplate({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const sendPoll = useSendPoll({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const sendLocation = useSendLocation({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const sendContactCard = useSendContactCard({
    waSessionId: selected?.waSessionId ?? null,
    conversationId: selectedConversationId,
    workspaceId,
    toJid,
  })

  const { pin, markRead, markUnread, setStatus } =
    useConversationActions(workspaceId)
  const { archive, mute } = useChatModify(workspaceId)
  const presence = usePresence({
    waSessionId: selected?.waSessionId ?? null,
    toJid,
  })

  const queryClient = useQueryClient()

  const convertToDeal = useMutation({
    mutationFn: (conversationId: string) =>
      createDealFromConversation({ data: { workspaceId, conversationId } }),
    onSuccess: (res) => {
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["pipeline", workspaceId] })
        toast.success("Deal created — added to the first pipeline stage")
      } else if (res.reason === "already_deal") {
        toast.info("This contact already has a deal in the pipeline")
      } else if (res.reason === "group") {
        toast.error("Only direct conversations can be converted to a deal")
      } else {
        toast.error("Couldn't create the deal. Please try again.")
      }
    },
  })

  function handleTogglePin(id: string, pinned: boolean) {
    pin.mutate({ conversationId: id, pinned })
  }
  function handleToggleRead(id: string, unread: boolean) {
    if (unread) markUnread.mutate({ conversationId: id })
    else markRead.mutate({ conversationId: id })
  }
  function handleSetStatus(id: string, status: "open" | "resolved") {
    setStatus.mutate({ conversationId: id, status })
  }
  function handleToggleArchive(id: string, archived: boolean) {
    const conv = conversations.find((c) => c.id === id)
    const jid = conv?.kind === "group" ? conv.groupJid : conv?.contactJid
    if (!conv || !jid) return
    archive.mutate({
      conversationId: id,
      waSessionId: conv.waSessionId,
      jid,
      archived,
    })
  }
  function handleToggleMute(id: string, muted: boolean) {
    const conv = conversations.find((c) => c.id === id)
    const jid = conv?.kind === "group" ? conv.groupJid : conv?.contactJid
    if (!conv || !jid) return
    mute.mutate({
      conversationId: id,
      waSessionId: conv.waSessionId,
      jid,
      muted,
    })
  }

  const isResolved = selected?.status === "resolved"
  const isPinned = !!selected?.pinnedAt

  // Opening a conversation is itself the "I've seen this" signal — clear
  // its unread badge the moment it's selected, same as every chat app.
  useEffect(() => {
    if (selected && selected.unreadCount > 0) {
      markRead.mutate({ conversationId: selected.id })
    }
  }, [selected?.id])

  return (
    <Panel className="flex min-h-0 flex-1">
      {/* Conversation list — fixed width */}
      <div
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col border-r border-border lg:w-[340px]",
          selectedConversationId ? "max-lg:hidden" : "max-lg:flex"
        )}
      >
        <ConversationList
          conversations={conversations}
          selectedId={selectedConversationId}
          onSelect={onSelectConversation}
          onTogglePin={handleTogglePin}
          onToggleRead={handleToggleRead}
          onSetStatus={handleSetStatus}
          onToggleArchive={handleToggleArchive}
          onToggleMute={handleToggleMute}
          onNewConversation={() => setNewConversationOpen(true)}
          onNewGroup={() => setNewGroupOpen(true)}
          isLoading={conversationsLoading}
          hasConnectedNumber={hasConnectedNumber}
          sessionsLoaded={sessionsLoaded}
          hasMore={conversationsHasMore}
          isLoadingMore={conversationsLoadingMore}
          onLoadMore={onLoadMoreConversations}
          tab={filter}
          onTabChange={onFilterChange}
          query={search}
          onQueryChange={onSearchChange}
          counts={counts}
        />
      </div>

      {/* Message thread — fills remaining space */}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col bg-background",
          selectedConversationId ? "flex" : "hidden lg:flex"
        )}
      >
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 sm:gap-3 sm:px-4">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                aria-label="Back to conversations"
                onClick={() => onSelectConversation("")}
              >
                <PanelRightIcon className="rotate-180" />
              </Button>
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {selected.kind === "group" ? (
                  <UsersIcon className="size-4 text-muted-foreground" />
                ) : selected.contactAvatar ? (
                  <img
                    src={selected.contactAvatar}
                    alt=""
                    className="size-9 rounded-full object-cover"
                  />
                ) : (
                  getInitials(conversationName, selected.contactJid)
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">
                    {conversationName ?? "Unknown"}
                  </span>
                  {isResolved && (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <CheckCircle2Icon className="size-3" /> Resolved
                    </Badge>
                  )}
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {selected.contactPhone ??
                    selected.contactJid?.split("@")[0] ??
                    selected.groupJid}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  isPinned ? "Unpin conversation" : "Pin conversation"
                }
                onClick={() => handleTogglePin(selected.id, !isPinned)}
              >
                {isPinned ? <PinOffIcon /> : <PinIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={selected.muted ? "Unmute conversation" : "Mute conversation"}
                title={selected.muted ? "Unmute conversation" : "Mute conversation"}
                onClick={() => handleToggleMute(selected.id, !selected.muted)}
                className={selected.muted ? "text-foreground" : undefined}
              >
                {selected.muted ? <BellOffIcon /> : <BellIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={selected.archived ? "Unarchive conversation" : "Archive conversation"}
                title={selected.archived ? "Unarchive conversation" : "Archive conversation"}
                onClick={() => handleToggleArchive(selected.id, !selected.archived)}
              >
                {selected.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              </Button>
              <InboxSearch workspaceId={workspaceId} />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  handleSetStatus(selected.id, isResolved ? "open" : "resolved")
                }
              >
                {isResolved ? "Reopen" : "Mark resolved"}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  showDetails ? "Hide contact details" : "Show contact details"
                }
                onClick={() => setShowDetails((v) => !v)}
                className={
                  showDetails ? "text-foreground" : "text-muted-foreground"
                }
              >
                {showDetails ? <PanelRightCloseIcon /> : <PanelRightIcon />}
              </Button>
            </div>
            <MessageThread
              key={selectedConversationId}
              messages={messages}
              isLoading={messagesLoading}
              isError={messagesError}
              hasOlder={messagesHasOlder}
              isLoadingOlder={messagesLoadingOlder}
              onLoadOlder={onLoadOlderMessages}
              contactName={conversationName}
              contactAvatar={selected.contactAvatar}
              kind={selected.kind}
              waSessionId={selected.waSessionId}
              workspaceId={workspaceId}
              toJid={toJid}
              conversationId={selectedConversationId ?? undefined}
            />
            <MessageComposer
              disabled={!toJid}
              onSend={(text) => sendMessage.mutateAsync(text)}
              onSendMedia={(file, type, caption) =>
                sendMedia.mutateAsync({ file, type, caption })
              }
              onSendMediaKey={(opts) => sendMediaKey.mutateAsync(opts)}
              workspaceId={workspaceId}
              draftKey={selected.id}
              contact={
                selected.kind === "direct"
                  ? {
                      name: selected.contactName,
                      phoneNumber: selected.contactPhone,
                      lifecycleStage: selected.contactLifecycleStage,
                    }
                  : null
              }
              onSendTemplate={(opts) => sendTemplate.mutateAsync(opts)}
              onSendPoll={(opts) => sendPoll.mutateAsync(opts)}
              onSendLocation={(opts) => sendLocation.mutateAsync(opts)}
              onSendContactCard={(opts) => sendContactCard.mutateAsync(opts)}
              onTyping={presence.notifyTyping}
            />
          </>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquareIcon />
              </EmptyMedia>
              <EmptyTitle>Select a conversation</EmptyTitle>
              <EmptyDescription>
                Pick a conversation from the list to view messages and reply.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>

      {/* Contact details -- who am I talking to, right next to the thread
          so there's no context switch mid-conversation. On screens narrower
          than xl it collapses to an overlay on demand instead of squeezing
          the thread. */}
      {selected && showDetails && (
        <div
          className={cn(
            "min-h-0 shrink-0 flex-col overflow-y-auto border-l border-border bg-background",
            "absolute inset-y-0 right-0 z-20 flex w-[min(85vw,300px)] shadow-xl xl:static xl:w-[300px] xl:shadow-none"
          )}
        >
          <ContactInfoPanel
            conversation={selected}
            workspaceId={workspaceId}
            onConvertToDeal={
              selected.kind === "direct"
                ? () => convertToDeal.mutate(selected.id)
                : undefined
            }
            convertingToDeal={convertToDeal.isPending}
          />
        </div>
      )}

      <NewConversationSheet
        workspaceId={workspaceId}
        open={newConversationOpen}
        onOpenChange={setNewConversationOpen}
      />
      <CreateGroupDialog
        workspaceId={workspaceId}
        open={newGroupOpen}
        onOpenChange={setNewGroupOpen}
      />
    </Panel>
  )
}
