import { useEffect, useState } from "react"
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
import { Loader2Icon, PlusIcon } from "lucide-react"
import { searchContacts } from "@/features/contacts/hooks/use-contacts"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { createDealSchema  } from "@/lib/schemas"
import type {DealInput} from "@/lib/schemas";
import type { Stage } from "./pipeline-column"
import type { Deal } from "./deal-card"

export type { DealInput } from "@/lib/schemas"

export function CreateDealDialog({
  workspaceId,
  stages,
  deal,
  onCreate,
  onUpdate,
  onCancelEdit,
}: {
  workspaceId: string
  stages: Stage[]
  deal?: Deal | null
  onCreate: (data: DealInput) => Promise<unknown>
  onUpdate?: (dealId: string, data: DealInput) => Promise<unknown>
  onCancelEdit?: () => void
}) {
  const editing = Boolean(deal)
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<z.infer<typeof createDealSchema>>({
    resolver: zodResolver(createDealSchema),
    defaultValues: {
      title: "",
      contactId: "",
      stageId: stages[0]?.id ?? "",
      value: "",
    },
  })

  useEffect(() => {
    if (deal) {
      form.reset({
        title: deal.title,
        contactId: deal.contactId,
        stageId: deal.stageId,
        value: deal.valueCents ? String(deal.valueCents / 100) : "",
      })
    } else {
      form.reset({ title: "", contactId: "", stageId: stages[0]?.id ?? "", value: "" })
    }
  }, [deal])

  // Bounded server-side search (20 rows) instead of loading every contact.
  const [contactSearch, setContactSearch] = useState("")
  const debouncedContactSearch = useDebouncedValue(contactSearch.trim())
  const { data: searchResults = [] } = useQuery({
    queryKey: ["contact-search", workspaceId, null, debouncedContactSearch],
    queryFn: () =>
      searchContacts({ data: { workspaceId, query: debouncedContactSearch } }),
    enabled: open || editing,
    staleTime: 30_000,
  })
  // Keep the chosen / existing contact selectable even when it isn't in the
  // current search results.
  const [pickedContact, setPickedContact] = useState<{
    id: string
    name: string | null
    phoneNumber: string | null
    jid: string
  } | null>(null)
  const currentContact =
    pickedContact ??
    (deal
      ? {
          id: deal.contactId,
          name: (deal as { contactName?: string | null }).contactName ?? null,
          phoneNumber: (deal as { contactPhone?: string | null }).contactPhone ?? null,
          jid: "",
        }
      : null)
  const contacts =
    currentContact && !searchResults.some((c) => c.id === currentContact.id)
      ? [currentContact, ...searchResults]
      : searchResults

  async function onSubmit(data: z.infer<typeof createDealSchema>) {
    setSubmitting(true)
    try {
      const payload = {
        stageId: data.stageId,
        contactId: data.contactId,
        title: data.title.trim(),
        valueCents: data.value ? Math.round(Number(data.value) * 100) : undefined,
      }
      if (editing && deal && onUpdate) {
        await onUpdate(deal.id, payload)
        onCancelEdit?.()
      } else {
        await onCreate(payload)
        form.reset()
        setOpen(false)
      }
    } catch {
      // Global mutation handler toasts the error
    } finally {
      setSubmitting(false)
    }
  }

  const openState = editing ? Boolean(deal) : open
  const onOpenChange = editing ? (next: boolean) => {
    if (!next) onCancelEdit?.()
  } : setOpen

  return (
    <Sheet open={openState} onOpenChange={onOpenChange}>
      {!editing && (
        <SheetTrigger render={<Button />}>
          <PlusIcon />
          New Lead
        </SheetTrigger>
      )}
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{editing ? "Edit Lead" : "Create Lead"}</SheetTitle>
          <SheetDescription>
            {editing
              ? "Update this lead's details."
              : "Add a new lead to your pipeline."}
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lead opportunity</FormLabel>
                  <FormControl>
                    <Input
                      id="deal-title"
                      placeholder="e.g. Website redesign"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contactId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lead contact</FormLabel>
                  <Input
                    placeholder="Search by name or number"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                  />
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v ?? "")
                      setPickedContact(contacts.find((c) => c.id === v) ?? null)
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) => {
                            if (!v)
                              return contacts.length
                                ? "Select a contact"
                                : "No contacts yet"
                            const c = contacts.find((contact) => contact.id === v)
                            return c ? (c.name ?? c.phoneNumber ?? c.jid) : ""
                          }}
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {contacts.map((c) => (
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
              name="stageId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stage</FormLabel>
                  <Select value={field.value} onValueChange={(v) => field.onChange(v ?? "")}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) =>
                            v
                              ? (stages.find((s) => s.id === v)?.name ?? "")
                              : "Select a stage"
                          }
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
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
              name="value"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Value (optional)</FormLabel>
                  <FormControl>
                    <Input
                      id="deal-value"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SheetFooter>
              <Button
                type="submit"
                disabled={submitting}
              >
                {submitting && <Loader2Icon className="animate-spin" />}
                {submitting
                  ? "Saving..."
                  : editing
                    ? "Save changes"
                    : "Create"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
