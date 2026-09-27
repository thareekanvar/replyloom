import { BarChart3Icon, MapPinIcon, UserRoundIcon } from "lucide-react"

/**
 * Poll / location / contact-card messages don't carry a file (no
 * mediaKey), just a short text summary the sync worker already extracted
 * into `body` (poll question, "lat, lng" or place name, contact names).
 * This renders that summary with a type-appropriate icon instead of
 * routing them through MessageMedia, which only knows actual file types.
 */
export function MessageRichContent({
  type,
  body,
}: {
  type: "poll" | "location" | "contact"
  body: string | null
}) {
  const meta = {
    poll: { icon: BarChart3Icon, label: "Poll", fallback: "Poll" },
    location: { icon: MapPinIcon, label: "Location", fallback: "Shared location" },
    contact: { icon: UserRoundIcon, label: "Contact", fallback: "Shared contact" },
  }[type]
  const Icon = meta.icon

  return (
    <div className="flex min-w-48 items-start gap-2.5 rounded-xl border border-current/15 bg-current/5 px-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-current/10">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium uppercase tracking-wide opacity-60">
          {meta.label}
        </div>
        <div className="truncate text-sm font-medium">
          {body || meta.fallback}
        </div>
      </div>
    </div>
  )
}
