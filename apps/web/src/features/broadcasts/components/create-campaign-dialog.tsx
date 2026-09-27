import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
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
} from "@workspace/ui/components/sheet"
import {
  MegaphoneIcon,
  FileTextIcon,
  Loader2Icon,
  AlertTriangleIcon,
  ClockIcon,
} from "lucide-react"
import { getSessions } from "@/features/integrations/hooks/use-sessions"
import { getContactLists, getListEligibility } from "@/features/contact-lists/hooks/use-contact-lists"
import { getTemplates } from "@/features/templates/hooks/use-templates"
import { getSendingLimits } from "@/features/broadcasts/hooks/use-broadcasts"
import { createCampaignSchema } from "@/lib/schemas"
import { TYPE_TO_CONFIRM_THRESHOLD } from "../lib/confirm"
import type { CreateCampaignInput, BroadcastCampaignInput } from "@/lib/schemas"

export type { BroadcastCampaignInput } from "@/lib/schemas"

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function CreateCampaignDialog({
  workspaceId,
  onCreate,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  initialWaSessionId,
  initialContactListId,
  hideTrigger,
}: {
  workspaceId: string
  onCreate: (data: BroadcastCampaignInput) => Promise<unknown>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  initialWaSessionId?: string
  initialContactListId?: string
  hideTrigger?: boolean
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = openProp ?? uncontrolledOpen
  const setOpen = onOpenChangeProp ?? setUncontrolledOpen
  const [submitting, setSubmitting] = useState(false)
  const [mediaKey, setMediaKey] = useState<string | undefined>(undefined)
  const [templateId, setTemplateId] = useState<string>("none")
  const [confirmText, setConfirmText] = useState("")

  const form = useForm<CreateCampaignInput>({
    resolver: zodResolver(createCampaignSchema),
    // Show field errors (e.g. missing personalization) as soon as a field
    // is touched -- submit stays disabled while invalid, so waiting for a
    // submit attempt would hide the reason.
    mode: "onTouched",
    defaultValues: {
      name: "",
      messageText: "",
      waSessionId: "",
      contactListId: "",
      scheduledAt: "",
    },
  })

  useEffect(() => {
    if (open) {
      if (initialWaSessionId) form.setValue("waSessionId", initialWaSessionId)
      if (initialContactListId) form.setValue("contactListId", initialContactListId)
    }
  }, [open])

  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    isError: sessionsError,
  } = useQuery({
    queryKey: ["sessions", workspaceId],
    queryFn: () => getSessions({ data: { workspaceId } }),
    enabled: open,
  })

  const { data: allLists = [], isLoading: listsLoading } = useQuery({
    queryKey: ["contact-lists", workspaceId],
    queryFn: () => getContactLists({ data: { workspaceId } }),
    enabled: open,
  })
  const lists = allLists.filter((l) => l.status !== "archived")

  const { data: templates = [] } = useQuery({
    queryKey: ["templates", workspaceId],
    queryFn: () => getTemplates({ data: { workspaceId } }),
    enabled: open,
  })

  const watchContactListId = form.watch("contactListId")
  const watchWaSessionId = form.watch("waSessionId")

  const { data: sendingLimits = [] } = useQuery({
    queryKey: ["sending-limits", workspaceId],
    queryFn: () => getSendingLimits({ data: { workspaceId } }),
    enabled: open,
    staleTime: 60_000,
  })
  const sessionLimit = sendingLimits.find((l) => l.id === watchWaSessionId)
  const watchScheduledAt = form.watch("scheduledAt")

  const { data: eligibility, isFetching: eligibilityLoading } = useQuery({
    queryKey: ["list-eligibility", workspaceId, watchContactListId],
    queryFn: () => getListEligibility({ data: { workspaceId, listId: watchContactListId } }),
    enabled: open && Boolean(watchContactListId),
  })

  // A different list means a different number -- never carry a typed
  // confirmation across.
  useEffect(() => setConfirmText(""), [watchContactListId, eligibility?.eligibleCount])

  const needsTypedConfirm = Boolean(
    eligibility && eligibility.eligibleCount >= TYPE_TO_CONFIRM_THRESHOLD
  )
  const typedConfirmOk =
    !needsTypedConfirm || Number(confirmText.trim()) === eligibility?.eligibleCount

  function applyTemplate(id: string) {
    setTemplateId(id)
    if (id === "none") {
      setMediaKey(undefined)
      return
    }
    const t = templates.find((tpl) => tpl.id === id)
    if (!t) return
    form.setValue("messageText", t.body ?? "")
    setMediaKey(t.mediaKey ?? undefined)
  }

  const minSendAt = toLocalInputValue(new Date(Date.now() + 60_000))
  const isPast =
    Boolean(watchScheduledAt) && new Date(watchScheduledAt!).getTime() <= Date.now()

  function reset() {
    form.reset()
    setMediaKey(undefined)
    setTemplateId("none")
    setConfirmText("")
  }

  const blockedByList = Boolean(
    eligibility && (eligibility.overCeiling || !eligibility.usable || eligibility.eligibleCount === 0)
  )

  async function onSubmit(data: z.infer<typeof createCampaignSchema>) {
    setSubmitting(true)
    try {
      await onCreate({
        waSessionId: data.waSessionId,
        name: data.name.trim(),
        messageText: data.messageText.trim(),
        contactListId: data.contactListId,
        scheduledAt: data.scheduledAt
          ? Math.floor(new Date(data.scheduledAt).getTime() / 1000)
          : undefined,
        mediaKey,
        confirmedRecipientCount: needsTypedConfirm ? eligibility?.eligibleCount : undefined,
      })
      reset()
      setOpen(false)
    } catch {
      // Global mutation handler toasts the error
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <Button type="button" onClick={() => setOpen(true)}>
          <MegaphoneIcon />
          New Broadcast
        </Button>
      )}
      <SheetContent side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Create Broadcast</SheetTitle>
          <SheetDescription>
            Broadcasts target a contact list, not raw contacts -- recipients are
            messaged one at a time with a randomized delay to keep the session
            safe.
          </SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Campaign name</FormLabel>
                  <FormControl>
                    <Input
                      id="campaign-name"
                      placeholder="e.g. September promo"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="waSessionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>WhatsApp session</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "")}
                    disabled={sessionsLoading || sessionsError || sessions.length === 0}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) =>
                            v
                              ? (sessions.find((s) => s.id === v)?.label ?? "")
                              : sessionsLoading
                                ? "Loading sessions..."
                                : sessionsError
                                  ? "Couldn't load sessions"
                                  : sessions.length === 0
                                    ? "No WhatsApp sessions yet"
                                    : "Select a session to send from"
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
                  {sessionsError ? (
                    <p className="text-xs text-destructive">
                      We couldn&apos;t load your WhatsApp sessions. Close and reopen
                      this form to try again.
                    </p>
                  ) : sessions.length === 0 && !sessionsLoading ? (
                    <p className="text-xs text-muted-foreground">
                      Connect WhatsApp in{" "}
                      <Link
                        to="/integrations"
                        className="font-medium text-foreground underline underline-offset-2"
                        onClick={() => setOpen(false)}
                      >
                        Integrations
                      </Link>{" "}
                      before creating a broadcast.
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex flex-col gap-2">
              <FormLabel>Template</FormLabel>
              <Select
                value={templateId}
                onValueChange={(v) => applyTemplate(v ?? "none")}
                disabled={templates.length === 0}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v) =>
                      v && v !== "none"
                        ? (templates.find((t) => t.id === v)?.name ?? "")
                        : templates.length > 0
                          ? "Write my own"
                          : "No templates available"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Write my own</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {templates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Create a template first, or write your own message below.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Optional — selecting a template fills in the message and any
                  attachment.
                </p>
              )}
            </div>

            <FormField
              control={form.control}
              name="messageText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <textarea
                      id="campaign-message"
                      className="min-h-24 resize-none rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                      placeholder="Hi {{firstName}}, ... -- must include {{name}}, {{firstName}} or {{phone}} so each recipient gets a personalized message."
                      {...field}
                    />
                  </FormControl>
                  {mediaKey && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <FileTextIcon className="size-3" /> Includes the template's
                      attachment.
                    </p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="scheduledAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Send at (optional)</FormLabel>
                  <FormControl>
                    <Input
                      id="campaign-schedule"
                      type="datetime-local"
                      min={minSendAt}
                      {...field}
                    />
                  </FormControl>
                  {isPast && (
                    <p role="alert" className="text-xs font-medium text-destructive">
                      Pick a time in the future.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Leave blank to start sending immediately.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="contactListId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Contact list</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "")}
                    disabled={listsLoading || lists.length === 0}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue>
                          {(v) =>
                            v
                              ? (lists.find((l) => l.id === v)?.name ?? "")
                              : listsLoading
                                ? "Loading lists..."
                                : lists.length === 0
                                  ? "No contact lists yet"
                                  : "Select a contact list"
                          }
                        </SelectValue>
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {lists.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name} ({l.stats.owned} approved)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {lists.length === 0 && !listsLoading ? (
                    <p className="text-xs text-muted-foreground">
                      Create a{" "}
                      <Link
                        to="/contacts"
                        search={{ tab: "lists" }}
                        className="font-medium text-foreground underline underline-offset-2"
                        onClick={() => setOpen(false)}
                      >
                        contact list
                      </Link>{" "}
                      first -- broadcasts can only target a list, never raw
                      contacts.
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            {watchContactListId && eligibility && !eligibilityLoading && (
              <div className="flex flex-col gap-1 rounded-md border p-3 text-xs">
                <p className="font-medium">
                  {eligibility.eligibleCount} eligible recipient
                  {eligibility.eligibleCount === 1 ? "" : "s"}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    (after suppression, ownership, and cooldown filtering — not the
                    list's raw size)
                  </span>
                </p>
                {sessionLimit && eligibility.eligibleCount > sessionLimit.remainingToday && (
                  <p className="flex items-start gap-1 text-muted-foreground">
                    <ClockIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      This number can send {sessionLimit.remainingToday} more today
                      {sessionLimit.warmUpPercent < 100
                        ? ` (still warming up, ${sessionLimit.warmUpPercent}% of the full limit)`
                        : ""}
                      . The other {eligibility.eligibleCount - sessionLimit.remainingToday} go out
                      over the next few days.
                    </span>
                  </p>
                )}
                {!eligibility.usable && eligibility.usableAfter && (
                  <p className="flex items-center gap-1 text-amber-600 dark:text-amber-500">
                    <ClockIcon className="size-3.5" />
                    {eligibility.recentlyUsed
                      ? "This list was broadcast to recently — usable again at"
                      : "This list is still aging — usable at"}{" "}
                    {new Date(eligibility.usableAfter).toLocaleString()}.
                  </p>
                )}
                {eligibility.overCeiling && (
                  <p className="flex items-center gap-1 text-destructive">
                    <AlertTriangleIcon className="size-3.5" />
                    Exceeds this workspace's broadcast limit of{" "}
                    {eligibility.ceiling}. Split into multiple lists/campaigns.
                  </p>
                )}
                {eligibility.eligibleCount === 0 && (
                  <p className="flex items-center gap-1 text-destructive">
                    <AlertTriangleIcon className="size-3.5" />
                    Everyone in this list is suppressed, on cooldown, or owned by
                    another list.
                  </p>
                )}
              </div>
            )}

            {needsTypedConfirm && !blockedByList && eligibility && (
              <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <label htmlFor="confirm-recipient-count" className="text-xs font-medium">
                  This will message {eligibility.eligibleCount} people. Type{" "}
                  <span className="font-mono">{eligibility.eligibleCount}</span> to confirm.
                </label>
                <Input
                  id="confirm-recipient-count"
                  inputMode="numeric"
                  autoComplete="off"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={String(eligibility.eligibleCount)}
                  className="h-8"
                />
              </div>
            )}

            <SheetFooter>
              <Button
                type="submit"
                disabled={
                  submitting ||
                  !form.formState.isValid ||
                  isPast ||
                  blockedByList ||
                  eligibilityLoading ||
                  !typedConfirmOk
                }
              >
                {submitting && <Loader2Icon className="animate-spin" />}
                {submitting
                  ? "Creating..."
                  : watchScheduledAt
                    ? "Schedule broadcast"
                    : "Send now"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
