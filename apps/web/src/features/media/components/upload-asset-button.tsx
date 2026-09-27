import { useRef, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { fileToBase64 } from "@/lib/file-utils"
import { serverUploadMedia } from "@/lib/wa-server"

export function UploadAssetButton({
  onUploaded,
}: {
  onUploaded: (asset: {
    mediaKey: string
    mediaMime: string
    mediaType: "image" | "video" | "audio" | "document"
    fileName: string
    fileSizeBytes: number
  }) => void
}) {
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
      onUploaded({
        mediaKey: res.mediaKey,
        mediaMime: res.mediaMime,
        mediaType: res.mediaType,
        fileName: file.name,
        fileSizeBytes: file.size,
      })
      toast.success("Uploaded")
    } catch (err: any) {
      toast.error(err?.message ?? "Upload failed.")
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFilePicked}
      />
      <Button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
      >
        <UploadIcon />
        {uploading ? "Uploading…" : "Upload"}
      </Button>
    </>
  )
}
