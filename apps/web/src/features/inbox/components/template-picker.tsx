import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Badge } from "@workspace/ui/components/badge"
import {
  FileTextIcon,
  VideoIcon,
  FileAudioIcon,
  FileIcon,
  SearchXIcon,
  CornerDownLeftIcon,
} from "lucide-react"
import { resolveTemplate, contactTemplateVariables } from "@workspace/db"
import { waApi } from "@/lib/wa-api"
import { getTemplates } from "@/features/templates/hooks/use-templates"

export function TemplatePicker({
  workspaceId,
  contact,
  disabled,
  onInsertText,
  onSendMediaTemplate,
}: {
  workspaceId: string
  /** Resolved against the picked template's {{variables}} -- see contactTemplateVariables. */
  contact: {
    name: string | null
    phoneNumber: string | null
    lifecycleStage: string | null
  } | null
  disabled?: boolean
  /** Text-only template: inserted into the draft so it can still be edited before sending. */
  onInsertText: (text: string) => void
  /** Template with an attachment: sent immediately, same as picking a file in the composer. */
  onSendMediaTemplate: (opts: {
    templateId: string
    text?: string
    mediaKey: string
  }) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const { data: templates = [] } = useQuery({
    queryKey: ["templates", workspaceId],
    queryFn: () => getTemplates({ data: { workspaceId } }),
    enabled: open,
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return templates
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.shortcut?.toLowerCase().includes(q) ||
        t.body?.toLowerCase().includes(q)
    )
  }, [templates, query])

  const vars = contactTemplateVariables(contact)

  function pick(t: (typeof templates)[number]) {
    const resolved = resolveTemplate(t.body, vars)
    if (t.mediaKey) {
      onSendMediaTemplate({
        templateId: t.id,
        text: resolved || undefined,
        mediaKey: t.mediaKey,
      })
    } else {
      onInsertText(resolved)
    }
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="mb-0.5 shrink-0 text-muted-foreground"
            disabled={disabled}
            aria-label="Templates"
            title="Templates"
          />
        }
      >
        <FileTextIcon />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 gap-0 overflow-hidden p-0"
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            placeholder="Search templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex max-h-72 flex-col overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-xs text-muted-foreground">
              <SearchXIcon className="size-4" />
              {templates.length === 0
                ? "No templates yet — add one from Automation."
                : "No templates match."}
            </div>
          ) : (
            filtered.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => pick(t)}
                className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
              >
                {t.mediaKey &&
                  (t.mediaType === "image" ? (
                    <img
                      src={waApi.mediaUrl(t.mediaKey)}
                      alt=""
                      className="mt-0.5 size-9 shrink-0 rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                      {t.mediaType === "video" ? (
                        <VideoIcon className="size-4 text-muted-foreground" />
                      ) : t.mediaType === "audio" ? (
                        <FileAudioIcon className="size-4 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-4 text-muted-foreground" />
                      )}
                    </div>
                  ))}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {t.name}
                    {t.shortcut && (
                      <Badge variant="outline" className="text-[10px]">
                        /{t.shortcut}
                      </Badge>
                    )}
                  </span>
                  {t.body ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {t.body}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">
                      {t.mediaType ?? "file"} attachment
                    </span>
                  )}
                </span>
                <CornerDownLeftIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))
          )}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          Tip: type{" "}
          <code className="rounded bg-muted px-1 py-0.5">/shortcut</code> in the
          composer
        </div>
      </PopoverContent>
    </Popover>
  )
}
