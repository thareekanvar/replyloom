import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  FileTextIcon,
  PaperclipIcon,
  TrashIcon,
  VideoIcon,
  FileAudioIcon,
  MessageCircleIcon,
  PencilIcon,
} from "lucide-react"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { waApi } from "@/lib/wa-api"
import { TemplateBody } from "./template-body"
import type { TemplateMediaType } from "../hooks/use-templates"

export interface TemplateRow {
  id: string
  name: string
  shortcut: string | null
  body: string | null
  mediaKey: string | null
  mediaMime: string | null
  mediaType: TemplateMediaType | null
  usageCount: number
}

function AttachmentIcon({ mediaType }: { mediaType: TemplateMediaType }) {
  return mediaType === "image" ? (
    <PaperclipIcon className="size-3.5" />
  ) : mediaType === "video" ? (
    <VideoIcon className="size-3.5" />
  ) : mediaType === "audio" ? (
    <FileAudioIcon className="size-3.5" />
  ) : (
    <FileTextIcon className="size-3.5" />
  )
}

export function TemplateList({
  templates,
  onDelete,
  onEdit,
}: {
  templates: TemplateRow[]
  onDelete: (id: string) => void
  onEdit: (template: TemplateRow) => void
}) {
  if (templates.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileTextIcon />
          </EmptyMedia>
          <EmptyTitle>No templates yet</EmptyTitle>
          <EmptyDescription>
            Create one to quick-insert in the composer or reuse across
            broadcasts.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-2 p-1">
      {templates.map((t) => (
        <div
          key={t.id}
          className="group flex items-start gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-foreground/15"
        >
          {t.mediaKey ? (
            t.mediaType === "image" ? (
              <img
                src={waApi.mediaUrl(t.mediaKey)}
                alt={t.name}
                className="mt-0.5 size-12 shrink-0 rounded-lg border border-border object-cover"
              />
            ) : (
              <div className="mt-0.5 flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                <AttachmentIcon mediaType={t.mediaType!} />
              </div>
            )
          ) : (
            <div className="mt-0.5 flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              <MessageCircleIcon className="size-5" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium">{t.name}</p>
              {t.shortcut && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  /{t.shortcut}
                </Badge>
              )}
            </div>
            <div className="mt-1 truncate text-sm text-muted-foreground">
              {t.body ? (
                <TemplateBody body={t.body} />
              ) : t.mediaKey ? (
                "Attachment only"
              ) : (
                "\u2014"
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Used {t.usageCount} {t.usageCount === 1 ? "time" : "times"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`Edit template "${t.name}"`}
              onClick={() => onEdit(t)}
            >
              <PencilIcon className="size-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  />
                }
              >
                <TrashIcon />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete template?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete "{t.name}". This can't be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onDelete(t.id)}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ))}
    </div>
  )
}
