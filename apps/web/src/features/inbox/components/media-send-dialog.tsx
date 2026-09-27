import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  FileIcon,
  FolderOpenIcon,
  Loader2Icon,
  MusicIcon,
  SendIcon,
  UploadIcon,
} from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"
import { waApi } from "@/lib/wa-api"
import { getMediaAssetsPage } from "@/features/media/hooks/use-media-assets"
import {
  MediaAssetGrid,
  assetLabel,
  formatSize,
} from "@/features/media/components/media-asset-grid"
import type { AssetFilter } from "@/features/media/components/media-asset-grid"
import { shownOf, totalOf } from "@/lib/format-count"

export type AttachmentType = "image" | "video" | "audio" | "document"

export function attachmentTypeFor(file: File): AttachmentType {
  if (file.type.startsWith("image/")) return "image"
  if (file.type.startsWith("video/")) return "video"
  if (file.type.startsWith("audio/")) return "audio"
  return "document"
}

/**
 * The composer's attach dialog -- a single "send media" step that accepts
 * either a brand-new file (any type the OS can pick: images, video, audio,
 * PDFs, spreadsheets, zips, …) or an asset already sitting in the gallery,
 * then previews it with an optional caption before sending. Replaces the
 * old file-input → caption popup with one dialog that treats both sources
 * as equals.
 */
export function MediaSendDialog({
  open,
  onOpenChange,
  workspaceId,
  onSendFile,
  onSendMediaKey,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  onSendFile: (
    file: File,
    type: AttachmentType,
    caption?: string
  ) => Promise<unknown>
  onSendMediaKey: (opts: {
    text?: string
    mediaKey: string
  }) => Promise<unknown>
}) {
  const [tab, setTab] = useState<"upload" | "gallery">("upload")
  const [file, setFile] = useState<File | null>(null)
  const [assetId, setAssetId] = useState<string | null>(null)
  const [caption, setCaption] = useState("")
  const [sending, setSending] = useState(false)
  const [galleryQuery, setGalleryQuery] = useState("")
  const [galleryFilter, setGalleryFilter] = useState<AssetFilter>("all")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const captionRef = useRef<HTMLTextAreaElement>(null)
  const hasGallery = !!workspaceId

  // Cursor-paged; search + type filter run on the server.
  const assetQ = useDebouncedValue(galleryQuery.trim())
  const assetsQuery = useInfiniteQuery({
    queryKey: ["media-assets", workspaceId, "picker", assetQ, galleryFilter],
    queryFn: ({ pageParam }) =>
      getMediaAssetsPage({
        data: { workspaceId: workspaceId!, q: assetQ, type: galleryFilter, cursor: pageParam },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open && hasGallery && tab === "gallery",
  })
  const assets = assetsQuery.data?.pages.flatMap((p) => p.items) ?? []
  const isLoading = assetsQuery.isLoading
  const selectedAsset = assets.find((a) => a.id === assetId) ?? null

  // Fresh slate every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setTab("upload")
    setFile(null)
    setAssetId(null)
    setCaption("")
    setSending(false)
    setGalleryQuery("")
    setGalleryFilter("all")
  }, [open])

  // Swapping tabs resets the other tab's pick, so there's never ambiguity
  // about which source is about to be sent.
  useEffect(() => {
    if (tab === "upload") setAssetId(null)
    else setFile(null)
  }, [tab])

  const previewUrl = useMemo(() => {
    if (tab === "upload") {
      if (!file) return null
      const type = attachmentTypeFor(file)
      return type === "image" || type === "video"
        ? URL.createObjectURL(file)
        : null
    }
    if (selectedAsset && selectedAsset.mediaType === "image")
      return waApi.mediaUrl(selectedAsset.mediaKey)
    if (selectedAsset && selectedAsset.mediaType === "video")
      return waApi.mediaUrl(selectedAsset.mediaKey)
    return null
  }, [tab, file, selectedAsset])

  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith("blob:"))
        URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  // Focus the caption once something to send is chosen, the way messenger
  // apps do.
  useEffect(() => {
    if (open && (file || selectedAsset) && !sending)
      setTimeout(() => captionRef.current?.focus(), 60)
  }, [open, file, selectedAsset, sending])

  const type =
    tab === "upload"
      ? file
        ? attachmentTypeFor(file)
        : null
      : (selectedAsset?.mediaType ?? null)
  const label =
    tab === "upload"
      ? file
        ? file.name
        : null
      : selectedAsset
        ? assetLabel(selectedAsset)
        : null
  const canSend = !!type && !!label && !sending

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (canSend) send()
    }
  }

  function send() {
    if (!canSend) return
    if (tab === "upload" && file) {
      proceed(() =>
        onSendFile(file, attachmentTypeFor(file), caption.trim() || undefined)
      )
    } else if (selectedAsset) {
      proceed(() =>
        onSendMediaKey({
          text: caption.trim() || undefined,
          mediaKey: selectedAsset.mediaKey,
        })
      )
    }
  }

  async function proceed(action: () => Promise<unknown>) {
    setSending(true)
    try {
      await action()
      onOpenChange(false)
    } finally {
      setSending(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!sending && !o) onOpenChange(false)
      }}
    >
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[88vh] flex-col gap-0 rounded-t-2xl p-0 sm:max-w-lg"
      >
        <SheetHeader className="border-b p-5 pb-4 text-start">
          <SheetTitle>Send media</SheetTitle>
          <SheetDescription>
            Upload a new file or pick one from your gallery — any type, PDFs
            included.
          </SheetDescription>
        </SheetHeader>

        <div className="overflow-y-auto">
        <div className="flex w-fit gap-1 rounded-xl bg-muted p-1 mx-5 mt-4">
          {[
            { key: "upload" as const, label: "Upload", icon: UploadIcon },
            ...(hasGallery
              ? [
                  {
                    key: "gallery" as const,
                    label: "Gallery",
                    icon: FolderOpenIcon,
                  },
                ]
              : []),
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
                tab === t.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <t.icon className="size-4" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-40 p-5">
          {tab === "upload" ? (
            file ? (
              <div className="flex flex-col items-center gap-3">
                <Preview
                  type={attachmentTypeFor(file)}
                  url={previewUrl}
                  name={file.name}
                  size={file.size}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={sending}
                >
                  <UploadIcon /> Choose a different file…
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files?.[0]
                    e.target.value = ""
                    if (picked) setFile(picked)
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-muted/30 px-4 py-10 text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                <UploadIcon className="size-8" />
                <span className="text-sm font-medium">
                  Click to upload a file
                </span>
                <span className="text-xs">
                  Images, video, audio, PDF, docs, spreadsheets, archives —
                  anything
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files?.[0]
                    e.target.value = ""
                    if (picked) setFile(picked)
                  }}
                />
              </button>
            )
          ) : (
            <>
            <MediaAssetGrid
              assets={assets}
              isLoading={isLoading}
              query={galleryQuery}
              filter={galleryFilter}
              selectedId={assetId}
              onQueryChange={setGalleryQuery}
              onFilterChange={setGalleryFilter}
              onSelect={(id) => setAssetId((cur) => (cur === id ? null : id))}
            />
            <LoadMoreButton
              hasMore={!!assetsQuery.hasNextPage}
              shown={shownOf(assetsQuery.data)}
              total={totalOf(assetsQuery.data)}
              loading={assetsQuery.isFetchingNextPage}
              onLoadMore={() => assetsQuery.fetchNextPage()}
            />
            </>
          )}

          {(file || selectedAsset) && (
            <Textarea
              ref={captionRef}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a caption… (Enter to send)"
              className="mt-4 max-h-24"
              disabled={sending}
            />
          )}
        </div>
        </div>

        <SheetFooter className="flex-row justify-end border-t p-5 pt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={send}
            disabled={!canSend}
            className="w-full sm:w-auto"
          >
            {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
            {sending ? "Sending…" : `Send ${type ? typeLabel(type) : "file"}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function typeLabel(type: AttachmentType): string {
  if (type === "image") return "photo"
  if (type === "video") return "video"
  if (type === "audio") return "audio"
  return "document"
}

function Preview({
  type,
  url,
  name,
  size,
}: {
  type: AttachmentType
  url: string | null
  name: string
  size: number | null
}) {
  if (type === "image" && url) {
    return (
      <div className="w-full overflow-hidden rounded-xl bg-gradient-to-b from-black/5 to-black/10 p-2">
        <img
          src={url}
          alt={name}
          className="mx-auto max-h-64 w-auto rounded-lg bg-white object-contain shadow-sm dark:bg-black"
        />
      </div>
    )
  }
  if (type === "video" && url) {
    return (
      <video
        src={url}
        controls
        className="max-h-64 w-full rounded-xl bg-black/5"
      />
    )
  }
  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-muted/40 p-3">
      {type === "audio" ? (
        <MusicIcon className="size-8 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon className="size-8 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        {size != null && (
          <p className="text-xs text-muted-foreground">{formatSize(size)}</p>
        )}
      </div>
    </div>
  )
}
