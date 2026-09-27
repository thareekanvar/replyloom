import { Badge } from "@workspace/ui/components/badge"
import {
  VideoIcon,
  FileAudioIcon,
  FileTextIcon,
  SearchXIcon,
} from "lucide-react"
import { waApi } from "@/lib/wa-api"
import { cn } from "@workspace/ui/lib/utils"

export interface SlashTemplate {
  id: string
  name: string
  shortcut: string | null
  body: string | null
  mediaKey: string | null
  mediaType: "image" | "video" | "audio" | "document" | null
}

function Thumb({ t }: { t: SlashTemplate }) {
  if (!t.mediaKey) return null
  if (t.mediaType === "image") {
    return (
      <img
        src={waApi.mediaUrl(t.mediaKey)}
        alt=""
        className="size-9 shrink-0 rounded-lg border border-border object-cover"
      />
    )
  }
  const Icon =
    t.mediaType === "video"
      ? VideoIcon
      : t.mediaType === "audio"
        ? FileAudioIcon
        : FileTextIcon
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
      <Icon className="size-4 text-muted-foreground" />
    </div>
  )
}

/** The slash-command popover that appears while typing /shortcut in the composer. */
export function TemplateSlashMenu({
  items,
  highlighted,
  loading,
  onHighlight,
  onPick,
}: {
  items: SlashTemplate[]
  highlighted: number
  loading?: boolean
  onHighlight: (index: number) => void
  onPick: (index: number) => void
}) {
  return (
    <div className="absolute start-3 bottom-full z-20 mb-2 w-[24rem] max-w-[calc(100%-1.5rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
      <div className="max-h-64 overflow-y-auto p-1">
        {loading ? (
          <div className="space-y-1 p-1">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-5 text-xs text-muted-foreground">
            <SearchXIcon className="size-4" />
            No templates match — add one from Automation.
          </div>
        ) : (
          items.map((t, i) => (
            <button
              key={t.id}
              type="button"
              onMouseEnter={() => onHighlight(i)}
              onClick={() => onPick(i)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                i === highlighted && "bg-accent"
              )}
            >
              <Thumb t={t} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  {t.shortcut && (
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      /{t.shortcut}
                    </Badge>
                  )}
                  {t.mediaKey && (
                    <Badge
                      variant="secondary"
                      className="shrink-0 text-[10px] text-muted-foreground"
                    >
                      {t.mediaType ?? "file"}
                    </Badge>
                  )}
                </span>
                {t.body && (
                  <span className="truncate text-xs text-muted-foreground">
                    {t.body}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
