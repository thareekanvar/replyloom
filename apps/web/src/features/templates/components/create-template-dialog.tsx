import { useEffect, useRef, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import {
  PlusIcon,
  PaperclipIcon,
  XIcon,
  ImagesIcon,
  VideoIcon,
  FileAudioIcon,
  FileTextIcon,
  CheckCheckIcon,
  LoaderCircleIcon,
} from "lucide-react"
import { toast } from "sonner"
import { fileToBase64 } from "@/lib/file-utils"
import { serverUploadMedia } from "@/lib/wa-server"
import { waApi } from "@/lib/wa-api"
import { extractTemplateVariables } from "@workspace/db"
import { createMediaAsset } from "@/features/media/hooks/use-media-assets"
import { MediaPickerDialog } from "@/features/media/components/media-picker-dialog"
import { TemplateBody } from "./template-body"
import { cn } from "@workspace/ui/lib/utils"
import type { TemplateMediaType } from "../hooks/use-templates"
import type { TemplateRow } from "./template-list"

export interface CreateTemplateInput {
  name: string
  body?: string
  shortcut?: string
  mediaKey?: string
  mediaMime?: string
  mediaType?: TemplateMediaType
}

const BODY_MAX = 1024

const INSERTABLE_VARIABLES = [
  "name",
  "firstName",
  "phone",
  "lifecycleStage",
] as const

const EMPTY = {
  name: "",
  body: "",
  shortcut: "",
}

function normalizeShortcut(value: string) {
  return value.replace(/^\/+/, "").replace(/\s+/g, "").toLowerCase()
}

function MediaThumb({
  media,
  className,
}: {
  media: {
    mediaKey: string
    mediaMime: string
    mediaType: TemplateMediaType
    fileName: string
  }
  className?: string
}) {
  if (media.mediaType === "image") {
    return (
      <img
        src={waApi.mediaUrl(media.mediaKey)}
        alt={media.fileName}
        className={cn(
          "size-12 rounded-lg border border-border object-cover",
          className
        )}
      />
    )
  }
  const Icon =
    media.mediaType === "video"
      ? VideoIcon
      : media.mediaType === "audio"
        ? FileAudioIcon
        : FileTextIcon
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-muted",
        className
      )}
    >
      <Icon className="size-5 text-muted-foreground" />
    </div>
  )
}

export function CreateTemplateDialog({
  workspaceId,
  template,
  onCreate,
  onUpdate,
  onCancelEdit,
}: {
  workspaceId: string
  template?: TemplateRow | null
  onCreate: (data: CreateTemplateInput) => unknown
  onUpdate?: (templateId: string, data: CreateTemplateInput) => Promise<unknown>
  onCancelEdit?: () => void
}) {
  const editing = Boolean(template)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(() => ({ ...EMPTY }))
  const [media, setMedia] = useState<{
    mediaKey: string
    mediaMime: string
    mediaType: TemplateMediaType
    fileName: string
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const variables = extractTemplateVariables(form.body)
  const overLimit = form.body.length > BODY_MAX
  const canSubmit =
    Boolean(form.name.trim()) &&
    Boolean(form.body.trim() || media) &&
    !overLimit

  // When an existing template is being edited, seed the form from it.
  useEffect(() => {
    if (template) {
      setForm({
        name: template.name,
        body: template.body ?? "",
        shortcut: template.shortcut ?? "",
      })
      setMedia(
        template.mediaKey
          ? {
              mediaKey: template.mediaKey,
              mediaMime: template.mediaMime ?? "",
              mediaType: template.mediaType ?? "document",
              fileName: template.mediaKey.split("/").pop() ?? "file",
            }
          : null
      )
    } else {
      reset()
    }
  }, [template])

  function reset() {
    setForm({ ...EMPTY })
    setMedia(null)
  }

  function insertVariable(name: string) {
    const el = bodyRef.current
    const start = el?.selectionStart ?? form.body.length
    const end = el?.selectionEnd ?? form.body.length
    const token = `{{${name}}}`
    const next = form.body.slice(0, start) + token + form.body.slice(end)
    setForm((f) => ({ ...f, body: next }))
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        const pos = start + token.length
        el.setSelectionRange(pos, pos)
      }
    })
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setUploading(true)
    try {
      const res = await serverUploadMedia({
        data: {
          fileBase64: await fileToBase64(file),
          fileName: file.name,
          fileMime: file.type || "application/octet-stream",
        },
      })
      setMedia({
        mediaKey: res.mediaKey,
        mediaMime: res.mediaMime,
        mediaType: res.mediaType,
        fileName: file.name,
      })
      // Catalog it in the gallery too, so it's there to reuse next time
      // without re-uploading -- best-effort, doesn't block the template.
      createMediaAsset({
        data: {
          workspaceId,
          mediaKey: res.mediaKey,
          mediaMime: res.mediaMime,
          mediaType: res.mediaType,
          fileName: file.name,
          fileSizeBytes: file.size,
        },
      }).catch(() => {})
    } catch (err: any) {
      toast.error(err?.message ?? "Upload failed.")
    } finally {
      setUploading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    try {
      const payload: CreateTemplateInput = {
        name: form.name.trim(),
        body: form.body.trim() || undefined,
        shortcut: form.shortcut.trim() || undefined,
        mediaKey: media?.mediaKey,
        mediaMime: media?.mediaMime,
        mediaType: media?.mediaType,
      }
      if (editing && template && onUpdate) {
        await onUpdate(template.id, payload)
        onCancelEdit?.()
      } else {
        await onCreate(payload)
        reset()
        setOpen(false)
      }
    } catch {
      // Parent surfaces the error as a toast; keep the draft so nothing is lost.
    } finally {
      setSubmitting(false)
    }
  }

  const openState = editing ? Boolean(template) : open
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
          New Template
        </SheetTrigger>
      )}
      <SheetContent side="right" className="gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="px-6 pt-6">
          <SheetTitle>
            {editing ? "Edit template" : "Create template"}
          </SheetTitle>
          <SheetDescription>
            Sent as a normal message — variables like <code>{"{{name}}"}</code>{" "}
            are filled in per contact.
          </SheetDescription>
        </SheetHeader>

        <form
          id="create-template-form"
          onSubmit={handleSubmit}
          className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              placeholder="e.g. Order confirmation"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="tpl-shortcut">Shortcut</Label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-muted-foreground">
                /
              </span>
              <Input
                id="tpl-shortcut"
                className="ps-6"
                placeholder="pricing"
                value={form.shortcut}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    shortcut: normalizeShortcut(e.target.value),
                  }))
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {form.shortcut ? (
                <>
                  Type{" "}
                  <code className="rounded bg-muted px-1 py-0.5">
                    /{form.shortcut}
                  </code>{" "}
                  in the composer to quick-insert.
                </>
              ) : (
                "Optional — type /shortcut in the composer to quick-insert."
              )}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="tpl-body">Message</Label>
              <span
                className={cn(
                  "text-xs text-muted-foreground tabular-nums",
                  overLimit && "font-medium text-destructive"
                )}
              >
                {form.body.length}
                <span className="opacity-60">/{BODY_MAX}</span>
              </span>
            </div>
            <textarea
              id="tpl-body"
              ref={bodyRef}
              className={cn(
                "min-h-32 resize-none rounded-2xl border bg-input/50 px-3 py-2.5 text-sm shadow-xs transition-[border-color,box-shadow,background-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
                overLimit &&
                  "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20"
              )}
              placeholder="Hi {{firstName}}, your order shipped…"
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            />
            {variables.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  Variables in use:
                </span>
                {variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => insertVariable(v)}
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                  >
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Insert variable</Label>
            <div className="flex flex-wrap gap-1.5">
              {INSERTABLE_VARIABLES.map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => insertVariable(v)}
                >
                  {`{{${v}}}`}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Attachment</Label>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFilePicked}
            />
            {media ? (
              <div className="flex items-center gap-3 rounded-lg border border-border p-2 pr-3">
                <MediaThumb media={media} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {media.fileName}
                </span>
                <span className="text-xs text-muted-foreground capitalize">
                  {media.mediaType}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMedia(null)}
                  aria-label="Remove attachment"
                >
                  <XIcon />
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 justify-start text-muted-foreground"
                >
                  {uploading ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <PaperclipIcon />
                  )}
                  {uploading ? "Uploading…" : "Upload new"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setGalleryOpen(true)}
                  className="text-muted-foreground"
                >
                  <ImagesIcon />
                  Gallery
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label>Preview</Label>
            <div className="flex flex-col gap-2 rounded-2xl border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary uppercase">
                  A
                </span>
                <span className="font-medium text-foreground">Amelia</span>
                <span className="ml-auto flex items-center gap-0.5">
                  9:41
                  <CheckCheckIcon className="size-3.5 text-primary" />
                </span>
              </div>
              <div className="w-fit max-w-full overflow-hidden rounded-2xl rounded-tr-sm border border-border bg-background px-3.5 py-2.5 text-sm shadow-sm">
                {media?.mediaType === "image" && (
                  <img
                    src={waApi.mediaUrl(media.mediaKey)}
                    alt={media.fileName}
                    className="mb-1.5 max-h-44 rounded-lg object-cover"
                  />
                )}
                {media && media.mediaType !== "image" && (
                  <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {media.mediaType === "video" ? (
                      <VideoIcon className="size-4" />
                    ) : media.mediaType === "audio" ? (
                      <FileAudioIcon className="size-4" />
                    ) : (
                      <FileTextIcon className="size-4" />
                    )}
                    <span className="truncate">{media.fileName}</span>
                  </div>
                )}
                {form.body ? (
                  <TemplateBody body={form.body} />
                ) : (
                  <span className="text-muted-foreground">
                    {media
                      ? "Attachment with no caption."
                      : "Your message will appear here."}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Variables are highlighted above — each is filled with the
                contact&apos;s details when sent.
              </p>
            </div>
          </div>
        </form>

        <SheetFooter className="border-t bg-popover px-6 py-4">
          <Button
            form="create-template-form"
            type="submit"
            disabled={!canSubmit || uploading || submitting}
            className="w-full"
          >
            {submitting ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            {submitting
              ? "Saving…"
              : editing
                ? "Save changes"
                : "Create template"}
          </Button>
        </SheetFooter>
      </SheetContent>

      <MediaPickerDialog
        workspaceId={workspaceId}
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        onPick={(a) => {
          setMedia({
            mediaKey: a.mediaKey,
            mediaMime: a.mediaMime,
            mediaType: a.mediaType,
            fileName: a.fileName ?? a.mediaKey.split("/").pop() ?? "file",
          })
        }}
      />
    </Sheet>
  )
}
