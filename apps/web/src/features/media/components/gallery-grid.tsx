import { useEffect, useRef, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import {
  ImageIcon,
  VideoIcon,
  FileAudioIcon,
  FileIcon,
  TrashIcon,
  XIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"
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
import type { MediaAssetType } from "../hooks/use-media-assets"

export interface MediaAssetRow {
  id: string
  mediaKey: string
  mediaMime: string
  mediaType: MediaAssetType
  fileName: string | null
  fileSizeBytes: number | null
  createdAt: number
}

function formatSize(bytes: number | null): string {
  if (!bytes) return ""
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function GalleryGrid({
  assets,
  onDelete,
  /** Optional -- when set, each card becomes clickable and picks the asset instead of just previewing it. */
  onPick,
}: {
  assets: MediaAssetRow[]
  onDelete: (asset: MediaAssetRow) => void
  onPick?: (asset: MediaAssetRow) => void
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (previewIndex === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewIndex(null)
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        setPreviewIndex((i) => (i === null ? i : (i + assets.length - 1) % assets.length))
      }
      if (e.key === "ArrowRight") {
        e.preventDefault()
        setPreviewIndex((i) => (i === null ? i : (i + 1) % assets.length))
      }
    }
    document.addEventListener("keydown", onKey)
    closeRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [previewIndex, assets.length])

  if (assets.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ImageIcon />
          </EmptyMedia>
          <EmptyTitle>No media uploaded yet</EmptyTitle>
          <EmptyDescription>
            Upload images, videos, audio, or documents to reuse across templates
            and broadcasts.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {assets.map((a, index) => {
          const previewable =
            a.mediaType === "image" || a.mediaType === "video"
          const Card = (
            <div
              key={a.id}
              className={`group relative flex flex-col overflow-hidden rounded-lg border border-border ${previewable || onPick ? "cursor-pointer hover:border-primary" : ""}`}
              onClick={
                onPick
                  ? () => onPick(a)
                  : previewable
                    ? () => setPreviewIndex(index)
                    : undefined
              }
            >
              <div className="flex aspect-square items-center justify-center bg-muted">
                {a.mediaType === "image" ? (
                  <img
                    src={waApi.mediaUrl(a.mediaKey)}
                    alt={a.fileName ?? ""}
                    className="size-full object-cover"
                  />
                ) : a.mediaType === "video" ? (
                  <VideoIcon className="size-8 text-muted-foreground" />
                ) : a.mediaType === "audio" ? (
                  <FileAudioIcon className="size-8 text-muted-foreground" />
                ) : (
                  <FileIcon className="size-8 text-muted-foreground" />
                )}
              </div>
              <div className="flex items-center justify-between gap-1 p-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {a.fileName ?? a.mediaKey.split("/").pop()}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatSize(a.fileSizeBytes)}
                  </p>
                </div>
                {!onPick && (
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0"
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        />
                      }
                    >
                      <TrashIcon className="size-3.5" />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Removes it from the gallery. Templates already using it
                          keep working off the existing copy.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => onDelete(a)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          )
          return Card
        })}
      </div>
      {previewIndex !== null && assets[previewIndex] && (
        <Lightbox
          asset={assets[previewIndex]}
          hasNext={assets.length > 1}
          closeRef={closeRef}
          onClose={() => setPreviewIndex(null)}
          onPrev={() =>
            setPreviewIndex((previewIndex + assets.length - 1) % assets.length)
          }
          onNext={() => setPreviewIndex((previewIndex + 1) % assets.length)}
        />
      )}
    </>
  )
}

function Lightbox({
  asset,
  hasNext,
  closeRef,
  onClose,
  onPrev,
  onNext,
}: {
  asset: MediaAssetRow
  hasNext: boolean
  closeRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}) {
  const src = waApi.mediaUrl(asset.mediaKey)
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={asset.fileName ?? "Media preview"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close"
        className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        onClick={onClose}
      >
        <XIcon className="size-5" />
      </button>
      {hasNext && (
        <>
          <button
            type="button"
            aria-label="Previous"
            className="absolute left-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            onClick={(e) => {
              e.stopPropagation()
              onPrev()
            }}
          >
            <ChevronLeftIcon />
          </button>
          <button
            type="button"
            aria-label="Next"
            className="absolute right-16 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
            onClick={(e) => {
              e.stopPropagation()
              onNext()
            }}
          >
            <ChevronRightIcon />
          </button>
        </>
      )}
      {asset.mediaType === "image" ? (
        <img
          src={src}
          alt={asset.fileName ?? ""}
          className="max-h-full max-w-full rounded-lg object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      ) : asset.mediaType === "video" ? (
        <video
          controls
          autoPlay
          className="max-h-full max-w-full rounded-lg"
          src={src}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        asset.mediaType === "audio" ? (
          <audio controls src={src} className="w-full max-w-md" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-white">
            <FileIcon className="size-12 opacity-70" />
            <span className="text-sm">{asset.fileName}</span>
          </div>
        )
      )}
    </div>
  )
}
