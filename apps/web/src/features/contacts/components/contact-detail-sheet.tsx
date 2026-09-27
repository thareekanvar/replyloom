import { useEffect, useState } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Badge } from "@workspace/ui/components/badge"
import { Textarea } from "@workspace/ui/components/textarea"
import { Separator } from "@workspace/ui/components/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  PinIcon,
  PinOffIcon,
  MessageSquareIcon,
  StickyNoteIcon,
  BanIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  getContactTags,
  getContactNotes,
  addNote,
  updateContact,
  setContactPinned,
} from "../hooks/use-contacts"
import { useBlockContact } from "../hooks/use-block-contact"
import { shownOf, totalOf } from "@/lib/format-count"

export interface ContactSummary {
  id: string
  name: string | null
  phoneNumber: string | null
  jid: string
  lifecycleStage: string
  pinnedAt: number | null
  blocked: boolean
  conversationId: string | null
  waSessionId?: string | null
}

const STAGES = ["lead", "active", "customer", "churned"] as const

export function ContactDetailSheet({
  contact,
  workspaceId,
  onOpenChange,
}: {
  contact: ContactSummary | null
  workspaceId: string
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [noteText, setNoteText] = useState("")

  useEffect(() => {
    setName(contact?.name ?? "")
    setNoteText("")
  }, [contact?.id])

  const tagsQuery = useQuery({
    queryKey: ["contact-tags", contact?.id],
    queryFn: () => getContactTags({ data: { contactId: contact!.id } }),
    enabled: !!contact,
  })

  const notesQuery = useInfiniteQuery({
    queryKey: ["contact-notes", contact?.id],
    queryFn: ({ pageParam }) =>
      getContactNotes({ data: { contactId: contact!.id, cursor: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!contact,
  })
  const noteItems = notesQuery.data?.pages.flatMap((p) => p.items) ?? []

  function invalidateContacts() {
    queryClient.invalidateQueries({ queryKey: ["contacts", workspaceId] })
  }

  const saveNameMutation = useMutation({
    mutationFn: (value: string) =>
      updateContact({ data: { workspaceId, contactId: contact!.id, name: value } }),
    onSuccess: () => {
      invalidateContacts()
      toast.success("Contact updated")
    },
  })

  const stageMutation = useMutation({
    mutationFn: (stage: string) =>
      updateContact({
        data: { workspaceId, contactId: contact!.id, lifecycleStage: stage },
      }),
    onSuccess: invalidateContacts,
  })

  const pinMutation = useMutation({
    mutationFn: (pinned: boolean) =>
      setContactPinned({ data: { contactId: contact!.id, pinned } }),
    onSuccess: invalidateContacts,
  })

  const blockMutation = useBlockContact(workspaceId)

  const addNoteMutation = useMutation({
    mutationFn: (body: string) =>
      addNote({ data: { contactId: contact!.id, workspaceId, body } }),
    onSuccess: () => {
      setNoteText("")
      queryClient.invalidateQueries({
        queryKey: ["contact-notes", contact?.id],
      })
    },
  })

  if (!contact) {
    return <Sheet open={false} onOpenChange={onOpenChange} />
  }

  const isPinned = !!contact.pinnedAt

  return (
    <Sheet open={!!contact} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="truncate">
              {contact.name ?? "Unknown contact"}
              {contact.blocked && (
                <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">
                  Blocked
                </Badge>
              )}
            </SheetTitle>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={contact.blocked ? "Unblock contact" : "Block contact"}
                onClick={() =>
                  blockMutation.mutate({
                    contactId: contact.id,
                    jid: contact.jid,
                    waSessionId: contact.waSessionId ?? null,
                    blocked: !contact.blocked,
                  })
                }
              >
                {contact.blocked ? <ShieldCheckIcon /> : <BanIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={isPinned ? "Unpin contact" : "Pin contact"}
                onClick={() => pinMutation.mutate(!isPinned)}
              >
                {isPinned ? <PinOffIcon /> : <PinIcon />}
              </Button>
            </div>
          </div>
          <SheetDescription>
            {contact.phoneNumber ?? contact.jid.split("@")[0]}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-6 py-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="contact-name">Name</Label>
            <div className="flex gap-2">
              <Input
                id="contact-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={
                  saveNameMutation.isPending ||
                  name.trim() === (contact.name ?? "")
                }
                onClick={() => saveNameMutation.mutate(name.trim())}
              >
                Save
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Lifecycle stage</Label>
            <Select
              value={contact.lifecycleStage}
              onValueChange={(v) => v && stageMutation.mutate(v)}
            >
              <SelectTrigger>
                <SelectValue>
                  {(v) =>
                    typeof v === "string" && v
                      ? v.charAt(0).toUpperCase() + v.slice(1)
                      : ""
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STAGES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {tagsQuery.data && tagsQuery.data.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1">
                {tagsQuery.data.map((t) => (
                  <Badge key={t.tagId} variant="outline">
                    {t.tagName}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {contact.conversationId && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              render={
                <Link
                  to="/inbox"
                  search={{ conversationId: contact.conversationId }}
                  onClick={() => onOpenChange(false)}
                />
              }
            >
              <MessageSquareIcon />
              Open conversation
            </Button>
          )}

          <Separator />

          <div className="flex flex-col gap-2">
            <Label className="flex items-center gap-1.5">
              <StickyNoteIcon className="size-3.5" /> Notes
            </Label>
            <div className="flex flex-col gap-2">
              <Textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a note about this contact…"
                className="min-h-16"
              />
              <Button
                size="sm"
                className="self-end"
                disabled={!noteText.trim() || addNoteMutation.isPending}
                onClick={() => addNoteMutation.mutate(noteText.trim())}
              >
                Add note
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {noteItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">No notes yet.</p>
              ) : (
                noteItems.map((n) => (
                  <div
                    key={n.id}
                    className="rounded-xl border border-border bg-muted/40 p-2.5 text-sm"
                  >
                    <p className="break-words whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
              <LoadMoreButton
                hasMore={!!notesQuery.hasNextPage}
                shown={shownOf(notesQuery.data)}
                total={totalOf(notesQuery.data)}
                loading={notesQuery.isFetchingNextPage}
                onLoadMore={() => notesQuery.fetchNextPage()}
                label="Older notes"
              />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
