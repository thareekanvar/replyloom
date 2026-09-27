import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  SearchIcon,
  PhoneIcon,
  UserIcon,
  SendIcon,
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  UsersIcon,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@workspace/ui/lib/utils"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { searchContacts } from "@/features/contacts/hooks/use-contacts"
import { serverSendMsg } from "@/lib/wa-server"
import { normalizePhoneNumber } from "@workspace/db/phone"

interface NewConversationSheetProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface SelectedContact {
  id: string | null
  name: string | null
  phoneNumber: string | null
  jid: string
  avatarUrl: string | null
  waSessionId: string
  conversationId: string | null
  sessionLabel: string | null
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

export function NewConversationSheet({
  workspaceId,
  open,
  onOpenChange,
}: NewConversationSheetProps) {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState("")
  const [phoneInput, setPhoneInput] = useState("")
  const [selectedSession, setSelectedSession] = useState<string>("")
  const [selectedContact, setSelectedContact] = useState<SelectedContact | null>(
    null
  )
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Fetch connected sessions
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open,
    staleTime: 10_000,
  })

  const connectedSessions = useMemo(
    () => sessions.filter((s) => s.status === "connected"),
    [sessions]
  )

  // Auto-select session when there's only one
  useEffect(() => {
    if (connectedSessions.length === 1 && !selectedSession) {
      setSelectedSession(connectedSessions[0].id)
    }
  }, [connectedSessions, selectedSession])

  // Search contacts -- debounced so typing doesn't fire a D1 query per
  // keystroke (every other contact search in the app debounces too).
  const debouncedQuery = useDebouncedValue(searchQuery.trim())
  const { data: searchResults = [], isLoading: searching } = useQuery({
    queryKey: ["searchContacts", workspaceId, debouncedQuery, selectedSession],
    queryFn: () =>
      searchContacts({
        data: {
          workspaceId,
          query: debouncedQuery,
          waSessionId: selectedSession || undefined,
        },
      }),
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 5_000,
  })

  // Focus search input when sheet opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchInputRef.current?.focus(), 100)
    }
  }, [open])

  // Reset state when sheet closes
  useEffect(() => {
    if (!open) {
      setSearchQuery("")
      setPhoneInput("")
      setSelectedContact(null)
      setMessage("")
      setPhoneError(null)
    }
  }, [open])

  // Validate phone number when typing
  const phoneValidation = useMemo(() => {
    if (!phoneInput.trim()) return null
    return normalizePhoneNumber(phoneInput)
  }, [phoneInput])

  useEffect(() => {
    if (phoneInput.trim() && phoneValidation && !phoneValidation.ok) {
      setPhoneError(phoneValidation.reason)
    } else {
      setPhoneError(null)
    }
  }, [phoneInput, phoneValidation])

  const handleSelectContact = useCallback(
    (contact: (typeof searchResults)[number]) => {
      setSelectedContact({
        id: contact.id,
        name: contact.name,
        phoneNumber: contact.phoneNumber,
        jid: contact.jid,
        avatarUrl: contact.avatarUrl,
        waSessionId: contact.waSessionId,
        conversationId: contact.conversationId,
        sessionLabel: contact.sessionLabel,
      })
      setSelectedSession(contact.waSessionId)
      setSearchQuery("")
      setMessage("")
      setTimeout(() => textareaRef.current?.focus(), 100)
    },
    []
  )

  const handlePhoneSubmit = useCallback(() => {
    if (!phoneInput.trim() || !phoneValidation || !phoneValidation.ok) return
    if (!selectedSession) {
      toast.error("Please select a WhatsApp integration first.")
      return
    }

    setSelectedContact({
      id: null,
      name: null,
      phoneNumber: phoneValidation.e164,
      jid: phoneValidation.jid,
      avatarUrl: null,
      waSessionId: selectedSession,
      conversationId: null,
      sessionLabel:
        connectedSessions.find((s) => s.id === selectedSession)?.label ?? null,
    })
    setPhoneInput("")
    setMessage("")
    setTimeout(() => textareaRef.current?.focus(), 100)
  }, [phoneInput, phoneValidation, selectedSession, connectedSessions])

  const handleSend = useCallback(async () => {
    if (!selectedContact || !message.trim() || sending) return
    setSending(true)
    try {
      await serverSendMsg({
        data: {
          sessionId: selectedContact.waSessionId,
          to: selectedContact.jid,
          text: message.trim(),
        },
      })
      toast.success(
        selectedContact.conversationId
          ? "Message sent"
          : "Message sent — conversation will appear shortly"
      )
      queryClient.invalidateQueries({
        queryKey: ["conversations", workspaceId],
      })
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to send message.")
    } finally {
      setSending(false)
    }
  }, [
    selectedContact,
    message,
    sending,
    queryClient,
    workspaceId,
    onOpenChange,
  ])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <MessageSquarePlusIcon className="size-4" />
            New conversation
          </SheetTitle>
          <SheetDescription>
            Search a contact or enter a phone number to start chatting.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
          {/* Session picker — only when >1 connected session */}
          {connectedSessions.length > 1 && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Send from
              </label>
              <Select value={selectedSession} onValueChange={(v) => setSelectedSession(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) =>
                      v
                        ? connectedSessions.find((s) => s.id === v)?.label ??
                          "Select integration"
                        : "Which number to send from?"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {connectedSessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Contact search — hidden when a contact is selected */}
          {!selectedContact && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Search contacts
                </label>
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name or phone…"
                    className="h-9 pl-8"
                  />
                </div>
              </div>

              {/* Search results */}
              {debouncedQuery.length >= 2 && (
                <div className="space-y-1">
                  {searching ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3 p-2">
                          <Skeleton className="size-9 rounded-full" />
                          <div className="flex-1 space-y-1">
                            <Skeleton className="h-3.5 w-24" />
                            <Skeleton className="h-3 w-16" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
                      {searchResults.map((contact) => (
                        <button
                          key={contact.id}
                          type="button"
                          onClick={() => handleSelectContact(contact)}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                            {contact.avatarUrl ? (
                              <img
                                src={contact.avatarUrl}
                                alt=""
                                className="size-9 rounded-full object-cover"
                              />
                            ) : (
                              getInitials(contact.name, contact.jid)
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">
                              {contact.name ?? "Unknown"}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              {contact.phoneNumber && (
                                <span>{contact.phoneNumber}</span>
                              )}
                              {contact.conversationId && (
                                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                  Existing chat
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      No contacts found. Try a different search or enter a phone
                      number below.
                    </p>
                  )}
                </div>
              )}

              {/* Divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-popover px-2 text-muted-foreground">
                    or enter a new number
                  </span>
                </div>
              </div>

              {/* Phone number input */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Phone number
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <PhoneIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          handlePhoneSubmit()
                        }
                      }}
                      placeholder="+1 234 567 8901"
                      className={cn(
                        "h-9 pl-8",
                        phoneError && "border-destructive"
                      )}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePhoneSubmit}
                    disabled={
                      !phoneInput.trim() ||
                      !phoneValidation ||
                      !phoneValidation.ok ||
                      !selectedSession
                    }
                  >
                    Next
                  </Button>
                </div>
                {phoneError && (
                  <p className="text-xs text-destructive">{phoneError}</p>
                )}
              </div>
            </>
          )}

          {/* Selected contact — show when a contact is picked */}
          {selectedContact && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                  {selectedContact.avatarUrl ? (
                    <img
                      src={selectedContact.avatarUrl}
                      alt=""
                      className="size-10 rounded-full object-cover"
                    />
                  ) : selectedContact.name ? (
                    getInitials(selectedContact.name, selectedContact.jid)
                  ) : (
                    <UserIcon className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {selectedContact.name ?? selectedContact.phoneNumber ?? "Unknown"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {selectedContact.phoneNumber ?? selectedContact.jid.split("@")[0]}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedContact(null)
                    setSearchQuery("")
                    setTimeout(() => searchInputRef.current?.focus(), 100)
                  }}
                >
                  Change
                </Button>
              </div>

              {/* Session label for new contacts */}
              {selectedContact.sessionLabel && !selectedContact.conversationId && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <UsersIcon className="size-3" />
                  Sending via {selectedContact.sessionLabel}
                </div>
              )}

              {/* Existing conversation link */}
              {selectedContact.conversationId && (
                <p className="text-xs text-muted-foreground">
                  This contact already has a conversation. Your message will be
                  added to the existing thread.
                </p>
              )}

              {/* Message textarea */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Message
                </label>
                <Textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your first message…"
                  className="min-h-[100px] resize-none"
                />
                <p className="text-[10px] text-muted-foreground">
                  Enter to send · Shift+Enter for a new line
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Send button — fixed at bottom when composing */}
        {selectedContact && (
          <div className="border-t border-border px-6 py-4">
            <Button
              className="w-full"
              onClick={handleSend}
              disabled={!message.trim() || sending}
            >
              {sending ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SendIcon />
              )}
              {sending ? "Sending…" : "Send message"}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
