import { useEffect, useRef, useState } from "react"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { LoadMoreButton } from "@/components/load-more-button"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@workspace/ui/components/sheet"
import { Button } from "@workspace/ui/components/button"
import { UploadIcon, LoaderCircleIcon, CheckIcon } from "lucide-react"
import { toast } from "sonner"
import { fileToBase64 } from "@/lib/file-utils"
import { serverUploadMedia } from "@/lib/wa-server"
import {
  getMediaAssetsPage,
  createMediaAsset,
} from "@/features/media/hooks/use-media-assets"
import type { MediaAssetType } from "../hooks/use-media-assets"
import { MediaAssetGrid, assetLabel } from "./media-asset-grid"
import type { MediaAssetRow, AssetFilter } from "./media-asset-grid"
import { shownOf, totalOf } from "@/lib/format-count"

export interface PickedMedia {
  mediaKey: string
  mediaMime: string
  mediaType: MediaAssetType
  fileName: string | null
  fileSizeBytes: number | null
}

export function MediaPickerDialog({
  workspaceId,
  open,
  onOpenChange,
  onPick,
}: {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (asset: PickedMedia) => void
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<AssetFilter>("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Cursor-paged; search + type filter run on the server.
  const assetQ = useDebouncedValue(query.trim())
  const assetsQuery = useInfiniteQuery({
    queryKey: ["media-assets", workspaceId, "picker", assetQ, filter],
    queryFn: ({ pageParam }) =>
      getMediaAssetsPage({
        data: { workspaceId: workspaceId, q: assetQ, type: filter, cursor: pageParam },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  })
  const assets = assetsQuery.data?.pages.flatMap((p) => p.items) ?? []
  const isLoading = assetsQuery.isLoading

  // Fresh slate every time the picker opens.
  useEffect(() => {
    if (!open) return
    setQuery("")
    setFilter("all")
    setSelectedId(null)
  }, [open])

  const selected = assets.find((a) => a.id === selectedId) ?? null

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
      await createMediaAsset({
        data: {
          workspaceId,
          mediaKey: res.mediaKey,
          mediaMime: res.mediaMime,
          mediaType: res.mediaType,
          fileName: file.name,
          fileSizeBytes: file.size,
        },
      })
      await queryClient.invalidateQueries({
        queryKey: ["media-assets", workspaceId],
      })
      const fresh = queryClient.getQueryData<MediaAssetRow[]>([
        "media-assets",
        workspaceId,
      ])
      const created = fresh?.find((a) => a.mediaKey === res.mediaKey)
      onPick({
        mediaKey: res.mediaKey,
        mediaMime: res.mediaMime,
        mediaType: res.mediaType,
        fileName: file.name,
        fileSizeBytes: file.size,
      })
      onOpenChange(false)
      if (created) setSelectedId(created.id)
      toast.success("Uploaded — attached to this template")
    } catch (err: any) {
      toast.error(err?.message ?? "Upload failed.")
    } finally {
      setUploading(false)
    }
  }

  function confirm() {
    if (!selected) return
    onPick({
      mediaKey: selected.mediaKey,
      mediaMime: selected.mediaMime,
      mediaType: selected.mediaType,
      fileName: selected.fileName,
      fileSizeBytes: selected.fileSizeBytes,
    })
    onOpenChange(false)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b p-5 pe-14 text-start">
          <SheetTitle>Pick from gallery</SheetTitle>
          <SheetDescription>
            Choose an image, video, audio clip, or document to attach.
          </SheetDescription>
        </SheetHeader>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFilePicked}
        />

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <MediaAssetGrid
            assets={assets}
            isLoading={isLoading}
            query={query}
            filter={filter}
            selectedId={selectedId}
            onQueryChange={setQuery}
            onFilterChange={setFilter}
            onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
          />
          <LoadMoreButton
            hasMore={!!assetsQuery.hasNextPage}
            shown={shownOf(assetsQuery.data)}
            total={totalOf(assetsQuery.data)}
            loading={assetsQuery.isFetchingNextPage}
            onLoadMore={() => assetsQuery.fetchNextPage()}
          />
        </div>

        <div className="flex flex-col-reverse gap-2 border-t p-5 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="w-full sm:w-auto"
          >
            {uploading ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <UploadIcon />
            )}
            {uploading ? "Uploading…" : "Upload new"}
          </Button>
          <Button
            onClick={confirm}
            disabled={!selected}
            className="w-full sm:w-auto"
          >
            <CheckIcon />
            {selected ? `Use ${assetLabel(selected)}` : "Select an asset"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
