import { useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@workspace/ui/components/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { ClockIcon, Loader2Icon } from "lucide-react"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { searchContacts } from "@/features/contacts/hooks/use-contacts"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { createScheduledSchema  } from "@/lib/schemas"
import type {CreateScheduledInput, ScheduledMessageInput } from "@/lib/schemas";

export type { ScheduledMessageInput } from "@/lib/schemas"

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function CreateScheduledDialog({
  workspaceId,
  onCreate,
}: {
  workspaceId: string
  onCreate: (data: ScheduledMessageInput) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<CreateScheduledInput>({
    resolver: zodResolver(createScheduledSchema),
    defaultValues: {
      waSessionId: "",
      contactId: "",
      body: "",
      sendAt: "",
    },
  })

  const watchSessionId = form.watch("waSessionId")
  const watchSendAt = form.watch("sendAt")

  const minSendAt = toLocalInputValue(new Date(Date.now() + 60_000))
  const isPast = Boolean(watchSendAt) && new Date(watchSendAt).getTime() <= Date.now()
  const validTime = Boolean(watchSendAt) && !isPast

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open,
  })

  // Server-side, bounded search (20 rows) instead of loading every contact
  // in the workspace into the browser to filter client-side.
  const [contactSearch, setContactSearch] = useState("")
  const debouncedSearch = useDebouncedValue(contactSearch.trim())
  const [pickedContact, setPickedContact] = useState<{
    id: string
    jid: string
    name: string | null
    phoneNumber: string | null
  } | null>(null)
  const { data: searchResults = [] } = useQuery({
    queryKey: ["contact-search", workspaceId, watchSessionId, debouncedSearch],
    queryFn: () =>
      searchContacts({
        data: { workspaceId, query: debouncedSearch, waSessionId: watchSessionId },
      }),
    enabled: open && !!watchSessionId,
    staleTime: 30_000,
  })
  const sessionContacts = useMemo(() => {
    if (!pickedContact || searchResults.some((c) => c.id === pickedContact.id)) {
      return searchResults
    }
    return [pickedContact, ...searchResults]
  }, [searchResults, pickedContact])

  async function onSubmit(data: z.infer<typeof createScheduledSchema>) {
    setSubmitting(true)
    try {
      const contact = sessionContacts.find((c) => c.id === data.contactId)
      if (!contact) return
      await onCreate({
        waSessionId: data.waSessionId,
        toJid: contact.jid,
        body: data.body.trim(),
        sendAt: Math.floor(new Date(data.sendAt).getTime() / 1000),
      })
      form.reset()
      setOpen(false)
    } catch {
      // Global mutation handler toasts the error
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) form.reset()
    }}>
      <SheetTrigger render={<Button variant="outline" />}>
        <ClockIcon />
        Schedule Message
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Schedule a Message</SheetTitle>
          <SheetDescription>
            Send a single message to one contact at a future time.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
            <FormField
              control={form.control}
              name="waSessionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>WhatsApp session</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value ?? "")
                      form.setValue("contactId", "")
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) =>
                            v
                              ? (sessions.find((s) => s.id === v)?.label ?? "")
                              : "Select a session"
                          }
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {sessions.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="contactId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Contact</FormLabel>
                  <Input
                    placeholder="Search by name or number"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    disabled={!watchSessionId}
                  />
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v ?? "")
                      setPickedContact(sessionContacts.find((c) => c.id === v) ?? null)
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) => {
                            if (!v)
                              return watchSessionId
                                ? "Select a contact"
                                : "Pick a session first"
                            const c = sessionContacts.find(
                              (contact) => contact.id === v
                            )
                            return c ? (c.name ?? c.phoneNumber ?? c.jid) : ""
                          }}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {sessionContacts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name ?? c.phoneNumber ?? c.jid}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <textarea
                      id="scheduled-body"
                      className="min-h-24 resize-none rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="sendAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Send at</FormLabel>
                  <FormControl>
                    <Input
                      id="scheduled-send-at"
                      type="datetime-local"
                      min={minSendAt}
                      {...field}
                    />
                  </FormControl>
                  {isPast && (
                    <p
                      role="alert"
                      className="text-xs font-medium text-destructive"
                    >
                      Pick a time in the future.
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <SheetFooter>
              <Button
                type="submit"
                disabled={submitting || !validTime}
              >
                {submitting && <Loader2Icon className="animate-spin" />}
                {submitting ? "Scheduling..." : "Schedule"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
