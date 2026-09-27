import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  PaperclipIcon,
  SendIcon,
  LoaderCircleIcon,
  PlusIcon,
  BarChart3Icon,
  MapPinIcon,
  UserRoundIcon,
} from "lucide-react"
import { toast } from "sonner"
import { EmojiPicker } from "./emoji-picker"
import { TemplatePicker } from "./template-picker"
import { TemplateSlashMenu } from "./template-slash-menu"
import { MediaSendDialog } from "./media-send-dialog"
import type { AttachmentType } from "./media-send-dialog"
import { ShareExtrasDialog } from "./share-extras-dialog"
import { getTemplates } from "@/features/templates/hooks/use-templates"
import { resolveTemplate, contactTemplateVariables } from "@workspace/db"

// /shortcut in the composer — the token has to start a word (start of
// input or right after whitespace) so URLs and stray slashes don't open it.
const SLASH_RE = /(^|\s)\/([a-zA-Z0-9_-]*)$/

export function MessageComposer({
  disabled,
  disabledReason,
  onSend,
  onSendMedia,
  onSendMediaKey,
  workspaceId,
  contact,
  onSendTemplate,
  draftKey,
  onSendPoll,
  onSendLocation,
  onSendContactCard,
  onTyping,
}: {
  disabled?: boolean
  disabledReason?: string
  onSend: (text: string) => Promise<unknown>
  onSendMedia?: (
    file: File,
    type: AttachmentType,
    caption?: string
  ) => Promise<unknown>
  onSendMediaKey?: (opts: {
    text?: string
    mediaKey: string
  }) => Promise<unknown>
  /** Templates button is only shown when both of these are supplied. */
  workspaceId?: string
  contact?: {
    name: string | null
    phoneNumber: string | null
    lifecycleStage: string | null
  } | null
  onSendTemplate?: (opts: {
    templateId: string
    text?: string
    mediaKey: string
  }) => Promise<unknown>
  /** Key (e.g. the conversation id) whose draft this composer should persist. */
  draftKey?: string
  /** Poll / location / contact-card send options — shown as a "more" menu
   * next to the attach button when all three are supplied. */
  onSendPoll?: (opts: {
    name: string
    values: string[]
    selectableCount?: number
  }) => Promise<unknown>
  onSendLocation?: (opts: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }) => Promise<unknown>
  onSendContactCard?: (opts: {
    contacts: Array<{ displayName: string; vcard: string }>
  }) => Promise<unknown>
  /** Called on every keystroke — the caller (InboxLayout) debounces this
   * into WhatsApp "composing"/"paused" presence updates. */
  onTyping?: () => void
}) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [mediaDialogOpen, setMediaDialogOpen] = useState(false)
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [shareDialogTab, setShareDialogTab] = useState<"poll" | "location" | "contact">("poll")
  const [sendingTemplate, setSendingTemplate] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Keep one draft per conversation: text typed into the composer while
  // viewing conversation A must not bleed into conversation B, and should
  // come back when switching back before it's sent.
  const draftStore = useRef(new Map<string, string>())
  const textRef = useRef("")
  useEffect(() => {
    textRef.current = text
  }, [text])
  const activeDraftKey = useRef(draftKey ?? null)
  useEffect(() => {
    if (!draftKey) return
    const prev = activeDraftKey.current
    if (prev !== draftKey) {
      if (prev) {
        draftStore.current.set(prev, textRef.current)
      }
      activeDraftKey.current = draftKey
      setText(draftStore.current.get(draftKey) ?? "")
      setSlashDismissed(true)
    }
  }, [draftKey])

  // ── Slash-command template autocomplete ──
  const slashMatch = useMemo(() => {
    const m = SLASH_RE.exec(text)
    if (!m) return null
    return { tokenStart: m.index + m[1].length, raw: `/${m[2]}`, q: m[2] }
  }, [text])

  // When the token itself changes (typing) the menu reappears even after
  // being dismissed with Escape once.
  const slashToken = slashMatch ? slashMatch.raw : null
  useEffect(() => {
    setSlashDismissed(false)
  }, [slashToken])

  const slashOpen = slashMatch !== null && !slashDismissed

  const { data: slashTemplates = [], isLoading: slashLoading } = useQuery({
    queryKey: ["templates", workspaceId],
    queryFn: () => getTemplates({ data: { workspaceId: workspaceId! } }),
    enabled: Boolean(workspaceId) && slashOpen,
    staleTime: 15_000,
  })

  const slashResults = useMemo(() => {
    if (!slashMatch) return []
    const q = slashMatch.q.toLowerCase()
    return slashTemplates
      .filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.shortcut?.toLowerCase().includes(q)
      )
      .sort(
        (a, b) =>
          Number(!(a.shortcut ?? "").toLowerCase().startsWith(q)) -
          Number(!(b.shortcut ?? "").toLowerCase().startsWith(q))
      )
      .slice(0, 8)
  }, [slashTemplates, slashMatch])

  useEffect(() => {
    setSlashIndex(0)
  }, [slashMatch, slashResults.length])

  const vars = useMemo(
    () => contactTemplateVariables(contact ?? null),
    [contact]
  )

  const placeholder = useMemo(() => {
    if (!contact?.name) return "Type a message…"
    const first = contact.name.split(/\s+/)[0]
    return `Message ${first}…`
  }, [contact?.name])

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    setText("") // clear immediately — the optimistic bubble in the thread is the feedback
    try {
      await onSend(trimmed)
      if (draftKey) draftStore.current.delete(draftKey)
    } catch (err: any) {
      toast.error(err?.message ?? "Message failed to send.")
      setText(trimmed) // give it back so nothing's lost
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen && slashResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSlashIndex((i) => Math.min(i + 1, slashResults.length - 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setSlashIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault()
        pickSlash(slashIndex)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Removes the typed /token and either inserts the resolved text into the
  // draft (text-only template) or sends immediately (template with an
  // attachment), matching the TemplatePicker's behaviour.
  function pickSlash(index: number) {
    const item = slashResults[index]
    if (!slashMatch) return
    const resolved = resolveTemplate(item.body, vars)
    const prefix = text.slice(0, slashMatch.tokenStart).replace(/\s+$/, "")
    if (item.mediaKey) {
      setText(prefix ? `${prefix}\n` : "")
      sendMediaTemplate({
        templateId: item.id,
        text: resolved || undefined,
        mediaKey: item.mediaKey,
      })
    } else {
      setText(prefix ? `${prefix}\n${resolved}` : resolved)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  // Inserts at the cursor (not just appended) so picking an emoji mid-word
  // behaves the way every chat app's picker does.
  function insertEmoji(emoji: string) {
    const el = textareaRef.current
    if (!el) {
      setText((t) => t + emoji)
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  // A text-only template inserts into the draft (so it's still editable
  // before sending); one with an attachment is a media message and gets
  // sent right away, same as picking a file.
  function insertTemplateText(resolved: string) {
    const el = textareaRef.current
    setText((t) =>
      t.trim() ? `${t}${t.endsWith("\n") ? "" : "\n"}${resolved}` : resolved
    )
    requestAnimationFrame(() => el?.focus())
  }

  async function sendMediaTemplate(opts: {
    templateId: string
    text?: string
    mediaKey: string
  }) {
    if (!onSendTemplate) return
    setSendingTemplate(true)
    try {
      await onSendTemplate(opts)
    } catch (err: any) {
      toast.error(err?.message ?? "Template failed to send.")
    } finally {
      setSendingTemplate(false)
    }
  }

  async function handleSendFile(
    file: File,
    type: AttachmentType,
    caption?: string
  ) {
    if (!onSendMedia) return
    try {
      await onSendMedia(file, type, caption)
    } catch (err: any) {
      toast.error(err?.message ?? "Attachment failed to send.")
      throw err
    }
  }

  async function handleSendMediaKey(opts: { text?: string; mediaKey: string }) {
    if (!onSendMediaKey) return
    try {
      await onSendMediaKey(opts)
    } catch (err: any) {
      toast.error(err?.message ?? "Media failed to send.")
      throw err
    }
  }

  return (
    <div className="border-t border-border p-3">
      {disabled ? (
        <div className="rounded-xl bg-muted/50 px-3 py-2.5 text-center text-xs text-muted-foreground">
          {disabledReason ??
            "This session isn't connected — reconnect it from Sessions to reply."}
        </div>
      ) : (
        <div className="relative">
          {slashOpen && (
            <TemplateSlashMenu
              items={slashResults}
              highlighted={slashIndex}
              loading={slashLoading}
              onHighlight={setSlashIndex}
              onPick={pickSlash}
            />
          )}

          <div className="flex items-end gap-1 rounded-3xl border border-border bg-background p-1.5 shadow-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
            <Button
              variant="ghost"
              size="icon"
              className="mb-0.5 shrink-0 text-muted-foreground"
              disabled={!onSendMedia && !onSendMediaKey}
              aria-label="Attach a file"
              title="Attach a file"
              onClick={() => setMediaDialogOpen(true)}
            >
              <PaperclipIcon />
            </Button>
            {(onSendPoll || onSendLocation || onSendContactCard) && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mb-0.5 shrink-0 text-muted-foreground"
                      aria-label="Share more"
                      title="Share more"
                    />
                  }
                >
                  <PlusIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top">
                  {onSendPoll && (
                    <DropdownMenuItem
                      onClick={() => {
                        setShareDialogTab("poll")
                        setShareDialogOpen(true)
                      }}
                    >
                      <BarChart3Icon /> Poll
                    </DropdownMenuItem>
                  )}
                  {onSendLocation && (
                    <DropdownMenuItem
                      onClick={() => {
                        setShareDialogTab("location")
                        setShareDialogOpen(true)
                      }}
                    >
                      <MapPinIcon /> Location
                    </DropdownMenuItem>
                  )}
                  {onSendContactCard && (
                    <DropdownMenuItem
                      onClick={() => {
                        setShareDialogTab("contact")
                        setShareDialogOpen(true)
                      }}
                    >
                      <UserRoundIcon /> Contact
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                onTyping?.()
              }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="max-h-32 border-0 bg-transparent px-1 focus-visible:ring-0"
            />
            <div className="flex shrink-0 items-center">
              <EmojiPicker onPick={insertEmoji} />
              {workspaceId && onSendTemplate && (
                <TemplatePicker
                  workspaceId={workspaceId}
                  contact={contact ?? null}
                  disabled={sendingTemplate}
                  onInsertText={insertTemplateText}
                  onSendMediaTemplate={sendMediaTemplate}
                />
              )}
              <Button
                size="icon"
                className="mr-0.5 mb-0.5 shrink-0"
                onClick={submit}
                disabled={!text.trim() || sending}
                aria-label="Send message"
                title="Send (Enter)"
              >
                {sending ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <SendIcon />
                )}
              </Button>
            </div>
          </div>

          <div className="mt-1 flex items-center justify-between px-2 text-[10px] text-muted-foreground">
            <span>Enter to send · Shift+Enter for a new line</span>
            {slashOpen && slashResults.length > 0 && (
              <span className="font-medium text-primary">
                Select with ↑↓ and Enter
              </span>
            )}
          </div>
        </div>
      )}

      {workspaceId && (
        <MediaSendDialog
          open={mediaDialogOpen}
          onOpenChange={setMediaDialogOpen}
          workspaceId={workspaceId}
          onSendFile={handleSendFile}
          onSendMediaKey={handleSendMediaKey}
        />
      )}

      {workspaceId && (onSendPoll || onSendLocation || onSendContactCard) && (
        <ShareExtrasDialog
          key={shareDialogTab}
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
          workspaceId={workspaceId}
          defaultTab={shareDialogTab}
          onSendPoll={onSendPoll ?? (async () => {})}
          onSendLocation={onSendLocation ?? (async () => {})}
          onSendContacts={onSendContactCard ?? (async () => {})}
        />
      )}
    </div>
  )
}
