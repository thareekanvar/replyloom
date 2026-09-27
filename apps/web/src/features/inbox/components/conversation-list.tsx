import { useRef, useState } from "react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@workspace/ui/components/empty"
import { Link } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { AvatarListSkeleton } from "@/components/skeletons"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
} from "@workspace/ui/components/pagination"
import {
  PinIcon,
  PinOffIcon,
  SearchIcon,
  InboxIcon,
  MailOpenIcon,
  MailIcon,
  CheckCircle2Icon,
  RotateCcwIcon,
  UsersIcon,
  EllipsisVerticalIcon,
  ImageIcon,
  VideoIcon,
  MicIcon,
  FileTextIcon,
  StickerIcon,
  MessageSquarePlusIcon,
  SmartphoneIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellOffIcon,
  BellIcon,
} from "lucide-react"
import type { InboxFilter } from "../hooks/use-conversations"
import { formatCompactCount } from "@/lib/format-count"

interface Conversation {
  id: string
  kind: "direct" | "group"
  status: string
  unreadCount: number
  lastMessageAt: number | null
  pinnedAt: number | null
  archived?: boolean
  muted?: boolean
  contactName: string | null
  contactAvatar: string | null
  contactJid: string | null
  contactPhone: string | null
  groupName: string | null
  lastBody: string | null
  lastType: string | null
  lastDirection: string | null
}

function formatTime(ts: number | null): string {
  if (!ts) return ""
  const d = new Date(ts * 1000)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0)
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (diffDays === 1) return "Yesterday"
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" })
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function getInitials(name: string | null, jid: string | null): string {
  if (name) {
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase()
  }
  if (jid) return jid.split("@")[0].slice(-2)
  return "??"
}

const TYPE_ICON: Record<string, typeof ImageIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: MicIcon,
  document: FileTextIcon,
  sticker: StickerIcon,
}

function previewFor(conv: Conversation): {
  icon: typeof ImageIcon | null
  text: string
} {
  if (!conv.lastBody && !conv.lastType)
    return { icon: null, text: "No messages yet" }
  const prefix = conv.lastDirection === "out" ? "You: " : ""
  const Icon =
    conv.lastType && conv.lastType !== "text"
      ? (TYPE_ICON[conv.lastType] ?? null)
      : null
  if (conv.lastBody) return { icon: Icon, text: `${prefix}${conv.lastBody}` }
  const label = conv.lastType
    ? conv.lastType[0].toUpperCase() + conv.lastType.slice(1)
    : "Message"
  return { icon: Icon, text: `${prefix}${label}` }
}

type FilterTab = InboxFilter

/** Exact server-side tab counts (trigger-maintained counters). */
export type ConversationCounts = {
  all: number
  direct: number
  unread: number
  groups: number
  pinned: number
  archived: number
}

function badge(n: number | undefined) {
  if (!n) return ""
  return ` (${formatCompactCount(n)})`
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onTogglePin,
  onToggleRead,
  onSetStatus,
  onToggleArchive,
  onToggleMute,
  onNewConversation,
  onNewGroup,
  isLoading,
  hasConnectedNumber,
  sessionsLoaded,
  hasMore,
  isLoadingMore,
  onLoadMore,
  tab,
  onTabChange,
  query,
  onQueryChange,
  counts,
}: {
  conversations: Conversation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleRead: (id: string, unread: boolean) => void
  onSetStatus: (id: string, status: "open" | "resolved") => void
  onToggleArchive?: (id: string, archived: boolean) => void
  onToggleMute?: (id: string, muted: boolean) => void
  onNewConversation?: () => void
  onNewGroup?: () => void
  isLoading?: boolean
  /** True when this workspace already has at least one WhatsApp session —
   *  so the empty state must not tell the user to "connect your first
   *  number" again. */
  hasConnectedNumber?: boolean
  /** False while the sessions query is still loading. */
  sessionsLoaded?: boolean
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
  tab: FilterTab
  onTabChange: (tab: FilterTab) => void
  query: string
  onQueryChange: (query: string) => void
  counts?: ConversationCounts
}) {
  const setQuery = onQueryChange
  const setTab = onTabChange
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [closingMenuId, setClosingMenuId] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tab filtering and search happen on the server (getConversationsPage):
  // filtering only the loaded pages missed every match further down.
  const filtered = conversations
  // "Nothing at all yet" only on the unfiltered All tab; any other empty
  // result is a filter/search miss.
  const trulyEmpty = tab === "all" && query.trim() === "" && conversations.length === 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations…"
              className="h-8 pl-8"
            />
          </div>
          {onNewConversation && onNewGroup ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label="Start something new"
                    title="Start something new"
                  />
                }
              >
                <MessageSquarePlusIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onNewConversation}>
                  <MessageSquarePlusIcon /> New conversation
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onNewGroup}>
                  <UsersIcon /> New group
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            onNewConversation && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={onNewConversation}
                aria-label="New conversation"
                title="New conversation"
              >
                <MessageSquarePlusIcon className="size-4" />
              </Button>
            )
          )}
        </div>
        <Tabs
          value={tab}
          onValueChange={(v) =>
            // Tabs' onValueChange gives a plain string; the cast doesn't
            // make an unexpected value impossible, so keep the fallback.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            setTab((v as FilterTab) ?? "all")
          }
        >
          {/* 6 tabs (with count suffixes like "Unread (12)") don't fit an
              equal-width flex-1 row in a narrow sidebar -- flex items don't
              shrink below their content's natural width without min-w-0,
              which is exactly what was pushing "Archived" off the edge.
              Rather than cram/truncate the labels, this scrolls
              horizontally like WhatsApp's own chat filter chips: each tab
              keeps its natural readable width (shrink-0) and the row
              scrolls, with the scrollbar itself hidden for a cleaner look. */}
          <div className="overflow-x-auto no-scrollbar">
            <TabsList className="w-fit min-w-full">
              <TabsTrigger value="all" className="shrink-0" title={counts ? `${counts.all.toLocaleString()} conversations` : undefined}>
                All{badge(counts?.all)}
              </TabsTrigger>
              <TabsTrigger value="direct" className="shrink-0" title={counts ? `${counts.direct.toLocaleString()} direct chats` : undefined}>
                Direct{badge(counts?.direct)}
              </TabsTrigger>
              <TabsTrigger value="groups" className="shrink-0">
                Groups{badge(counts?.groups)}
              </TabsTrigger>
              <TabsTrigger value="unread" className="shrink-0">
                Unread{badge(counts?.unread)}
              </TabsTrigger>
              <TabsTrigger value="pinned" className="shrink-0">
                Pinned{badge(counts?.pinned)}
              </TabsTrigger>
              <TabsTrigger value="archived" className="shrink-0">
                Archived{badge(counts?.archived)}
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <AvatarListSkeleton rows={7} />
        ) : filtered.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {trulyEmpty ? <InboxIcon /> : <SearchIcon />}
              </EmptyMedia>
              <EmptyTitle>
                {trulyEmpty
                  ? "No conversations yet"
                  : tab === "archived"
                    ? "No archived conversations"
                    : "No matches"}
              </EmptyTitle>
              <EmptyDescription>
                {trulyEmpty
                  ? hasConnectedNumber
                    ? "Your number is connected. Chats will appear here as messages come in — history may still be syncing."
                    : "Connect a WhatsApp integration to start receiving messages."
                  : tab === "archived"
                    ? "Conversations you archive will show up here."
                    : "Try a different search term or filter."}
              </EmptyDescription>
            </EmptyHeader>
            {trulyEmpty &&
              sessionsLoaded &&
              !hasConnectedNumber && (
                <EmptyContent>
                  <Button
                    render={<Link to="/integrations" />}
                    nativeButton={false}
                    size="sm"
                  >
                    <SmartphoneIcon className="size-4" />
                    Connect your first number
                  </Button>
                </EmptyContent>
              )}
            {trulyEmpty && hasConnectedNumber && (
              <EmptyContent>
                <Button
                  render={<Link to="/integrations" />}
                  nativeButton={false}
                  size="sm"
                  variant="outline"
                >
                  <SmartphoneIcon className="size-4" />
                  Manage integrations
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => {
              const name =
                conv.kind === "group" ? conv.groupName : conv.contactName
              const avatar = conv.kind === "group" ? null : conv.contactAvatar
              const initials = getInitials(name, conv.contactJid)
              const { icon: PreviewIcon, text: previewText } = previewFor(conv)
              const isPinned = !!conv.pinnedAt
              const isResolved = conv.status === "resolved"

              return (
                <div
                  key={conv.id}
                  role="button"
                  tabIndex={0}
                  aria-selected={selectedId === conv.id}
                  onClick={() => onSelect(conv.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onSelect(conv.id)
                    }
                  }}
                  className={cn(
                    // content-visibility: the browser skips layout/paint for
                    // rows scrolled out of view, so a long infinite-scrolled
                    // inbox stays smooth without a virtualization library.
                    "group relative flex w-full items-start gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors [contain-intrinsic-size:auto_72px] [content-visibility:auto] hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
                    selectedId === conv.id && "bg-muted"
                  )}
                >
                  <div className="relative shrink-0">
                    <div className="flex size-10 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {avatar ? (
                        <img
                          src={avatar}
                          alt={name ?? ""}
                          className="size-10 rounded-full object-cover"
                        />
                      ) : conv.kind === "group" ? (
                        <UsersIcon className="size-4.5 text-muted-foreground" />
                      ) : (
                        initials
                      )}
                    </div>
                    {isResolved && (
                      <CheckCircle2Icon className="absolute -right-0.5 -bottom-0.5 size-4 rounded-full bg-background text-primary" />
                    )}
                  </div>

                  <div className="flex flex-1 flex-col gap-1 overflow-hidden">
                    <div className="flex items-center gap-1.5">
                      {isPinned && (
                        <PinIcon className="size-3 shrink-0 fill-muted-foreground text-muted-foreground" />
                      )}
                      {conv.muted && (
                        <BellOffIcon className="size-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-sm font-medium">
                        {name ?? "Unknown"}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground group-hover:hidden">
                        {formatTime(conv.lastMessageAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground">
                        {PreviewIcon && (
                          <PreviewIcon className="size-3 shrink-0" />
                        )}
                        <span className="truncate">{previewText}</span>
                      </span>
                      {conv.unreadCount > 0 && (
                        <Badge
                          variant="default"
                          className="size-5 shrink-0 rounded-full p-0 text-[10px]"
                        >
                          {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Row actions — hidden until hover/focus (or on touch,
                      where there's no hover) so the list stays clean */}
                  <div
                    className={cn(
                      "absolute top-2 right-2 hidden items-center gap-0.5 rounded-md bg-background/95 group-focus-within:flex group-hover:flex [@media(hover:none)]:flex",
                      (openMenuId === conv.id || closingMenuId === conv.id) &&
                        "flex"
                    )}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      aria-label={
                        isPinned ? "Unpin conversation" : "Pin conversation"
                      }
                      onClick={() => onTogglePin(conv.id, !isPinned)}
                      className="flex size-6 items-center justify-center rounded hover:bg-muted"
                    >
                      {isPinned ? (
                        <PinOffIcon className="size-3.5" />
                      ) : (
                        <PinIcon className="size-3.5" />
                      )}
                    </button>
                    <DropdownMenu
                      open={openMenuId === conv.id}
                      onOpenChange={(open) => {
                        if (closeTimer.current) clearTimeout(closeTimer.current)

                        if (open) {
                          setClosingMenuId(null)
                          setOpenMenuId(conv.id)
                          return
                        }

                        setOpenMenuId(null)
                        setClosingMenuId(conv.id)
                        closeTimer.current = setTimeout(() => {
                          setClosingMenuId((id) =>
                            id === conv.id ? null : id
                          )
                        }, 150)
                      }}
                    >
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            aria-label="More actions"
                            className="flex size-6 items-center justify-center rounded hover:bg-muted"
                          />
                        }
                      >
                        <EllipsisVerticalIcon className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-44 data-closed:invisible"
                      >
                        <DropdownMenuItem
                          onClick={() => onTogglePin(conv.id, !isPinned)}
                        >
                          {isPinned ? <PinOffIcon /> : <PinIcon />}
                          {isPinned ? "Unpin" : "Pin"} conversation
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            onToggleRead(conv.id, conv.unreadCount === 0)
                          }
                        >
                          {conv.unreadCount > 0 ? (
                            <MailOpenIcon />
                          ) : (
                            <MailIcon />
                          )}
                          Mark as {conv.unreadCount > 0 ? "read" : "unread"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            onSetStatus(
                              conv.id,
                              isResolved ? "open" : "resolved"
                            )
                          }
                        >
                          {isResolved ? (
                            <RotateCcwIcon />
                          ) : (
                            <CheckCircle2Icon />
                          )}
                          {isResolved ? "Reopen" : "Mark resolved"}
                        </DropdownMenuItem>
                        {onToggleMute && (
                          <DropdownMenuItem
                            onClick={() => onToggleMute(conv.id, !conv.muted)}
                          >
                            {conv.muted ? <BellIcon /> : <BellOffIcon />}
                            {conv.muted ? "Unmute" : "Mute"}
                          </DropdownMenuItem>
                        )}
                        {onToggleArchive && (
                          <DropdownMenuItem
                            onClick={() =>
                              onToggleArchive(conv.id, !conv.archived)
                            }
                          >
                            {conv.archived ? (
                              <ArchiveRestoreIcon />
                            ) : (
                              <ArchiveIcon />
                            )}
                            {conv.archived ? "Unarchive" : "Archive"}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}
            {hasMore && (
              <Pagination className="p-2">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      aria-disabled={isLoadingMore}
                      onClick={(event) => {
                        event.preventDefault()
                        if (!isLoadingMore) onLoadMore?.()
                      }}
                      text={isLoadingMore ? "Loading…" : "Next conversations"}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
