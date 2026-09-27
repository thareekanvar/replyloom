import { useMemo } from "react"
import { Input } from "@workspace/ui/components/input"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import {
  SearchIcon,
  ImageIcon,
  VideoIcon,
  FileAudioIcon,
  FileIcon,
  CheckIcon,
} from "lucide-react"
import { waApi } from "@/lib/wa-api"
import { cn } from "@workspace/ui/lib/utils"
import type { MediaAssetType } from "../hooks/use-media-assets"

export type AssetFilter = "all" | MediaAssetType

export const FILTERS: {
  value: AssetFilter
  label: string
  icon?: typeof ImageIcon
}[] = [
  { value: "all", label: "All" },
  { value: "image", label: "Images", icon: ImageIcon },
  { value: "video", label: "Videos", icon: VideoIcon },
  { value: "audio", label: "Audio", icon: FileAudioIcon },
  { value: "document", label: "Docs", icon: FileIcon },
]

export type MediaAssetRow = {
  id: string
  mediaKey: string
  mediaMime: string
  mediaType: MediaAssetType
  fileName: string | null
  fileSizeBytes: number | null
  createdAt: number
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return ""
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function assetLabel(a: { fileName: string | null; mediaKey: string }) {
  return a.fileName ?? a.mediaKey.split("/").pop() ?? "file"
}

export function assetIcon(type: MediaAssetType) {
  switch (type) {
    case "image":
      return <ImageIcon className="size-8 text-muted-foreground" />
    case "video":
      return <VideoIcon className="size-8 text-muted-foreground" />
    case "audio":
      return <FileAudioIcon className="size-8 text-muted-foreground" />
    default:
      return <FileIcon className="size-8 text-muted-foreground" />
  }
}

/**
 * The gallery grid: search + type filter + tappable asset tiles. Shared by
 * the template-library picker (MediaPickerDialog) and the composer's send
 * dialog (MediaSendDialog) so both galleries stay in sync visually.
 */
export function MediaAssetGrid({
  assets,
  isLoading,
  query,
  filter,
  selectedId,
  onQueryChange,
  onFilterChange,
  onSelect,
}: {
  assets: MediaAssetRow[]
  isLoading: boolean
  query: string
  filter: AssetFilter
  selectedId: string | null
  onQueryChange: (query: string) => void
  onFilterChange: (filter: AssetFilter) => void
  onSelect: (id: string) => void
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return assets.filter((a) => {
      if (filter !== "all" && a.mediaType !== filter) return false
      if (!q) return true
      return assetLabel(a).toLowerCase().includes(q)
    })
  }, [assets, query, filter])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="ps-8"
            placeholder="Search by file name…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
        </div>
        <div className="flex w-fit rounded-full border border-border bg-background p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-muted-foreground transition-colors",
                filter === f.value && "bg-primary text-primary-foreground"
              )}
            >
              {f.icon && <f.icon className="size-3.5" />}
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-80 min-h-44 overflow-y-auto">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ImageIcon />
              </EmptyMedia>
              {assets.length === 0 ? (
                <>
                  <EmptyTitle>Nothing uploaded yet</EmptyTitle>
                  <EmptyDescription>
                    Upload an image, video, audio, or document — it&apos;ll be
                    attached and saved to the gallery.
                  </EmptyDescription>
                </>
              ) : (
                <>
                  <EmptyTitle>Nothing matches</EmptyTitle>
                  <EmptyDescription>
                    Try a different search or filter.
                  </EmptyDescription>
                </>
              )}
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {filtered.map((a) => {
              const isSelected = a.id === selectedId
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onSelect(a.id)}
                  className={cn(
                    "group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card text-start transition-colors",
                    isSelected
                      ? "border-primary ring-2 ring-primary/30"
                      : "hover:border-foreground/20"
                  )}
                >
                  <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-muted">
                    {a.mediaType === "image" ? (
                      <img
                        src={waApi.mediaUrl(a.mediaKey)}
                        alt={assetLabel(a)}
                        className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
                      />
                    ) : (
                      assetIcon(a.mediaType)
                    )}
                    {isSelected && (
                      <span className="absolute end-2 top-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                        <CheckIcon className="size-3" />
                      </span>
                    )}
                    {!isSelected && a.mediaType !== "image" && (
                      <span className="absolute end-2 top-2 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white capitalize backdrop-blur-sm">
                        {a.mediaType}
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1 p-2.5">
                    <p
                      className={cn(
                        "truncate text-xs font-medium",
                        isSelected && "text-primary"
                      )}
                    >
                      {assetLabel(a)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {formatSize(a.fileSizeBytes)}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
