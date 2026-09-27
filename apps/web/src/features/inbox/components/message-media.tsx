import { useEffect, useRef, useState } from "react"
import { cn } from "@workspace/ui/lib/utils"
import {
  ImageIcon,
  VideoIcon,
  MicIcon,
  FileTextIcon,
  DownloadIcon,
  PlayIcon,
  PauseIcon,
  XIcon,
} from "lucide-react"
import { waApi } from "@/lib/wa-api"
import type { MediaMeta } from "@workspace/db"

export interface MessageMediaData {
  type: "image" | "video" | "audio" | "document" | "sticker"
  mediaKey: string | null
  mediaMime: string | null
  mediaMeta: MediaMeta | null
}

function formatBytes(bytes?: number): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "0:00"
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

/** Unavailable placeholder -- an older message from before media capture existed, or the download failed. */
function UnavailableMedia({ type }: { type: MessageMediaData["type"] }) {
  const Icon = {
    image: ImageIcon,
    video: VideoIcon,
    audio: MicIcon,
    document: FileTextIcon,
    sticker: ImageIcon,
  }[type]
  const label = {
    image: "Photo",
    video: "Video",
    audio: "Voice message",
    document: "Document",
    sticker: "Sticker",
  }[type]
  return (
    <div className="flex items-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-2.5 text-xs text-muted-foreground">
      <Icon className="size-4 shrink-0 opacity-60" />
      {label} unavailable
    </div>
  )
}

/** Compact play/scrub bar -- WhatsApp Web's voice-note bubble, minus the waveform. */
function VoiceNotePlayer({
  src,
  ptt,
  duration,
}: {
  src: string
  ptt: boolean
  duration?: number
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(duration ?? 0)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setProgress(audio.currentTime)
    const onLoaded = () => setTotal(audio.duration || duration || 0)
    const onEnd = () => {
      setPlaying(false)
      setProgress(0)
    }
    audio.addEventListener("timeupdate", onTime)
    audio.addEventListener("loadedmetadata", onLoaded)
    audio.addEventListener("ended", onEnd)
    return () => {
      audio.removeEventListener("timeupdate", onTime)
      audio.removeEventListener("loadedmetadata", onLoaded)
      audio.removeEventListener("ended", onEnd)
    }
  }, [duration])

  function toggle() {
    const audio = audioRef.current
    if (!audio) return
    if (playing) audio.pause()
    else audio.play()
    setPlaying(!playing)
  }

  return (
    <div className="flex min-w-56 items-center gap-2.5">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        onClick={toggle}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-current/10 hover:bg-current/20"
      >
        {playing ? (
          <PauseIcon className="size-4" />
        ) : (
          <PlayIcon className="size-4" />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={total || 1}
        step={0.1}
        value={progress}
        onChange={(e) => {
          const audio = audioRef.current
          const value = Number(e.target.value)
          if (audio) audio.currentTime = value
          setProgress(value)
        }}
        className="h-1 flex-1 cursor-pointer accent-current"
      />
      <span className="w-9 shrink-0 text-right text-[10px] tabular-nums opacity-70">
        {formatDuration(total ? total - progress : duration)}
      </span>
      {ptt && <MicIcon className="size-3.5 shrink-0 opacity-50" />}
    </div>
  )
}

export function MessageMedia({
  data,
  caption,
}: {
  data: MessageMediaData
  caption?: string | null
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const lightboxCloseRef = useRef<HTMLButtonElement>(null)

  // Lightbox keyboard + focus handling: Escape closes, and focus lands on
  // the close button so the background stays inert while it's open.
  useEffect(() => {
    if (!lightboxOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false)
    }
    document.addEventListener("keydown", onKey)
    lightboxCloseRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [lightboxOpen])

  if (!data.mediaKey) return <UnavailableMedia type={data.type} />

  const src = waApi.mediaUrl(data.mediaKey)

  if (data.type === "image") {
    return (
      <>
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          aria-label="View photo"
          className="block max-w-72 overflow-hidden rounded-lg"
        >
          <img
            src={src}
            alt={caption ?? "Photo"}
            className="max-h-80 w-full object-cover"
            loading="lazy"
          />
        </button>
        {lightboxOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={caption ?? "Photo"}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
            onClick={() => setLightboxOpen(false)}
          >
            <button
              ref={lightboxCloseRef}
              type="button"
              aria-label="Close"
              className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
              onClick={() => setLightboxOpen(false)}
            >
              <XIcon className="size-5" />
            </button>
            <img
              src={src}
              alt={caption ?? "Photo"}
              className="max-h-full max-w-full rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </>
    )
  }

  if (data.type === "sticker") {
    return (
      <img
        src={src}
        alt="Sticker"
        className="size-32 object-contain"
        loading="lazy"
      />
    )
  }

  if (data.type === "video") {
    return (
      <video
        controls
        preload="metadata"
        className="max-h-80 max-w-72 rounded-lg"
      >
        <source src={src} type={data.mediaMime ?? undefined} />
      </video>
    )
  }

  if (data.type === "audio") {
    return (
      <VoiceNotePlayer
        src={src}
        ptt={!!data.mediaMeta?.ptt}
        duration={data.mediaMeta?.durationSeconds}
      />
    )
  }

  // document
  const fileName = data.mediaMeta?.fileName ?? "Document"
  const size = formatBytes(data.mediaMeta?.fileSizeBytes)
  return (
    <a
      href={src}
      download={fileName}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex min-w-56 items-center gap-3 rounded-xl border border-current/15 bg-current/5 px-3 py-2.5 hover:bg-current/10"
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-current/10">
        <FileTextIcon className="size-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{fileName}</div>
        {size && <div className="text-[11px] opacity-60">{size}</div>}
      </div>
      <DownloadIcon className="size-4 shrink-0 opacity-60" />
    </a>
  )
}
