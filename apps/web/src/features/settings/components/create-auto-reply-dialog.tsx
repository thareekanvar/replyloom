import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
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
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import type { AutoReplyRule } from "./auto-reply-list"
import { createAutoReplySchema  } from "@/lib/schemas"
import type {CreateAutoReplyInput} from "@/lib/schemas";

export type { CreateAutoReplyInput } from "@/lib/schemas"

export function CreateAutoReplyDialog({
  workspaceId,
  rule,
  onCreate,
  onUpdate,
  onCancelEdit,
}: {
  workspaceId: string
  rule?: AutoReplyRule | null
  onCreate: (data: CreateAutoReplyInput) => Promise<unknown>
  onUpdate?: (ruleId: string, data: CreateAutoReplyInput) => Promise<unknown>
  onCancelEdit?: () => void
}) {
  const editing = Boolean(rule)
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<CreateAutoReplyInput>({
    resolver: zodResolver(createAutoReplySchema),
    defaultValues: {
      keyword: "",
      matchType: "contains",
      context: "all",
      replyText: "",
      waSessionId: "all",
    },
  })

  useEffect(() => {
    if (rule) {
      form.reset({
        keyword: rule.keyword,
        matchType: rule.matchType,
        context: rule.context,
        replyText: rule.replyText ?? "",
        waSessionId: rule.waSessionId ?? "all",
      })
    } else {
      form.reset({
        keyword: "",
        matchType: "contains",
        context: "all",
        replyText: "",
        waSessionId: "all",
      })
    }
  }, [rule])

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open || editing,
  })

  async function onSubmit(data: CreateAutoReplyInput) {
    setSubmitting(true)
    try {
      const payload: CreateAutoReplyInput = {
        keyword: data.keyword.trim(),
        matchType: data.matchType,
        context: data.context,
        replyText: data.replyText.trim(),
        waSessionId: data.waSessionId === "all" ? undefined : data.waSessionId,
      }
      if (editing && rule && onUpdate) {
        await onUpdate(rule.id, payload)
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

  const openState = editing ? Boolean(rule) : open
  const onOpenChange = editing
    ? (next: boolean) => {
        if (!next) onCancelEdit?.()
      }
    : setOpen

  return (
    <Sheet open={openState} onOpenChange={onOpenChange}>
      {!editing && (
        <SheetTrigger render={<Button />}>
          <PlusIcon />
          New Rule
        </SheetTrigger>
      )}
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>
            {editing ? "Edit Auto-Reply Rule" : "Create Auto-Reply Rule"}
          </SheetTitle>
          <SheetDescription>
            Reply automatically when an incoming message matches a keyword.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 px-6 py-4">
            <FormField
              control={form.control}
              name="keyword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Keyword</FormLabel>
                  <FormControl>
                    <Input
                      id="rule-keyword"
                      placeholder="e.g. pricing"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="matchType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Match type</FormLabel>
                    <Select value={field.value} onValueChange={(v) => field.onChange(v)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue>
                            {(v) =>
                              v == null
                                ? ""
                                : v === "contains"
                                  ? "Contains"
                                  : v === "exact"
                                    ? "Exact match"
                                    : "Regex"
                            }
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="contains">Contains</SelectItem>
                        <SelectItem value="exact">Exact match</SelectItem>
                        <SelectItem value="regex">Regex</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="context"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Context</FormLabel>
                    <Select value={field.value} onValueChange={(v) => field.onChange(v)}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue>
                            {(v) =>
                              v == null
                                ? ""
                                : v === "all"
                                  ? "All chats"
                                  : v === "private"
                                    ? "Direct only"
                                    : "Groups only"
                            }
                          </SelectValue>
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="all">All chats</SelectItem>
                        <SelectItem value="private">Direct only</SelectItem>
                        <SelectItem value="group">Groups only</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="waSessionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Applies to session</FormLabel>
                  <Select value={field.value ?? "all"} onValueChange={(v) => field.onChange(v ?? "all")}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) =>
                            v == null || v === "all"
                              ? "Every session"
                              : (sessions.find((s) => s.id === v)?.label ?? "")
                          }
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="all">Every session</SelectItem>
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
              name="replyText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reply text</FormLabel>
                  <FormControl>
                    <textarea
                      id="rule-reply"
                      className="min-h-24 resize-none rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
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
                    : "Create rule"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
